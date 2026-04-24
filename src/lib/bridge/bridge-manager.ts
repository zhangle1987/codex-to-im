/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type {
  BridgeStatus,
  InboundMessage,
} from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { BridgeSession, PermissionLinkRecord } from './host.js';
import { inspect } from 'node:util';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as broker from './permission-broker.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import {
  sanitizeInput,
} from './security/validators.js';
import {
  buildDesktopThreadsCommandResponse,
  formatCommandDateTime,
  formatMirrorStatus,
  formatRuntimeStatus,
  normalizeReasoningEffort,
  parseDesktopThreadListArgs,
  resolveCommandAlias,
  toUserVisibleBindingError,
  toUserVisibleCommandError,
} from './command-helpers.js';
import {
  appendMirrorTimeoutNotice,
  buildInteractiveStreamKey,
  buildMirrorStreamKey,
  buildMirrorTitle,
  formatMirrorMessage,
  formatMirrorUserText,
} from './mirror-formatters.js';
import {
  consumeBufferedMirrorTurns as consumeBufferedMirrorTurnsBase,
  consumeMirrorRecords as consumeMirrorRecordsBase,
  flushTimedOutMirrorTurn as flushTimedOutMirrorTurnBase,
  hasPendingMirrorWork as hasPendingMirrorWorkBase,
  type DesktopMirrorTurnState,
  type FinalizedDesktopMirrorTurn,
  type MirrorTurnHooks,
} from './mirror-turns.js';
import {
  abortMirrorSuppression as abortMirrorSuppressionBase,
  beginMirrorSuppression as beginMirrorSuppressionBase,
  filterSuppressedMirrorRecords as filterSuppressedMirrorRecordsBase,
  isMirrorSuppressed as isMirrorSuppressedBase,
  settleMirrorSuppression as settleMirrorSuppressionBase,
  type MirrorSuppressionConfig,
  type MirrorSuppressionState,
  type MirrorSuppressionStore,
} from './mirror-suppression.js';
import { type DesktopMirrorSubscription } from './mirror-subscription-state.js';
import {
  buildAdapterConfigFingerprint,
} from './adapter-sync-plan.js';
import {
  createAdapterRuntime,
  type BridgeAdapterRuntimeState,
} from './bridge-adapter-runtime.js';
import {
  formatBindingChatLabel,
  getChannelProviderKey,
  getFeedbackParseMode,
  renderFeedbackText,
} from './bridge-channel-runtime.js';
import {
  formatDisplayedModel,
  getDesktopSessionByThreadIdSafe,
  getDesktopThreadTitle,
  resolveDisplayedModel,
  resolveNewWorkingDirectory,
  resolveNewSessionWorkingDirectory,
} from './bridge-session-support.js';
import { handleBridgeCommand } from './command-dispatch.js';
import {
  formatInteractiveRuntimeStatus,
  runInteractiveMessage,
} from './interactive-message-runner.js';
import {
  createInteractiveRuntime,
  type BridgeInteractiveRuntimeState,
} from './interactive-runtime.js';
import { createMirrorRuntime } from './mirror-runtime.js';
import { probeCodexThreadProcess } from './session-health-process.js';
import { createSessionHealthRuntime } from './session-health-runtime.js';
import { deliverBridgeNotice, deliverResponse } from './feedback-delivery.js';
import {
  finalizeStreamFeedback,
  pushStreamFeedbackText,
  pushStreamFeedbackStatus,
  pushStreamFeedbackTasks,
  pushStreamFeedbackTools,
} from './stream-feedback-controller.js';

const GLOBAL_KEY = '__bridge_manager__';
const DANGLING_MIRROR_THREAD_RETRY_LIMIT = 3;
const MIRROR_FAILURE_SUSPEND_MS = 60_000;
const MIRROR_FAILURE_SUSPEND_THRESHOLD = 3;
const MIRROR_POLL_INTERVAL_MS = 2_500;
const MIRROR_WATCH_DEBOUNCE_MS = 350;
const MIRROR_EVENT_BATCH_LIMIT = 8;
const MIRROR_SUPPRESSION_WINDOW_MS = 4_000;
const MIRROR_PROMPT_MATCH_GRACE_MS = 120_000;
const INTERACTIVE_IDLE_REMINDER_MS = 600_000;
const MIRROR_STREAM_STATUS_IDLE_START_MS = 180_000;
const MIRROR_STREAM_STATUS_HEARTBEAT_MS = 10_000;
// Idle timeout after the last desktop event before we flush a buffered turn
// without seeing task_complete.
const MIRROR_IDLE_TIMEOUT_MS = 600_000;

// ── Streaming preview helpers ──────────────────────────────────

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  if (error === null) return 'null';
  if (typeof error === 'undefined') return 'undefined';
  if (typeof error === 'object') {
    const ctor = (error as { constructor?: { name?: string } })?.constructor?.name;
    const rendered = inspect(error, {
      depth: 4,
      breakLength: Infinity,
      compact: true,
    });
    return ctor && ctor !== 'Object' ? `${ctor} ${rendered}` : rendered;
  }
  return String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function getPendingPermissionLinksForCurrentSession(
  chatId: string,
  sessionId?: string,
): PermissionLinkRecord[] {
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  if (!sessionId) return pending;
  return pending.filter((link) => !link.sessionId || link.sessionId === sessionId);
}


/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * Feishu/Weixin channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

interface BridgeManagerState extends BridgeAdapterRuntimeState, BridgeInteractiveRuntimeState {
  startedAt: string | null;
  reconcileTimer: NodeJS.Timeout | null;
  mirrorPollTimer: NodeJS.Timeout | null;
  mirrorWakeTimer: NodeJS.Timeout | null;
  mirrorSubscriptions: Map<string, DesktopMirrorSubscription>;
  mirrorSyncInFlight: boolean;
  mirrorSuppressUntil: Map<string, MirrorSuppressionState[]>;
  mirrorIgnoredTurnIds: Map<string, Map<string, number>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      reconcileTimer: null,
      mirrorPollTimer: null,
      mirrorWakeTimer: null,
      activeTasks: new Map(),
      mirrorSubscriptions: new Map(),
      mirrorSyncInFlight: false,
      mirrorSuppressUntil: new Map(),
      mirrorIgnoredTurnIds: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  if (!g[GLOBAL_KEY].mirrorSubscriptions) {
    g[GLOBAL_KEY].mirrorSubscriptions = new Map();
  }
  if (!g[GLOBAL_KEY].invalidAdapters) {
    g[GLOBAL_KEY].invalidAdapters = new Map();
  }
  if (!g[GLOBAL_KEY].queuedCounts) {
    g[GLOBAL_KEY].queuedCounts = new Map();
  }
  if (!g[GLOBAL_KEY].mirrorSuppressUntil) {
    g[GLOBAL_KEY].mirrorSuppressUntil = new Map();
  }
  if (!g[GLOBAL_KEY].mirrorIgnoredTurnIds) {
    g[GLOBAL_KEY].mirrorIgnoredTurnIds = new Map();
  }
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'mirrorSyncInFlight')) {
    g[GLOBAL_KEY].mirrorSyncInFlight = false;
  }
  return g[GLOBAL_KEY];
}

const INTERACTIVE_RUNTIME = createInteractiveRuntime(getState, {
  idleReminderMs: INTERACTIVE_IDLE_REMINDER_MS,
}, {
  getStore: () => getBridgeContext().store,
  nowIso,
});

const SESSION_HEALTH_RUNTIME = createSessionHealthRuntime({
  getStore: () => getBridgeContext().store,
  nowIso,
  probeThreadProcess: (threadId) => probeCodexThreadProcess(threadId),
});

const MIRROR_SUPPRESSION_CONFIG: MirrorSuppressionConfig = {
  suppressionWindowMs: MIRROR_SUPPRESSION_WINDOW_MS,
  promptMatchGraceMs: MIRROR_PROMPT_MATCH_GRACE_MS,
};

function getMirrorSuppressionStore(): MirrorSuppressionStore {
  const state = getState();
  return {
    suppressions: state.mirrorSuppressUntil,
    ignoredTurnIds: state.mirrorIgnoredTurnIds,
  };
}

function beginMirrorSuppression(sessionId: string, promptText: string): string {
  return beginMirrorSuppressionBase(getMirrorSuppressionStore(), sessionId, promptText);
}

function abortMirrorSuppression(
  sessionId: string,
  suppressionId?: string | null,
): void {
  abortMirrorSuppressionBase(
    getMirrorSuppressionStore(),
    sessionId,
    MIRROR_SUPPRESSION_CONFIG,
    suppressionId,
  );
}

function settleMirrorSuppression(
  sessionId: string,
  suppressionId?: string | null,
  durationMs = MIRROR_SUPPRESSION_WINDOW_MS,
): void {
  settleMirrorSuppressionBase(
    getMirrorSuppressionStore(),
    sessionId,
    MIRROR_SUPPRESSION_CONFIG,
    suppressionId,
    durationMs,
  );
}

function isMirrorSuppressed(sessionId: string): boolean {
  return isMirrorSuppressedBase(getMirrorSuppressionStore(), sessionId);
}

function filterSuppressedMirrorRecords(
  sessionId: string,
  records: DesktopMirrorRecord[],
): DesktopMirrorRecord[] {
  return filterSuppressedMirrorRecordsBase(
    getMirrorSuppressionStore(),
    sessionId,
    records,
    MIRROR_SUPPRESSION_CONFIG,
  );
}

function syncMirrorSessionState(sessionId: string): void {
  const { store } = getBridgeContext();
  const session = store.getSession(sessionId);
  if (!session) return;

  const subscriptions = Array.from(getState().mirrorSubscriptions.values())
    .filter((item) => item.sessionId === sessionId);
  const mirrorStatus: BridgeSession['mirror_status'] = subscriptions.length === 0
    ? 'inactive'
    : subscriptions.some((item) => item.status === 'watching')
      ? 'watching'
      : subscriptions.some((item) => item.status === 'stale')
        ? 'stale'
        : 'inactive';

  const deliveredAt = subscriptions
    .map((item) => item.lastDeliveredAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || session.mirror_last_event_at;

  if (
    session.mirror_status === mirrorStatus
    && session.mirror_last_event_at === deliveredAt
  ) {
    return;
  }

  store.updateSession(sessionId, {
    mirror_status: mirrorStatus,
    mirror_last_event_at: deliveredAt,
  });
}

function syncMirrorSessionStateSafe(sessionId: string, context: string): void {
  try {
    syncMirrorSessionState(sessionId);
  } catch (error) {
    console.error(
      `[bridge-manager] Failed to sync mirror session state for ${sessionId} during ${context}:`,
      describeUnknownError(error),
    );
  }
}

function getMirrorStreamingAdapter(subscription: DesktopMirrorSubscription): BaseChannelAdapter | null {
  const state = getState();
  const adapter = state.adapters.get(subscription.channelType);
  if (!adapter || !adapter.isRunning()) return null;
  if (getChannelProviderKey(subscription.channelType) !== 'feishu') return null;
  if (typeof adapter.onStreamText !== 'function' || typeof adapter.onStreamEnd !== 'function') {
    return null;
  }
  return adapter;
}

function getMirrorStreamingText(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): string {
  const title = getDesktopThreadTitle(subscription.threadId)?.trim() || '桌面线程';
  const markdown = getFeedbackParseMode(subscription.channelType) === 'Markdown';
  const rendered = formatMirrorMessage(
    title,
    turnState.userText,
    turnState.streamedText,
    markdown,
    true,
  );
  return rendered || buildMirrorTitle(title, markdown);
}

function getMirrorStructuredStreamStatusConfig(): {
  idleStartMs: number;
  heartbeatMs: number;
} {
  const { store } = getBridgeContext();
  const idleStartSeconds = parseInt(store.getSetting('bridge_stream_status_idle_start_seconds') || '', 10);
  const heartbeatSeconds = parseInt(store.getSetting('bridge_stream_status_check_interval_seconds') || '', 10);
  return {
    idleStartMs: Math.max(
      0,
      (Number.isFinite(idleStartSeconds) && idleStartSeconds > 0 ? idleStartSeconds : MIRROR_STREAM_STATUS_IDLE_START_MS / 1000) * 1000,
    ),
    heartbeatMs: Math.max(
      1_000,
      (Number.isFinite(heartbeatSeconds) && heartbeatSeconds > 0 ? heartbeatSeconds : MIRROR_STREAM_STATUS_HEARTBEAT_MS / 1000) * 1000,
    ),
  };
}

function startMirrorStreaming(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter || turnState.streamStarted) return;

  try {
    adapter.onMirrorStreamStart?.(subscription.chatId, turnState.streamKey);
    if (!adapter.onMirrorStreamStart) {
      adapter.onStreamText?.(subscription.chatId, '', turnState.streamKey);
    }
    turnState.streamStarted = true;
  } catch {
    // Non-critical best effort only.
  }
}

function createMirrorStreamFeedbackTarget(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
  adapter: BaseChannelAdapter,
): {
  adapter: BaseChannelAdapter;
  channelType: string;
  chatId: string;
  streamKey: string;
  ensureStarted(): void;
} {
  return {
    adapter,
    channelType: subscription.channelType,
    chatId: subscription.chatId,
    streamKey: turnState.streamKey,
    ensureStarted: () => {
      startMirrorStreaming(subscription, turnState);
    },
  };
}

function pushMirrorStreamingStatus(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
  options: {
    nowMs?: number;
    lastResponseAgeMs?: number | null;
    minIntervalMs?: number;
  } = {},
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter || typeof adapter.onStreamStatus !== 'function') return;
  if (!(adapter.supportsStructuredStreamingUi?.(subscription.chatId) ?? true)) return;

  const startedAtMs = Date.parse(turnState.startedAt);
  if (!Number.isFinite(startedAtMs)) return;

  const nowMs = options.nowMs ?? Date.now();
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
  if (minIntervalMs > 0 && turnState.lastStatusAt > 0 && nowMs - turnState.lastStatusAt < minIntervalMs) {
    return;
  }

  const statusText = formatInteractiveRuntimeStatus(
    Math.max(0, nowMs - startedAtMs),
    options.lastResponseAgeMs,
    turnState.statusNote,
  );
  if (turnState.lastStatusText === statusText) return;

  pushStreamFeedbackStatus(
    createMirrorStreamFeedbackTarget(subscription, turnState, adapter),
    statusText,
  );
  turnState.lastStatusText = statusText;
  turnState.lastStatusAt = nowMs;
}

function refreshMirrorStreamingStatus(
  subscription: DesktopMirrorSubscription,
  nowMs = Date.now(),
  config = getMirrorStructuredStreamStatusConfig(),
): void {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn?.streamStarted) return;

  const startedAtMs = Date.parse(pendingTurn.startedAt);
  if (!Number.isFinite(startedAtMs)) return;

  const elapsedMs = nowMs - startedAtMs;
  if (elapsedMs < config.idleStartMs) return;

  const lastResponseAtMs = pendingTurn.lastResponseAt
    ? Date.parse(pendingTurn.lastResponseAt)
    : NaN;
  const lastResponseAgeMs = Number.isFinite(lastResponseAtMs)
    ? nowMs - lastResponseAtMs
    : null;
  if (lastResponseAgeMs != null && lastResponseAgeMs < config.heartbeatMs) return;

  pushMirrorStreamingStatus(subscription, pendingTurn, {
    nowMs,
    lastResponseAgeMs,
    minIntervalMs: config.heartbeatMs,
  });
}

function refreshActiveMirrorStreamingStatuses(nowMs = Date.now()): void {
  for (const subscription of getState().mirrorSubscriptions.values()) {
    refreshMirrorStreamingStatus(subscription, nowMs);
  }
}

function updateMirrorStreaming(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter) return;
  pushStreamFeedbackText(
    createMirrorStreamFeedbackTarget(subscription, turnState, adapter),
    getMirrorStreamingText(subscription, turnState),
  );
  pushMirrorStreamingStatus(subscription, turnState);
}

function updateMirrorToolProgress(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter) return;
  pushStreamFeedbackTools(
    createMirrorStreamFeedbackTarget(subscription, turnState, adapter),
    Array.from(turnState.toolCalls.values()),
  );
  pushMirrorStreamingStatus(subscription, turnState);
}

function updateMirrorTaskProgress(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter) return;
  pushStreamFeedbackTasks(
    createMirrorStreamFeedbackTarget(subscription, turnState, adapter),
    turnState.taskItems,
  );
  pushMirrorStreamingStatus(subscription, turnState);
}

function updateMirrorStatusProgress(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter) return;
  pushMirrorStreamingStatus(subscription, turnState);
}

function stopMirrorStreaming(
  subscription: DesktopMirrorSubscription,
  status: 'completed' | 'interrupted' = 'interrupted',
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  const pendingTurn = subscription.pendingTurn;
  if (!adapter || !pendingTurn?.streamStarted) return;
  void finalizeStreamFeedback(
    createMirrorStreamFeedbackTarget(subscription, pendingTurn, adapter),
    status,
    getMirrorStreamingText(subscription, pendingTurn),
  );
}

async function deliverMirrorTurn(
  subscription: DesktopMirrorSubscription,
  turn: FinalizedDesktopMirrorTurn,
): Promise<void> {
  const state = getState();
  const adapter = state.adapters.get(subscription.channelType);
  if (!adapter || !adapter.isRunning()) return;

  const title = getDesktopThreadTitle(subscription.threadId)?.trim() || '桌面线程';
  const responseParseMode = getFeedbackParseMode(subscription.channelType);
  const markdown = responseParseMode === 'Markdown';
  const renderedTextBase = formatMirrorMessage(title, turn.userText, turn.text, markdown);
  const renderedStreamTextBase = formatMirrorMessage(title, turn.userText, turn.text, markdown, true);
  const renderedText = turn.timedOut
    ? appendMirrorTimeoutNotice(renderedTextBase || buildMirrorTitle(title, markdown), markdown)
    : renderedTextBase;
  const renderedStreamText = turn.timedOut
    ? appendMirrorTimeoutNotice(renderedStreamTextBase || buildMirrorTitle(title, markdown), markdown)
    : renderedStreamTextBase;
  const text = renderedText ? renderFeedbackText(renderedText, responseParseMode) : '';
  const streamText = renderFeedbackText(
    renderedStreamText || buildMirrorTitle(title, markdown),
    responseParseMode,
  );

  if (getChannelProviderKey(subscription.channelType) === 'feishu' && typeof adapter.onStreamEnd === 'function') {
    try {
      const finalized = await adapter.onStreamEnd(
        subscription.chatId,
        turn.status,
        streamText,
        turn.streamKey,
      );
      if (finalized) {
        subscription.lastDeliveredAt = turn.timestamp || nowIso();
        return;
      }
    } catch (error) {
      console.warn('[bridge-manager] Mirror stream finalize failed:', error instanceof Error ? error.message : error);
    }
  }

  if (!text) return;

  const response = await deliver(adapter, {
    address: {
      channelType: subscription.channelType,
      chatId: subscription.chatId,
    },
    text,
    parseMode: responseParseMode,
  }, {
    sessionId: subscription.sessionId,
    dedupKey: `mirror:${subscription.bindingId}:${turn.signature}`,
  });

  if (!response.ok) {
    throw new Error(response.error || 'mirror delivery failed');
  }

  subscription.lastDeliveredAt = turn.timestamp || nowIso();
}

async function deliverMirrorTurns(
  subscription: DesktopMirrorSubscription,
  turns: FinalizedDesktopMirrorTurn[],
): Promise<{ deliveredCount: number; error?: unknown }> {
  let deliveredCount = 0;
  for (const turn of turns.slice(0, MIRROR_EVENT_BATCH_LIMIT)) {
    try {
      await deliverMirrorTurn(subscription, turn);
      deliveredCount += 1;
    } catch (error) {
      return { deliveredCount, error };
    }
  }
  return { deliveredCount };
}

const MIRROR_TURN_HOOKS: MirrorTurnHooks<DesktopMirrorSubscription> = {
  onStreamText: updateMirrorStreaming,
  onStatusProgress: updateMirrorStatusProgress,
  onTaskProgress: updateMirrorTaskProgress,
  onToolProgress: updateMirrorToolProgress,
};

function consumeMirrorRecords(
  subscription: DesktopMirrorSubscription,
  records: DesktopMirrorRecord[],
): FinalizedDesktopMirrorTurn[] {
  return consumeMirrorRecordsBase(subscription, records, MIRROR_TURN_HOOKS);
}

function flushTimedOutMirrorTurn(
  subscription: DesktopMirrorSubscription,
  nowMs = Date.now(),
): FinalizedDesktopMirrorTurn | null {
  return flushTimedOutMirrorTurnBase(subscription, MIRROR_IDLE_TIMEOUT_MS, nowMs);
}

function hasPendingMirrorWork(subscription: DesktopMirrorSubscription): boolean {
  return hasPendingMirrorWorkBase(subscription);
}

function consumeBufferedMirrorTurns(
  subscription: DesktopMirrorSubscription,
  nowMs = Date.now(),
): FinalizedDesktopMirrorTurn[] {
  return consumeBufferedMirrorTurnsBase(subscription, MIRROR_IDLE_TIMEOUT_MS, nowMs, MIRROR_TURN_HOOKS);
}

const MIRROR_RUNTIME = createMirrorRuntime(getState, {
  watchDebounceMs: MIRROR_WATCH_DEBOUNCE_MS,
  danglingThreadRetryLimit: DANGLING_MIRROR_THREAD_RETRY_LIMIT,
  failureSuspendThreshold: MIRROR_FAILURE_SUSPEND_THRESHOLD,
  failureSuspendMs: MIRROR_FAILURE_SUSPEND_MS,
}, {
  nowIso,
  describeUnknownError,
  getDesktopSessionByThreadIdSafe,
  syncMirrorSessionStateSafe,
  isMirrorSuppressed,
  filterSuppressedMirrorRecords,
  observeSessionHealthRecords: (sessionId, threadId, records) => {
    SESSION_HEALTH_RUNTIME.observeDesktopMirrorRecords(sessionId, threadId, records);
  },
  consumeMirrorRecords,
  flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription),
  hasPendingMirrorWork,
  consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription),
  stopMirrorStreaming,
  deliverMirrorTurns,
});

function resetMirrorSessionForInteractiveRun(sessionId: string): void {
  MIRROR_RUNTIME.resetMirrorSessionForInteractiveRun(sessionId);
}

async function reconcileMirrorSubscriptions(): Promise<void> {
  await MIRROR_RUNTIME.reconcileMirrorSubscriptions();
  refreshActiveMirrorStreamingStatuses();
}

function clearMirrorSubscriptions(): void {
  MIRROR_RUNTIME.clearMirrorSubscriptions();
}

const ADAPTER_RUNTIME = createAdapterRuntime(getState, {
  notifyAdapterSetChanged: (channelTypes) => {
    const { lifecycle } = getBridgeContext();
    lifecycle.onBridgeAdaptersChanged?.(channelTypes);
  },
  handleMessage,
  processWithSessionLock: (sessionId, fn) => INTERACTIVE_RUNTIME.processWithSessionLock(sessionId, fn),
  isNumericPermissionShortcut,
  resolveSessionIdForMessage: (msg) => router.resolve(msg.address).codepilotSessionId,
});

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  INTERACTIVE_RUNTIME.resetPersistedInteractiveRuntimeState();
  await ADAPTER_RUNTIME.syncConfiguredAdapters({ startLoops: false });
  const startedCount = state.adapters.size;

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      ADAPTER_RUNTIME.runAdapterLoop(adapter);
    }
  }

  state.reconcileTimer = setInterval(() => {
    void ADAPTER_RUNTIME.syncConfiguredAdapters({ startLoops: true }).catch((err) => {
      console.error('[bridge-manager] Adapter reconcile failed:', err);
    });
    void INTERACTIVE_RUNTIME.reconcileIdleInteractiveTasks().catch((err) => {
      console.error('[bridge-manager] Interactive idle reminder reconcile failed:', err);
    });
    try {
      SESSION_HEALTH_RUNTIME.reconcileSessionHealth();
      INTERACTIVE_RUNTIME.reconcileTerminalSessionRuntimeState();
    } catch (err) {
      console.error('[bridge-manager] Session health reconcile failed:', describeUnknownError(err));
    }
  }, 5_000);

  state.mirrorPollTimer = setInterval(() => {
    void reconcileMirrorSubscriptions().catch((err) => {
      console.error('[bridge-manager] Mirror reconcile failed:', describeUnknownError(err));
    });
  }, MIRROR_POLL_INTERVAL_MS);
  void reconcileMirrorSubscriptions().catch((err) => {
    console.error('[bridge-manager] Initial mirror reconcile failed:', describeUnknownError(err));
  });

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  if (state.reconcileTimer) {
    clearInterval(state.reconcileTimer);
    state.reconcileTimer = null;
  }
  if (state.mirrorPollTimer) {
    clearInterval(state.mirrorPollTimer);
    state.mirrorPollTimer = null;
  }
  if (state.mirrorWakeTimer) {
    clearTimeout(state.mirrorWakeTimer);
    state.mirrorWakeTimer = null;
  }

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  const activeSessionIds = Array.from(state.activeTasks.keys());
  for (const task of state.activeTasks.values()) {
    task.abortController.abort();
  }
  state.activeTasks.clear();
  state.mirrorSuppressUntil.clear();
  state.mirrorIgnoredTurnIds.clear();
  state.queuedCounts.clear();
  state.invalidAdapters.clear();
  ADAPTER_RUNTIME.clearWarningCache();
  for (const sessionId of activeSessionIds) {
    INTERACTIVE_RUNTIME.syncSessionRuntimeState(sessionId);
  }
  clearMirrorSubscriptions();

  // Stop all adapters
  for (const type of Array.from(state.adapters.keys())) {
    await ADAPTER_RUNTIME.stopAdapterInstance(type);
  }

  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        channelProvider: adapter.provider,
        channelAlias: adapter.alias,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
  state.adapterMeta.set(adapter.channelType, {
    lastMessageAt: null,
    lastError: null,
    configFingerprint: '',
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null, configFingerprint: '' };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      await deliverBridgeNotice(adapter, msg.address, 'Permission response recorded.');
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliverBridgeNotice(adapter, msg.address, rawData.userVisibleError, {
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliverBridgeNotice(adapter, msg.address, `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`, {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
          adapter.provider === 'feishu'
          || adapter.provider === 'weixin'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const currentBinding = store.getChannelBinding(msg.address.channelType, msg.address.chatId);
      const pendingLinks = getPendingPermissionLinksForCurrentSession(
        msg.address.chatId,
        currentBinding?.codepilotSessionId,
      );
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliverBridgeNotice(adapter, msg.address, `${label}: recorded.`, {
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliverBridgeNotice(adapter, msg.address, 'Permission not found or already resolved.', {
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliverBridgeNotice(adapter, msg.address, `当前有 ${pendingLinks.length} 条待处理权限，数字快捷回复会有歧义。请使用完整命令：\n/perm allow|allow_session|deny <id>`, {
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    const parts = rawText.split(/\s+/);
    const rawCommand = parts[0].split('@')[0].toLowerCase();
    const args = parts.slice(1).join(' ').trim();
    const resolvedCommand = resolveCommandAlias(rawCommand, args);
    try {
      await handleCommand(adapter, msg, rawText);
    } catch (error) {
      console.error(`[bridge-manager] Command failed: ${resolvedCommand}`, error);
      await deliverBridgeNotice(adapter, msg.address, toUserVisibleCommandError(resolvedCommand, error), {
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  try {
    await runInteractiveMessage(adapter, msg, text, hasAttachments ? msg.attachments : undefined, {
      registerInteractiveTask: (task) => INTERACTIVE_RUNTIME.registerInteractiveTask(task),
      resetMirrorSessionForInteractiveRun,
      isCurrentInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.isCurrentInteractiveTask(sessionId, taskId),
      touchInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.touchInteractiveTask(sessionId, taskId),
      recordInteractiveHealthStart: (sessionId, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveStart(sessionId, detail),
      recordInteractiveHealthProgress: (sessionId, type, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveProgress(sessionId, type, detail),
      recordInteractiveHealthTool: (sessionId, toolId, toolName, status) => {
        SESSION_HEALTH_RUNTIME.recordToolState(sessionId, toolId, toolName, status);
      },
      recordInteractiveStreamUiSnapshot: (sessionId, snapshot) => {
        SESSION_HEALTH_RUNTIME.recordStructuredStreamUi(sessionId, snapshot);
      },
      recordInteractiveHealthEnd: (sessionId, outcome, detail) => SESSION_HEALTH_RUNTIME.recordInteractiveEnd(sessionId, outcome, detail),
      beginMirrorSuppression,
      abortMirrorSuppression,
      settleMirrorSuppression,
      releaseInteractiveTask: (sessionId, taskId) => INTERACTIVE_RUNTIME.releaseInteractiveTask(sessionId, taskId),
      deliverResponse,
      persistSdkSessionUpdate,
    });
  } finally {
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  await handleBridgeCommand(adapter, msg, text, {
    getActiveTask: (sessionId) => INTERACTIVE_RUNTIME.getActiveTask(sessionId),
    diagnoseSessionHealth: (sessionId) => SESSION_HEALTH_RUNTIME.diagnoseSessionHealth(sessionId),
    diagnoseAllActiveSessions: () => SESSION_HEALTH_RUNTIME.diagnoseAllActiveSessions(),
  });
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

function persistSdkSessionUpdate(
  sessionId: string,
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): void {
  const update = computeSdkSessionUpdate(sdkSessionId, hasError);
  if (update === null) {
    return;
  }
  getBridgeContext().store.updateSdkSessionId(sessionId, update);
}

function resetStateForTests(): void {
  const state = getState();
  state.running = false;
  state.startedAt = null;
  state.adapters.clear();
  state.adapterMeta.clear();
  state.invalidAdapters.clear();
  ADAPTER_RUNTIME.clearWarningCache();
  state.loopAborts.clear();
  state.activeTasks.clear();
  state.mirrorSubscriptions.clear();
  state.mirrorSuppressUntil.clear();
  state.mirrorIgnoredTurnIds.clear();
  state.queuedCounts.clear();
  state.sessionLocks.clear();
  state.mirrorSyncInFlight = false;
  if (state.reconcileTimer) {
    clearInterval(state.reconcileTimer);
    state.reconcileTimer = null;
  }
  if (state.mirrorPollTimer) {
    clearInterval(state.mirrorPollTimer);
    state.mirrorPollTimer = null;
  }
  if (state.mirrorWakeTimer) {
    clearTimeout(state.mirrorWakeTimer);
    state.mirrorWakeTimer = null;
  }
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  syncConfiguredAdapters: (options: { startLoops: boolean }) => ADAPTER_RUNTIME.syncConfiguredAdapters(options),
  reconcileMirrorSubscriptions,
  resolveNewWorkingDirectory,
  resolveNewSessionWorkingDirectory,
  resolveCommandAlias,
  parseDesktopThreadListArgs,
  buildDesktopThreadsCommandResponse,
  formatCommandDateTime,
  toUserVisibleBindingError,
  toUserVisibleCommandError,
  normalizeReasoningEffort,
  resolveDisplayedModel,
  formatDisplayedModel,
  formatBindingChatLabel,
  formatRuntimeStatus,
  formatMirrorStatus,
  formatMirrorUserText,
  formatMirrorMessage,
  buildInteractiveStreamKey,
  buildMirrorStreamKey,
  appendMirrorTimeoutNotice,
  buildAdapterConfigFingerprint,
  consumeMirrorRecords,
  consumeBufferedMirrorTurns,
  flushTimedOutMirrorTurn,
  refreshMirrorStreamingStatus,
  filterSuppressedMirrorRecords,
  isMirrorSuppressed,
  reconcileIdleInteractiveTasks: () => INTERACTIVE_RUNTIME.reconcileIdleInteractiveTasks(),
  reconcileTerminalSessionRuntimeState: () => INTERACTIVE_RUNTIME.reconcileTerminalSessionRuntimeState(),
  beginMirrorSuppression,
  abortMirrorSuppression,
  settleMirrorSuppression,
  persistSdkSessionUpdate,
  resetStateForTests,
};
