import type {
  InboundMessage,
  OutboundAttachment,
  StreamingPreviewState,
  TaskProgressInfo,
  ToolCallInfo,
} from './types.js';
import type { BaseChannelAdapter, StructuredStreamingUiSnapshot } from './channel-adapter.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { getBridgeContext } from './context.js';
import { stripOutboundArtifactBlocksForStreaming } from './outbound-artifacts.js';
import { buildInteractiveStreamKey } from './mirror-formatters.js';
import {
  finalizeStreamFeedback,
  pushStreamFeedbackStatus,
  pushStreamFeedbackTasks,
  pushStreamFeedbackText,
  pushStreamFeedbackTools,
} from './stream-feedback-controller.js';

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1);
}

export interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};
const STREAM_STATUS_IDLE_START_MS = 180_000;
const STREAM_STATUS_HEARTBEAT_MS = 10_000;

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function getStructuredStreamStatusConfig(): {
  idleStartMs: number;
  heartbeatMs: number;
} {
  const { store } = getBridgeContext();
  const idleStartSeconds = parseInt(store.getSetting('bridge_stream_status_idle_start_seconds') || '', 10);
  const heartbeatSeconds = parseInt(store.getSetting('bridge_stream_status_check_interval_seconds') || '', 10);
  return {
    idleStartMs: Math.max(
      0,
      (Number.isFinite(idleStartSeconds) && idleStartSeconds > 0 ? idleStartSeconds : STREAM_STATUS_IDLE_START_MS / 1000) * 1000,
    ),
    heartbeatMs: Math.max(
      1_000,
      (Number.isFinite(heartbeatSeconds) && heartbeatSeconds > 0 ? heartbeatSeconds : STREAM_STATUS_HEARTBEAT_MS / 1000) * 1000,
    ),
  };
}

function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then((result) => {
    if (result === 'degrade') state.degraded = true;
  }).catch(() => {});
}

function formatRuntimeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0 && seconds === 0) return `${hours}h`;
  if (seconds === 0) return `${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m ${seconds}s`;
}

export function formatInteractiveRuntimeStatus(
  elapsedMs: number,
  silentMs?: number | null,
  statusNote?: string | null,
): string {
  const parts = [elapsedMs < 1000 ? '处理中' : `已运行 ${formatRuntimeDuration(elapsedMs)}`];
  if (typeof silentMs === 'number' && silentMs >= 0) {
    parts.push(`最近 ${formatRuntimeDuration(silentMs)} 无新输出`);
  }
  const runtimeText = parts.join('，');
  const note = (statusNote || '').trim();
  return note ? `当前步骤：${note}\n${runtimeText}` : runtimeText;
}

export interface InteractiveTaskState {
  id: string;
  abortController: AbortController;
  adapter: BaseChannelAdapter;
  address: InboundMessage['address'];
  requestMessageId: string;
  streamKey: string;
  sessionId: string;
  hasStreamingCards: boolean;
  structuredStreamUiActive: boolean;
  lastActivityAt: number;
  idleReminderSent: boolean;
  streamFinalized: boolean;
  uiEnded: boolean;
  mirrorSuppressionId: string | null;
}

export interface RunInteractiveMessageDeps {
  registerInteractiveTask(task: InteractiveTaskState): void;
  resetMirrorSessionForInteractiveRun(sessionId: string): void;
  isCurrentInteractiveTask(sessionId: string, taskId: string): boolean;
  touchInteractiveTask(sessionId: string, taskId: string): void;
  recordInteractiveHealthStart(sessionId: string, detail?: string): void;
  recordInteractiveHealthProgress(sessionId: string, type: 'text' | 'permission_wait', detail?: string): void;
  recordInteractiveHealthTool(sessionId: string, toolId: string, toolName: string, status: 'running' | 'complete' | 'error'): void;
  recordInteractiveStreamUiSnapshot?(sessionId: string, snapshot: StructuredStreamingUiSnapshot): void;
  recordInteractiveHealthEnd(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
  beginMirrorSuppression(sessionId: string, promptText: string): string;
  abortMirrorSuppression(sessionId: string, suppressionId?: string | null): void;
  settleMirrorSuppression(sessionId: string, suppressionId?: string | null): void;
  releaseInteractiveTask(sessionId: string, taskId: string): void;
  deliverResponse(
    adapter: BaseChannelAdapter,
    address: InboundMessage['address'],
    responseText: string,
    sessionId: string,
    replyToMessageId?: string,
    attachments?: OutboundAttachment[],
  ): Promise<unknown>;
  persistSdkSessionUpdate(
    sessionId: string,
    sdkSessionId: string | null | undefined,
    hasError: boolean,
  ): void;
  processMessageImpl?: typeof engine.processMessage;
  forwardPermissionRequestImpl?: typeof broker.forwardPermissionRequest;
  nowMs?(): number;
  setIntervalFn?(callback: () => void, intervalMs: number): unknown;
  clearIntervalFn?(handle: unknown): void;
  streamStatusIdleDetectionStartMs?: number;
  streamStatusHeartbeatMs?: number;
}

export async function runInteractiveMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  attachments: InboundMessage['attachments'] | undefined,
  deps: RunInteractiveMessageDeps,
): Promise<void> {
  const binding = router.resolve(msg.address);
  const streamKey = buildInteractiveStreamKey(binding.codepilotSessionId, msg.messageId);
  const nowMs = deps.nowMs ?? (() => Date.now());
  const setIntervalFn = deps.setIntervalFn ?? ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const processMessageImpl = deps.processMessageImpl ?? engine.processMessage;
  const forwardPermissionRequestImpl = deps.forwardPermissionRequestImpl ?? broker.forwardPermissionRequest;
  const structuredStreamStatusConfig = getStructuredStreamStatusConfig();
  const streamStatusIdleDetectionStartMs = Math.max(
    0,
    deps.streamStatusIdleDetectionStartMs ?? structuredStreamStatusConfig.idleStartMs,
  );
  const streamStatusHeartbeatMs = Math.max(
    1_000,
    deps.streamStatusHeartbeatMs ?? structuredStreamStatusConfig.heartbeatMs,
  );

  adapter.onMessageStart?.(msg.address.chatId, streamKey);

  const taskAbort = new AbortController();
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const taskStartedAt = nowMs();
  deps.resetMirrorSessionForInteractiveRun(binding.codepilotSessionId);
  const taskState: InteractiveTaskState = {
    id: taskId,
    abortController: taskAbort,
    adapter,
    address: msg.address,
    requestMessageId: msg.messageId,
    streamKey,
    sessionId: binding.codepilotSessionId,
    hasStreamingCards: false,
    structuredStreamUiActive: false,
    lastActivityAt: taskStartedAt,
    idleReminderSent: false,
    streamFinalized: false,
    uiEnded: false,
    mirrorSuppressionId: null,
  };
  deps.registerInteractiveTask(taskState);
  deps.recordInteractiveHealthStart(binding.codepilotSessionId);

  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.provider) : null;
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;
    const sanitizedText = stripOutboundArtifactBlocksForStreaming(fullText);

    ps.pendingText = sanitizedText.length > cfg.maxChars
      ? sanitizedText.slice(0, cfg.maxChars) + '...'
      : sanitizedText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  taskState.hasStreamingCards = hasStreamingCards;
  const toolCallTracker = new Map<string, ToolCallInfo>();
  const streamFeedbackTarget = {
    adapter,
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    streamKey,
    ensureStarted: () => {
      adapter.onMessageStart?.(msg.address.chatId, streamKey);
    },
  };
  const supportsPersistentStreamStatus = hasStreamingCards
    && adapter.provider === 'feishu'
    && typeof adapter.onStreamStatus === 'function';
  const supportsStructuredStreamUi = supportsPersistentStreamStatus
    && (adapter.supportsStructuredStreamingUi?.(msg.address.chatId) ?? true);
  let latestStatusNote: string | null = null;
  let latestTasks: TaskProgressInfo[] = [];
  const syncStructuredStreamUiState = () => {
    if (!supportsStructuredStreamUi || taskState.structuredStreamUiActive) return;
    if (adapter.hasActiveStreamingUi?.(msg.address.chatId, streamKey)) {
      taskState.structuredStreamUiActive = true;
    }
  };
  const syncStructuredStreamUiSnapshot = () => {
    if (!supportsStructuredStreamUi) return;
    syncStructuredStreamUiState();
    const snapshot = adapter.getStructuredStreamingUiSnapshot?.(msg.address.chatId, streamKey);
    if (!snapshot) return;
    deps.recordInteractiveStreamUiSnapshot?.(binding.codepilotSessionId, snapshot);
  };
  const pushRunningStatus = (silentMs?: number | null) => {
    if (!supportsStructuredStreamUi || streamStatusUpdatesClosed) return;
    pushStreamFeedbackStatus(
      streamFeedbackTarget,
      formatInteractiveRuntimeStatus(nowMs() - taskStartedAt, silentMs, latestStatusNote),
    );
    syncStructuredStreamUiSnapshot();
  };

  let streamStatusHeartbeat: unknown = null;
  let streamStatusUpdatesClosed = false;
  const clearStreamStatusHeartbeat = () => {
    if (streamStatusHeartbeat == null) return;
    clearIntervalFn(streamStatusHeartbeat);
    streamStatusHeartbeat = null;
  };
  const stopStructuredStreamStatusUpdates = () => {
    streamStatusUpdatesClosed = true;
    clearStreamStatusHeartbeat();
  };

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    pushStreamFeedbackText(
      streamFeedbackTarget,
      stripOutboundArtifactBlocksForStreaming(fullText),
    );
  } : undefined;

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    deps.touchInteractiveTask(binding.codepilotSessionId, taskId);
    deps.recordInteractiveHealthTool(binding.codepilotSessionId, toolId, toolName, status);
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    if (hasStreamingCards) {
      pushStreamFeedbackTools(streamFeedbackTarget, Array.from(toolCallTracker.values()));
    }
    pushRunningStatus(null);
    syncStructuredStreamUiSnapshot();
  };

  const onTaskEvent = (tasks: TaskProgressInfo[]) => {
    if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    deps.touchInteractiveTask(binding.codepilotSessionId, taskId);
    latestTasks = tasks;
    if (hasStreamingCards) {
      pushStreamFeedbackTasks(streamFeedbackTarget, latestTasks);
    }
    pushRunningStatus(null);
    syncStructuredStreamUiSnapshot();
  };

  const onStatusNote = (note: string | null) => {
    if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    deps.touchInteractiveTask(binding.codepilotSessionId, taskId);
    latestStatusNote = (note || '').trim() || null;
    pushRunningStatus(null);
    syncStructuredStreamUiSnapshot();
  };

  const onPartialText = (fullText: string) => {
    if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    deps.touchInteractiveTask(binding.codepilotSessionId, taskId);
    deps.recordInteractiveHealthProgress(binding.codepilotSessionId, 'text');
    previewOnPartialText?.(fullText);
    onStreamCardText?.(fullText);
    pushRunningStatus(null);
    syncStructuredStreamUiSnapshot();
  };

  if (supportsStructuredStreamUi) {
    pushRunningStatus(null);
    streamStatusHeartbeat = setIntervalFn(() => {
      if (streamStatusUpdatesClosed) {
        clearStreamStatusHeartbeat();
        return;
      }
      if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId) || taskAbort.signal.aborted) {
        clearStreamStatusHeartbeat();
        return;
      }
      const elapsedMs = nowMs() - taskStartedAt;
      const silentMs = nowMs() - taskState.lastActivityAt;
      const showSilentDuration = elapsedMs >= streamStatusIdleDetectionStartMs
        && silentMs >= streamStatusHeartbeatMs
        ? silentMs
        : null;
      pushRunningStatus(showSilentDuration);
      syncStructuredStreamUiSnapshot();
    }, streamStatusHeartbeatMs);
  }

  let finalOutcome: 'completed' | 'failed' | 'aborted' = 'failed';
  let finalOutcomeDetail: string | undefined;
  let shouldRecordHealthEnd = true;

  try {
    const promptText = text || (attachments && attachments.length > 0 ? 'Describe this image.' : '');

    const result = await processMessageImpl(
      binding,
      promptText,
      async (perm) => {
        await forwardPermissionRequestImpl(
          adapter,
          msg.address,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
        );
        deps.recordInteractiveHealthProgress(
          binding.codepilotSessionId,
          'permission_wait',
          `当前正在等待工具 ${perm.toolName} 的权限确认。`,
        );
        deps.touchInteractiveTask(binding.codepilotSessionId, taskId);
        pushRunningStatus(null);
        syncStructuredStreamUiSnapshot();
      },
      taskAbort.signal,
      attachments && attachments.length > 0 ? attachments : undefined,
      onPartialText,
      onToolEvent,
      onTaskEvent,
      onStatusNote,
      (preparedPrompt) => {
        if (!taskState.mirrorSuppressionId) {
          taskState.mirrorSuppressionId = deps.beginMirrorSuppression(binding.codepilotSessionId, preparedPrompt);
        }
      },
    );

    if (!deps.isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) {
      shouldRecordHealthEnd = false;
      return;
    }

    let cardFinalized = false;
    if (hasStreamingCards) {
      stopStructuredStreamStatusUpdates();
      cardFinalized = await finalizeStreamFeedback(
        streamFeedbackTarget,
        result.hasError ? 'error' : 'completed',
        result.responseText,
      );
      taskState.streamFinalized = cardFinalized;
    }

    if (
      result.responseText || result.outboundAttachments.length > 0
    ) {
      const textToDeliver = cardFinalized ? '' : result.responseText;
      if (!cardFinalized || result.outboundAttachments.length > 0) {
        await deps.deliverResponse(
          adapter,
          msg.address,
          textToDeliver,
          binding.codepilotSessionId,
          msg.messageId,
          result.outboundAttachments,
        );
      }
    } else if (result.hasError) {
      await deps.deliverResponse(
        adapter,
        msg.address,
        `**Error:** ${result.errorMessage}`,
        binding.codepilotSessionId,
        msg.messageId,
        [],
      );
    }

    try {
      deps.persistSdkSessionUpdate(binding.codepilotSessionId, result.sdkSessionId, result.hasError);
    } catch {
      // best effort
    }
    finalOutcome = result.hasError ? 'failed' : 'completed';
    finalOutcomeDetail = result.hasError
      ? (result.errorMessage?.trim() || undefined)
      : undefined;
  } finally {
    stopStructuredStreamStatusUpdates();
    deps.recordInteractiveStreamUiSnapshot?.(binding.codepilotSessionId, { active: false });
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    if (
      hasStreamingCards
      && taskAbort.signal.aborted
      && !taskState.streamFinalized
    ) {
      taskState.streamFinalized = await finalizeStreamFeedback(
        streamFeedbackTarget,
        'interrupted',
        '',
      );
    }

    if (taskState.mirrorSuppressionId) {
      if (taskAbort.signal.aborted) {
        deps.abortMirrorSuppression(binding.codepilotSessionId, taskState.mirrorSuppressionId);
      } else {
        deps.settleMirrorSuppression(binding.codepilotSessionId, taskState.mirrorSuppressionId);
      }
      taskState.mirrorSuppressionId = null;
    }
    if (shouldRecordHealthEnd) {
      if (taskAbort.signal.aborted) {
        finalOutcome = 'aborted';
        finalOutcomeDetail = '任务已收到停止请求。';
      }
      deps.recordInteractiveHealthEnd(binding.codepilotSessionId, finalOutcome, finalOutcomeDetail);
    }
    deps.releaseInteractiveTask(binding.codepilotSessionId, taskId);
    if (!taskState.uiEnded) {
      adapter.onMessageEnd?.(msg.address.chatId, streamKey);
      taskState.uiEnded = true;
    }
  }
}
