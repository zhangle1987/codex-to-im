import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import type { TaskProgressInfo, ToolCallInfo } from './types.js';
import { buildMirrorStreamKey, formatMirrorUserText } from './mirror-formatters.js';

function nowIso(): string {
  return new Date().toISOString();
}

export interface DesktopMirrorTurnState {
  turnId: string | null;
  streamKey: string;
  startedAt: string;
  lastActivityAt: string;
  lastStatusText: string | null;
  lastStatusAt: number;
  statusNote: string | null;
  userText: string | null;
  lastAssistantText: string | null;
  lastCommentaryText: string | null;
  streamedText: string;
  streamStarted: boolean;
  taskItems: TaskProgressInfo[];
  toolCalls: Map<string, ToolCallInfo>;
}

export interface FinalizedDesktopMirrorTurn {
  streamKey: string;
  userText: string | null;
  text: string;
  signature: string;
  timestamp: string;
  status: 'completed' | 'interrupted';
  timedOut?: boolean;
}

export interface MirrorTurnStateHolder {
  sessionId: string;
  threadId: string;
  pendingTurn: DesktopMirrorTurnState | null;
}

export interface BufferedMirrorTurnStateHolder extends MirrorTurnStateHolder {
  bufferedRecords: DesktopMirrorRecord[];
}

export interface PendingMirrorDeliveryStateHolder {
  pendingDeliveries: FinalizedDesktopMirrorTurn[];
}

export interface MirrorTurnHooks<TSubscription extends MirrorTurnStateHolder = MirrorTurnStateHolder> {
  onStreamText?: (subscription: TSubscription, turnState: DesktopMirrorTurnState) => void;
  onStatusProgress?: (subscription: TSubscription, turnState: DesktopMirrorTurnState) => void;
  onTaskProgress?: (subscription: TSubscription, turnState: DesktopMirrorTurnState) => void;
  onToolProgress?: (subscription: TSubscription, turnState: DesktopMirrorTurnState) => void;
}

export function createMirrorTurnState(
  sessionId: string,
  timestamp: string,
  turnId?: string,
): DesktopMirrorTurnState {
  const safeTimestamp = timestamp || nowIso();
  return {
    turnId: turnId || null,
    streamKey: buildMirrorStreamKey(sessionId, turnId || null, safeTimestamp),
    startedAt: safeTimestamp,
    lastActivityAt: safeTimestamp,
    lastStatusText: null,
    lastStatusAt: 0,
    statusNote: null,
    userText: null,
    lastAssistantText: null,
    lastCommentaryText: null,
    streamedText: '',
    streamStarted: false,
    taskItems: [],
    toolCalls: new Map(),
  };
}

export function appendMirrorUserText(
  turnState: DesktopMirrorTurnState,
  chunk: string,
): void {
  const normalized = formatMirrorUserText(chunk);
  if (!normalized) return;
  if (!turnState.userText) {
    turnState.userText = normalized;
    return;
  }
  if (turnState.userText === normalized) {
    return;
  }
  turnState.userText = `${turnState.userText}\n\n${normalized}`;
}

export function appendMirrorStreamText(
  turnState: DesktopMirrorTurnState,
  chunk: string,
): void {
  const normalized = chunk.trim();
  if (!normalized) return;
  turnState.streamedText = turnState.streamedText
    ? `${turnState.streamedText}\n\n${normalized}`
    : normalized;
}

export function ensureMirrorTurnState<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  record: DesktopMirrorRecord,
): DesktopMirrorTurnState {
  if (!subscription.pendingTurn) {
    subscription.pendingTurn = createMirrorTurnState(subscription.sessionId, record.timestamp, record.turnId);
    return subscription.pendingTurn;
  }

  if (!subscription.pendingTurn.turnId && record.turnId) {
    subscription.pendingTurn.turnId = record.turnId;
  }
  if (record.timestamp) {
    subscription.pendingTurn.lastActivityAt = record.timestamp;
  }
  return subscription.pendingTurn;
}

export function finalizeMirrorTurn<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  signature: string,
  timestamp: string,
  status: 'completed' | 'interrupted',
  preferredText?: string,
): FinalizedDesktopMirrorTurn | null {
  const pendingTurn = subscription.pendingTurn;
  subscription.pendingTurn = null;
  if (!pendingTurn) return null;

  const text = [
    preferredText,
    pendingTurn.lastAssistantText,
    pendingTurn.lastCommentaryText,
  ]
    .map((value) => (value || '').trim())
    .find(Boolean) || '';
  const userText = pendingTurn.userText?.trim() || null;
  if (!text && !userText && pendingTurn.toolCalls.size === 0 && pendingTurn.taskItems.length === 0) return null;

  return {
    streamKey: pendingTurn.streamKey,
    userText,
    text,
    signature,
    timestamp: timestamp || pendingTurn.lastActivityAt || nowIso(),
    status,
    ...(signature.startsWith('timeout:') ? { timedOut: true } : {}),
  };
}

export function consumeMirrorRecords<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  records: DesktopMirrorRecord[],
  hooks: MirrorTurnHooks<TSubscription> = {},
): FinalizedDesktopMirrorTurn[] {
  const finalized: FinalizedDesktopMirrorTurn[] = [];

  for (const record of records) {
    if (record.type === 'task_started') {
      const pendingTurn = subscription.pendingTurn;
      const sameTurn = pendingTurn && (
        !pendingTurn.turnId
        || !record.turnId
        || pendingTurn.turnId === record.turnId
      );
      if (!sameTurn) {
        const superseded = finalizeMirrorTurn(subscription, `superseded:${record.signature}`, record.timestamp, 'interrupted');
        if (superseded) finalized.push(superseded);
      }
      if (!subscription.pendingTurn) {
        subscription.pendingTurn = createMirrorTurnState(subscription.sessionId, record.timestamp, record.turnId);
      } else {
        if (!subscription.pendingTurn.turnId && record.turnId) {
          subscription.pendingTurn.turnId = record.turnId;
        }
        if (record.timestamp) {
          subscription.pendingTurn.lastActivityAt = record.timestamp;
        }
      }
      continue;
    }

    if (record.type === 'task_complete') {
      ensureMirrorTurnState(subscription, record);
      const completed = finalizeMirrorTurn(subscription, record.signature, record.timestamp, 'completed', record.content);
      if (completed) finalized.push(completed);
      continue;
    }

    if (record.type === 'task_aborted') {
      ensureMirrorTurnState(subscription, record);
      const interrupted = finalizeMirrorTurn(subscription, record.signature, record.timestamp, 'interrupted');
      if (interrupted) finalized.push(interrupted);
      continue;
    }

    if (record.type === 'message' && record.role === 'user') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const text = record.content.trim();
      if (text) {
        appendMirrorUserText(pendingTurn, text);
        hooks.onStreamText?.(subscription, pendingTurn);
      }
      continue;
    }

    if (record.type === 'message') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      if (record.role === 'assistant') {
        const text = record.content.trim();
        if (text) {
          pendingTurn.lastAssistantText = text;
          appendMirrorStreamText(pendingTurn, text);
          hooks.onStreamText?.(subscription, pendingTurn);
        }
      } else if (record.role === 'commentary') {
        const text = record.content.trim();
        if (text) {
          pendingTurn.lastCommentaryText = text;
          appendMirrorStreamText(pendingTurn, text);
          hooks.onStreamText?.(subscription, pendingTurn);
        }
      }
      continue;
    }

    if (record.type === 'reasoning') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const text = record.content.trim();
      if (!text) continue;
      pendingTurn.statusNote = text;
      hooks.onStatusProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'plan_update') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      pendingTurn.taskItems = record.tasks || [];
      hooks.onTaskProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'tool_started') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const toolId = record.toolId || record.signature;
      const toolName = record.toolName || pendingTurn.toolCalls.get(toolId)?.name || 'tool';
      pendingTurn.toolCalls.set(toolId, {
        id: toolId,
        name: toolName,
        status: 'running',
      });
      hooks.onToolProgress?.(subscription, pendingTurn);
      continue;
    }

    if (record.type === 'tool_finished') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const toolId = record.toolId || record.signature;
      const existing = pendingTurn.toolCalls.get(toolId);
      pendingTurn.toolCalls.set(toolId, {
        id: toolId,
        name: existing?.name || record.toolName || 'tool',
        status: record.isError ? 'error' : 'complete',
      });
      hooks.onToolProgress?.(subscription, pendingTurn);
      continue;
    }
  }

  return finalized;
}

export function flushTimedOutMirrorTurn<TSubscription extends MirrorTurnStateHolder>(
  subscription: TSubscription,
  idleTimeoutMs: number,
  nowMs = Date.now(),
): FinalizedDesktopMirrorTurn | null {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn?.lastActivityAt) return null;
  const lastActivityMs = Date.parse(pendingTurn.lastActivityAt);
  if (!Number.isFinite(lastActivityMs)) return null;
  if (nowMs - lastActivityMs < idleTimeoutMs) {
    return null;
  }

  return finalizeMirrorTurn(
    subscription,
    `timeout:${subscription.threadId}:${pendingTurn.turnId || pendingTurn.lastActivityAt}`,
    pendingTurn.lastActivityAt,
    'interrupted',
  );
}

export function enqueuePendingMirrorDeliveries<TSubscription extends PendingMirrorDeliveryStateHolder>(
  subscription: TSubscription,
  turns: FinalizedDesktopMirrorTurn[],
): void {
  if (turns.length === 0) return;
  const existingSignatures = new Set(subscription.pendingDeliveries.map((turn) => turn.signature));
  for (const turn of turns) {
    if (existingSignatures.has(turn.signature)) continue;
    subscription.pendingDeliveries.push(turn);
    existingSignatures.add(turn.signature);
  }
}

export function removePendingMirrorDeliveries<TSubscription extends PendingMirrorDeliveryStateHolder>(
  subscription: TSubscription,
  turns: FinalizedDesktopMirrorTurn[],
): void {
  if (turns.length === 0 || subscription.pendingDeliveries.length === 0) return;
  const deliveredSignatures = new Set(turns.map((turn) => turn.signature));
  subscription.pendingDeliveries = subscription.pendingDeliveries.filter(
    (turn) => !deliveredSignatures.has(turn.signature),
  );
}

export function selectPendingMirrorDeliveries<TSubscription extends PendingMirrorDeliveryStateHolder>(
  subscription: TSubscription,
  blocked: boolean,
): FinalizedDesktopMirrorTurn[] {
  if (!blocked) {
    return subscription.pendingDeliveries.slice();
  }
  return subscription.pendingDeliveries.filter((turn) => turn.timedOut);
}

export function hasPendingMirrorWork(
  subscription: BufferedMirrorTurnStateHolder & PendingMirrorDeliveryStateHolder,
): boolean {
  return subscription.bufferedRecords.length > 0
    || subscription.pendingTurn !== null
    || subscription.pendingDeliveries.length > 0;
}

export function consumeBufferedMirrorTurns<TSubscription extends BufferedMirrorTurnStateHolder>(
  subscription: TSubscription,
  idleTimeoutMs: number,
  nowMs = Date.now(),
  hooks: MirrorTurnHooks<TSubscription> = {},
): FinalizedDesktopMirrorTurn[] {
  const bufferedRecords = subscription.bufferedRecords;
  subscription.bufferedRecords = [];

  const finalizedTurns = bufferedRecords.length > 0
    ? consumeMirrorRecords(subscription, bufferedRecords, hooks)
    : [];

  const timedOutTurn = flushTimedOutMirrorTurn(subscription, idleTimeoutMs, nowMs);
  if (timedOutTurn) {
    finalizedTurns.push(timedOutTurn);
  }

  return finalizedTurns;
}
