import fs from 'node:fs';

import type { DesktopMirrorRecord, DesktopSessionSummary } from '../../desktop-sessions.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { getBridgeContext } from './context.js';
import {
  enqueuePendingMirrorDeliveries,
  flushTimedOutMirrorTurn as finalizeTimedOutMirrorTurn,
  removePendingMirrorDeliveries,
  selectPendingMirrorDeliveries,
  type FinalizedDesktopMirrorTurn,
} from './mirror-turns.js';
import type {
  DesktopMirrorSubscription,
  MirrorFileSnapshot,
} from './mirror-subscription-state.js';
import {
  clearMirrorSubscriptionFailure,
  createMirrorSubscription,
  recordMirrorSubscriptionFailure,
  updateMirrorSubscription,
} from './mirror-subscription-state.js';
import {
  isMirrorSnapshotUnchanged,
  markMirrorSnapshotMissing,
  readMirrorDeliverableRecords,
  refreshMirrorSubscriptionSource,
  statMirrorFile,
} from './mirror-reconcile-core.js';
import { buildMirrorDeliveryPlan } from './mirror-delivery-plan.js';
import { buildMirrorSubscriptionRegistryPlan } from './mirror-subscription-registry.js';
import { runMirrorReconcileBatch, type MirrorReconcileStatus } from './mirror-reconcile-batch.js';
import { buildMirrorStreamKey } from './mirror-formatters.js';
import type { DesktopRecordRouteResult } from './turns/desktop-terminal-router.js';
import { getExplicitDesktopThreadId } from './turns/turn-classifier.js';

const MIRROR_ORPHAN_PROCESS_PROBE_INTERVAL_MS = 60_000;

export interface BridgeMirrorRuntimeState {
  running: boolean;
  adapters: Map<string, BaseChannelAdapter>;
  mirrorSubscriptions: Map<string, DesktopMirrorSubscription>;
  mirrorWakeTimer: NodeJS.Timeout | null;
  mirrorSyncInFlight: boolean;
  activeTasks: Map<string, unknown>;
}

export interface CreateMirrorRuntimeOptions {
  watchDebounceMs: number;
  danglingThreadRetryLimit: number;
  failureSuspendThreshold: number;
  failureSuspendMs: number;
  streamOrphanTimeoutMs: number;
}

export interface CreateMirrorRuntimeDeps {
  nowIso(): string;
  describeUnknownError(error: unknown): string;
  getDesktopSessionByThreadIdSafe(threadId: string, context: string): DesktopSessionSummary | null;
  syncMirrorSessionStateSafe(sessionId: string, context: string): void;
  filterSuppressedMirrorRecords(sessionId: string, records: DesktopMirrorRecord[]): DesktopMirrorRecord[];
  observeSessionHealthRecords(sessionId: string, threadId: string, records: DesktopMirrorRecord[]): void;
  recordOrphanedMirrorTurn(sessionId: string, detail: string): void;
  isThreadProcessDefinitelyGone(threadId: string): Promise<boolean>;
  routeDesktopRecords?(
    sessionId: string,
    threadId: string,
    records: DesktopMirrorRecord[],
  ): Promise<DesktopRecordRouteResult>;
  consumeMirrorRecords(subscription: DesktopMirrorSubscription, records: DesktopMirrorRecord[]): FinalizedDesktopMirrorTurn[];
  flushTimedOutMirrorTurn(subscription: DesktopMirrorSubscription): FinalizedDesktopMirrorTurn | null;
  hasPendingMirrorWork(subscription: DesktopMirrorSubscription): boolean;
  consumeBufferedMirrorTurns(subscription: DesktopMirrorSubscription): FinalizedDesktopMirrorTurn[];
  stopMirrorStreaming(
    subscription: DesktopMirrorSubscription,
    status?: 'completed' | 'interrupted',
  ): void;
  deliverMirrorTurns(
    subscription: DesktopMirrorSubscription,
    turns: FinalizedDesktopMirrorTurn[],
  ): Promise<{ deliveredCount: number; error?: unknown }>;
}

export interface MirrorRuntime {
  resetMirrorSessionForInteractiveRun(sessionId: string): void;
  interruptMirrorTurn(sessionId: string, threadId: string, turnId: string): boolean;
  reconcileMirrorSubscriptions(): Promise<void>;
  clearMirrorSubscriptions(): void;
}

export function createMirrorRuntime(
  getState: () => BridgeMirrorRuntimeState,
  options: CreateMirrorRuntimeOptions,
  deps: CreateMirrorRuntimeDeps,
): MirrorRuntime {
  const orphanProbeAt = new Map<string, number>();

  function isAtOrBefore(timestamp: string | null | undefined, boundary: string): boolean {
    if (!timestamp) return true;
    const timestampMs = Date.parse(timestamp);
    const boundaryMs = Date.parse(boundary);
    if (Number.isFinite(timestampMs) && Number.isFinite(boundaryMs)) {
      return timestampMs <= boundaryMs;
    }
    return timestamp <= boundary;
  }

  function discardClaimedMirrorTurn(
    subscription: DesktopMirrorSubscription,
    routeResult: DesktopRecordRouteResult,
  ): void {
    if (!routeResult.terminalClaimed) return;

    const claimedTurnId = routeResult.claimedTurnId;
    if (claimedTurnId) {
      const claimedStreamKey = buildMirrorStreamKey(subscription.sessionId, claimedTurnId, '');
      subscription.bufferedRecords = subscription.bufferedRecords.filter(
        (record) => record.turnId !== claimedTurnId,
      );
      subscription.pendingDeliveries = subscription.pendingDeliveries.filter(
        (turn) => turn.streamKey !== claimedStreamKey,
      );
      if (subscription.pendingTurn?.turnId === claimedTurnId) {
        deps.stopMirrorStreaming(subscription, 'interrupted');
        subscription.pendingTurn = null;
      }
    }

    const claimedAt = routeResult.claimedAt;
    if (!claimedAt) return;
    const retainedAtOrBeforeClaim = [
      ...subscription.bufferedRecords.map((record) => record.timestamp),
      ...subscription.pendingDeliveries.map((turn) => turn.timestamp),
      ...routeResult.unclaimed.map((record) => record.timestamp),
      ...(subscription.pendingTurn ? [subscription.pendingTurn.lastActivityAt] : []),
    ].some((timestamp) => isAtOrBefore(timestamp, claimedAt));
    if (retainedAtOrBeforeClaim) return;

    if (!subscription.lastDeliveredAt || !isAtOrBefore(claimedAt, subscription.lastDeliveredAt)) {
      subscription.lastDeliveredAt = claimedAt;
    }
  }

  function closeMirrorWatcher(subscription: DesktopMirrorSubscription): void {
    if (subscription.watcher) {
      try {
        subscription.watcher.close();
      } catch {
        // best effort
      }
    }
    subscription.watcher = null;
    subscription.watcherTarget = null;
  }

  function scheduleMirrorWake(delayMs = options.watchDebounceMs): void {
    const state = getState();
    if (!state.running) return;
    if (state.mirrorWakeTimer) return;

    state.mirrorWakeTimer = setTimeout(() => {
      state.mirrorWakeTimer = null;
      void reconcileMirrorSubscriptions().catch((err) => {
        console.error('[bridge-manager] Mirror wake reconcile failed:', deps.describeUnknownError(err));
      });
    }, delayMs);
  }

  function watchMirrorFile(subscription: DesktopMirrorSubscription, filePath: string | null): void {
    if (!filePath) {
      closeMirrorWatcher(subscription);
      return;
    }
    if (subscription.watcherTarget === filePath && subscription.watcher) {
      return;
    }

    closeMirrorWatcher(subscription);
    try {
      subscription.watcher = fs.watch(filePath, () => {
        subscription.dirty = true;
        scheduleMirrorWake();
      });
      subscription.watcherTarget = filePath;
    } catch {
      subscription.watcher = null;
      subscription.watcherTarget = null;
    }
  }

  function removeMirrorSubscription(bindingId: string): void {
    const state = getState();
    const existing = state.mirrorSubscriptions.get(bindingId);
    if (!existing) return;
    deps.stopMirrorStreaming(existing);
    closeMirrorWatcher(existing);
    state.mirrorSubscriptions.delete(bindingId);
    orphanProbeAt.delete(bindingId);
    deps.syncMirrorSessionStateSafe(existing.sessionId, 'mirror subscription removal');
  }

  async function finalizeOrphanedMirrorStream(
    subscription: DesktopMirrorSubscription,
    snapshot: MirrorFileSnapshot,
    blocked: boolean,
    runtimeBusy: boolean,
    nowMs: number,
  ): Promise<FinalizedDesktopMirrorTurn | null> {
    const pendingTurn = subscription.pendingTurn;
    if (!pendingTurn?.streamStarted || blocked || runtimeBusy) return null;

    const timeoutMs = options.streamOrphanTimeoutMs;
    const lastActivityMs = Date.parse(pendingTurn.lastActivityAt);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(lastActivityMs)) {
      return null;
    }

    const sourceActivityMs = Math.max(lastActivityMs, snapshot.mtimeMs);
    if (nowMs - sourceActivityMs < timeoutMs) return null;

    const lastProbeAt = orphanProbeAt.get(subscription.bindingId);
    if (
      typeof lastProbeAt === 'number'
      && nowMs - lastProbeAt < MIRROR_ORPHAN_PROCESS_PROBE_INTERVAL_MS
    ) {
      return null;
    }
    orphanProbeAt.set(subscription.bindingId, nowMs);

    if (!await deps.isThreadProcessDefinitelyGone(subscription.threadId)) return null;

    const finalized = finalizeTimedOutMirrorTurn(subscription, timeoutMs, nowMs);
    if (!finalized) return null;

    orphanProbeAt.delete(subscription.bindingId);
    const detail = '桌面线程长时间没有新记录，且本机未找到对应进程；已结束孤立的流式同步。';
    deps.recordOrphanedMirrorTurn(subscription.sessionId, detail);
    console.warn(
      `[bridge-manager] Finalized orphaned mirror turn ${pendingTurn.turnId || pendingTurn.streamKey} for thread ${subscription.threadId}`,
    );
    return finalized;
  }

  function clearDanglingMirrorThread(subscription: DesktopMirrorSubscription, reason: string): void {
    const { store } = getBridgeContext();
    const session = store.getSession(subscription.sessionId);
    const currentThreadId = getExplicitDesktopThreadId(session) || subscription.threadId;
    console.warn(
      `[bridge-manager] Clearing dangling desktop thread ${currentThreadId} for session ${subscription.sessionId}: ${reason}`,
    );
    store.updateSdkSessionId(subscription.sessionId, '');
    store.updateSession(subscription.sessionId, {
      sdk_session_id: '',
      codex_thread_id: undefined,
      desktop_thread_id: undefined,
      thread_origin: undefined,
    });
    removeMirrorSubscription(subscription.bindingId);
  }

  function upsertMirrorSubscription(binding: { id: string; channelType: string; chatId: string; codepilotSessionId: string; sdkSessionId: string }): void {
    const { store } = getBridgeContext();
    const state = getState();
    const session = store.getSession(binding.codepilotSessionId);
    if (!session) {
      removeMirrorSubscription(binding.id);
      return;
    }

    const threadId = getExplicitDesktopThreadId(session) || '';
    if (!threadId) {
      removeMirrorSubscription(binding.id);
      return;
    }

    const desktopSession = deps.getDesktopSessionByThreadIdSafe(threadId, 'mirror subscription sync');
    const filePath = desktopSession?.filePath || null;
    const existing = state.mirrorSubscriptions.get(binding.id);

    if (!existing) {
      const created = createMirrorSubscription({
        bindingId: binding.id,
        sessionId: binding.codepilotSessionId,
        channelType: binding.channelType,
        chatId: binding.chatId,
        threadId,
        filePath,
        lastDeliveredAt: session.mirror_last_event_at || null,
      });
      watchMirrorFile(created, filePath);
      state.mirrorSubscriptions.set(binding.id, created);
      deps.syncMirrorSessionStateSafe(binding.codepilotSessionId, 'mirror subscription create');
      return;
    }

    const { previousSessionId, threadChanged, filePathChanged } = updateMirrorSubscription(existing, {
      sessionId: binding.codepilotSessionId,
      channelType: binding.channelType,
      chatId: binding.chatId,
      threadId,
      filePath,
      lastDeliveredAt: session.mirror_last_event_at || null,
    });
    if (threadChanged || filePathChanged) {
      deps.stopMirrorStreaming(existing);
      orphanProbeAt.delete(existing.bindingId);
    }
    watchMirrorFile(existing, filePath);
    if (previousSessionId !== binding.codepilotSessionId) {
      deps.syncMirrorSessionStateSafe(previousSessionId, 'mirror subscription rebind previous session');
    }
    deps.syncMirrorSessionStateSafe(binding.codepilotSessionId, 'mirror subscription upsert');
  }

  function syncMirrorSubscriptionSet(): void {
    const { store } = getBridgeContext();
    const state = getState();
    const plan = buildMirrorSubscriptionRegistryPlan(
      store.listChannelBindings(),
      state.adapters.keys(),
      state.mirrorSubscriptions.keys(),
      (sessionId) => store.getSession(sessionId),
    );

    for (const binding of plan.upsertBindings) {
      try {
        upsertMirrorSubscription(binding);
      } catch (error) {
        console.error(
          `[bridge-manager] Failed to sync mirror subscription for binding ${binding.id}:`,
          error,
        );
      }
    }

    for (const bindingId of plan.removeBindingIds) {
      removeMirrorSubscription(bindingId);
    }
  }

  async function reconcileMirrorSubscription(
    subscription: DesktopMirrorSubscription,
  ): Promise<MirrorReconcileStatus> {
    const { store } = getBridgeContext();
    const session = store.getSession(subscription.sessionId);
    if (!session) {
      removeMirrorSubscription(subscription.bindingId);
      return 'processed';
    }

    if (subscription.suspendedUntil && Date.now() < subscription.suspendedUntil) {
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror suspension');
      return 'suspended';
    }
    if (subscription.suspendedUntil) {
      subscription.suspendedUntil = null;
    }

    const desktopSession = deps.getDesktopSessionByThreadIdSafe(subscription.threadId, 'mirror reconcile');
    if (!desktopSession) {
      subscription.missingThreadPolls += 1;
      if (subscription.missingThreadPolls >= options.danglingThreadRetryLimit) {
        clearDanglingMirrorThread(subscription, 'desktop thread no longer exists locally');
        return 'processed';
      }
    } else {
      subscription.missingThreadPolls = 0;
    }
    refreshMirrorSubscriptionSource(subscription, desktopSession?.filePath || null, deps.nowIso());
    watchMirrorFile(subscription, subscription.filePath);

    if (!subscription.filePath) {
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile without file');
      return 'processed';
    }

    const snapshot = statMirrorFile(subscription.filePath);
    if (!snapshot) {
      markMirrorSnapshotMissing(subscription);
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile missing snapshot');
      return 'processed';
    }

    const unchanged = isMirrorSnapshotUnchanged(subscription, snapshot);
    if (unchanged && !deps.hasPendingMirrorWork(subscription)) {
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile unchanged snapshot');
      return 'processed';
    }

    const readResult = readMirrorDeliverableRecords(subscription, snapshot);
    if (readResult.hasMoreData) {
      scheduleMirrorWake();
    }
    const deliverableRecords = readResult.records;
    for (const kind of readResult.unknownKinds) {
      if (subscription.unknownMirrorKindsSeen.has(kind)) continue;
      subscription.unknownMirrorKindsSeen.add(kind);
      console.warn(
        `[bridge-manager] Unhandled desktop mirror event for thread ${subscription.threadId}: ${kind}`,
      );
    }
    const routeResult = deliverableRecords.length > 0 && deps.routeDesktopRecords
      ? await deps.routeDesktopRecords(subscription.sessionId, subscription.threadId, deliverableRecords)
      : {
          claimed: [],
          unclaimed: deliverableRecords,
          terminalClaimed: false,
          claimedTurnId: null,
          claimedAt: null,
        };
    discardClaimedMirrorTurn(subscription, routeResult);
    const mirrorRecords = routeResult.unclaimed;

    if (mirrorRecords.length > 0) {
      deps.observeSessionHealthRecords(subscription.sessionId, subscription.threadId, mirrorRecords);
    }
    const blocked = getState().activeTasks.has(subscription.sessionId);
    const deliveryPlan = buildMirrorDeliveryPlan(subscription, mirrorRecords, {
      blocked,
      filterSuppressedRecords: deps.filterSuppressedMirrorRecords,
      flushTimedOutTurn: (currentSubscription) => deps.flushTimedOutMirrorTurn(currentSubscription),
      consumeBufferedTurns: (currentSubscription) => deps.consumeBufferedMirrorTurns(currentSubscription),
    });

    const runtimeBusy = session.runtime_status === 'running' || session.runtime_status === 'queued';
    const orphanedTurn = await finalizeOrphanedMirrorStream(
      subscription,
      snapshot,
      blocked,
      runtimeBusy,
      Date.now(),
    );
    if (orphanedTurn) {
      deliveryPlan.finalizedTurns.push(orphanedTurn);
      deliveryPlan.syncReason = 'mirror reconcile delivered turns';
    } else if (!subscription.pendingTurn?.streamStarted) {
      orphanProbeAt.delete(subscription.bindingId);
    }

    if (deliveryPlan.finalizedTurns.length > 0) {
      enqueuePendingMirrorDeliveries(subscription, deliveryPlan.finalizedTurns);
    }

    const turnsToAttempt = selectPendingMirrorDeliveries(subscription, blocked);
    if (turnsToAttempt.length > 0) {
      const deliveryResult = await deps.deliverMirrorTurns(subscription, turnsToAttempt);
      if (deliveryResult.deliveredCount > 0) {
        removePendingMirrorDeliveries(subscription, turnsToAttempt.slice(0, deliveryResult.deliveredCount));
      }
      if (deliveryResult.error) {
        const error = deliveryResult.error;
        console.warn('[bridge-manager] Mirror delivery failed:', error instanceof Error ? error.message : error);
      }
    }

    deps.syncMirrorSessionStateSafe(subscription.sessionId, deliveryPlan.syncReason);
    return 'processed';
  }

  async function handleMirrorSubscriptionReconcileFailure(
    subscription: DesktopMirrorSubscription,
    error: unknown,
  ): Promise<void> {
    try {
      deps.stopMirrorStreaming(subscription, 'interrupted');
      const suspended = recordMirrorSubscriptionFailure(
        subscription,
        options.failureSuspendThreshold,
        options.failureSuspendMs,
      );
      if (suspended) {
        console.warn(
          `[bridge-manager] Mirror subscription for thread ${subscription.threadId} is suspended for ${Math.round(options.failureSuspendMs / 1000)}s after ${subscription.consecutiveFailures} consecutive failures`,
        );
      }
      console.error(
        `[bridge-manager] Mirror reconcile failed for thread ${subscription.threadId}:`,
        deps.describeUnknownError(error),
      );
      deps.syncMirrorSessionStateSafe(subscription.sessionId, 'mirror reconcile failure');
    } catch (recoveryError) {
      console.error(
        `[bridge-manager] Mirror reconcile recovery failed for thread ${subscription.threadId}:`,
        deps.describeUnknownError(recoveryError),
      );
      console.error(
        `[bridge-manager] Original mirror reconcile error for thread ${subscription.threadId}:`,
        deps.describeUnknownError(error),
      );
    }
  }

  async function reconcileMirrorSubscriptions(): Promise<void> {
    const state = getState();
    if (!state.running || state.mirrorSyncInFlight) return;
    state.mirrorSyncInFlight = true;

    try {
      await runMirrorReconcileBatch({
        syncSubscriptionSet: syncMirrorSubscriptionSet,
        getSubscriptions: () => Array.from(state.mirrorSubscriptions.values()),
        reconcileSubscription: reconcileMirrorSubscription,
        clearFailureState: clearMirrorSubscriptionFailure,
        handleFailure: handleMirrorSubscriptionReconcileFailure,
        logBatchError: (stage, error) => {
          console.error(
            `[bridge-manager] Mirror reconcile failed during ${stage}:`,
            deps.describeUnknownError(error),
          );
        },
      });
    } finally {
      state.mirrorSyncInFlight = false;
    }
  }

  function clearMirrorSubscriptions(): void {
    const state = getState();
    for (const bindingId of Array.from(state.mirrorSubscriptions.keys())) {
      removeMirrorSubscription(bindingId);
    }
  }

  function resetMirrorSessionForInteractiveRun(sessionId: string): void {
    const state = getState();
    for (const subscription of state.mirrorSubscriptions.values()) {
      if (subscription.sessionId !== sessionId) continue;
      deps.stopMirrorStreaming(subscription, 'interrupted');
      if (subscription.pendingTurn) {
        subscription.pendingTurn.streamStarted = false;
      }
    }
  }

  function interruptMirrorTurn(sessionId: string, threadId: string, turnId: string): boolean {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) return false;
    const streamKey = buildMirrorStreamKey(sessionId, normalizedTurnId, '');
    let interrupted = false;

    for (const subscription of getState().mirrorSubscriptions.values()) {
      if (subscription.sessionId !== sessionId || subscription.threadId !== threadId) continue;
      let subscriptionInterrupted = false;
      const bufferedCount = subscription.bufferedRecords.length;
      const deliveryCount = subscription.pendingDeliveries.length;
      subscription.bufferedRecords = subscription.bufferedRecords.filter(
        (record) => record.turnId !== normalizedTurnId,
      );
      subscription.pendingDeliveries = subscription.pendingDeliveries.filter(
        (turn) => turn.streamKey !== streamKey,
      );
      if (subscription.pendingTurn?.turnId === normalizedTurnId) {
        deps.stopMirrorStreaming(subscription, 'interrupted');
        subscription.pendingTurn = null;
        subscriptionInterrupted = true;
      }
      if (
        subscription.bufferedRecords.length !== bufferedCount
        || subscription.pendingDeliveries.length !== deliveryCount
      ) {
        subscriptionInterrupted = true;
      }
      if (subscriptionInterrupted) {
        interrupted = true;
        orphanProbeAt.delete(subscription.bindingId);
        deps.syncMirrorSessionStateSafe(sessionId, 'mirror turn interrupted from IM');
      }
    }
    return interrupted;
  }

  return {
    resetMirrorSessionForInteractiveRun,
    interruptMirrorTurn,
    reconcileMirrorSubscriptions,
    clearMirrorSubscriptions,
  };
}
