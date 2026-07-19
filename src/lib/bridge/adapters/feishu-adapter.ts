/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue consumed by the bridge runtime.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
  SendResult,
  TaskProgressInfo,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import type { ToolCallInfo } from '../types.js';
import {
  feishuSiteToApiBaseUrl,
  normalizeFeishuSite,
  type FeishuChannelConfig,
} from '../../../config.js';
import {
  BaseChannelAdapter,
  registerAdapterFactory,
  type AdapterRuntimeInstance,
  type StructuredStreamingUiSnapshot,
} from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildStreamingTaskContent,
  buildStreamingTextContent,
  buildStreamingToolsContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  formatElapsed,
} from '../markdown/feishu.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ATTACHMENT_REQUEST_TIMEOUT_MS = 60_000;

/** Feishu emoji type for completed tasks. */
const COMPLETED_EMOJI = 'DONE';
/** Feishu emoji type for failed tasks. */
const ERROR_EMOJI = 'ERROR';
/** Delay terminal reactions so clients can render the final non-streaming card first. */
const CARD_TERMINAL_REACTION_DELAY_MS = 2_000;

/** State for an active CardKit v2 streaming card. */
interface FeishuCardState {
  chatId: string;
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  taskItems: TaskProgressInfo[];
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  pendingTasksText: string | null;
  pendingStatusText: string | null;
  renderedText: string | null;
  renderedTasksText: string | null;
  renderedToolsText: string | null;
  renderedStatusText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  flushInFlight: Promise<void> | null;
  flushQueued: boolean;
  lastFlushStartedAt: number | null;
  lastSuccessfulFlushAt: number | null;
  lastFlushErrorAt: number | null;
  lastFlushError: string | null;
  consecutiveFlushFailures: number;
  lastFullRefreshAttemptAt: number;
  lastSuccessfulFullRefreshAt: number | null;
}

interface FeishuCardFinalizationRequest {
  chatId: string;
  status: 'completed' | 'interrupted' | 'error';
  responseText: string;
  streamKey?: string;
  retryIndex: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface FeishuCardFinalizationAttemptResult {
  finalized: boolean;
  textCovered: boolean;
  retryable: boolean;
}

/** Streaming card throttle interval (ms). */
const CARD_THROTTLE_MS = 1000;
const CARD_REQUEST_TIMEOUT_MS = 15_000;
const CARD_FINALIZE_FLUSH_WAIT_EXTRA_MS = 1_000;
const CARD_FINALIZE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000];
const CARD_STOP_FINALIZE_TIMEOUT_MS = 2_000;
const CARD_FULL_REFRESH_INTERVAL_MS = 5 * 60_000;
const FINAL_CARD_FULL_TEXT_MAX_CHARS = 12_000;
const FINAL_CARD_PREVIEW_CHARS = 4_000;
const INITIAL_STREAMING_STATUS = '处理中';
const EMPTY_STREAMING_TASKS = '';
const EMPTY_STREAMING_TOOLS = '';

export function validateFeishuAttachmentPath(
  filePath: string,
  maxSize = MAX_FILE_SIZE,
): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return `Attachment not found: ${filePath}`;
  }
  if (!stat.isFile()) return `Attachment is not a regular file: ${filePath}`;
  if (stat.size > maxSize) {
    return `Attachment is too large: ${stat.size} bytes (max ${maxSize} bytes)`;
  }
  return null;
}

function normalizeAttachmentFileName(value: string): string {
  return value.replace(/[\r\n"]/g, '_') || 'attachment.bin';
}

function shouldDeliverFinalTextSeparately(text: string): boolean {
  return text.trim().length > FINAL_CARD_FULL_TEXT_MAX_CHARS;
}

function buildFinalCardTextPreview(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const preview = trimmed.slice(0, FINAL_CARD_PREVIEW_CHARS).trimEnd();
  return `${preview}\n\n---\n\n回复较长，完整内容将继续以普通消息发送。`;
}

function buildStreamingCardBody(
  content: string,
  tasksText: string,
  toolsText: string,
  statusText: string,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      summary: { content: '思考中...' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content,
          text_align: 'left',
          text_size: 'normal',
          element_id: 'streaming_content',
        },
        {
          tag: 'markdown',
          content: tasksText,
          text_align: 'left',
          text_size: 'normal',
          element_id: 'streaming_tasks',
        },
        {
          tag: 'markdown',
          content: toolsText,
          text_align: 'left',
          text_size: 'normal',
          element_id: 'streaming_tools',
        },
        {
          tag: 'markdown',
          content: statusText,
          text_align: 'left',
          text_size: 'notation',
          element_id: 'streaming_status',
        },
      ],
    },
  };
}

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType;
  readonly provider = 'feishu';
  readonly alias?: string;
  private readonly channelConfig: FeishuChannelConfig;

  private running = false;
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for replying with streaming cards. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Active streaming card state per stream key. */
  private activeCards = new Map<string, FeishuCardState>();
  /** In-flight card creation promises per stream key — prevents duplicate creation. */
  private cardCreatePromises = new Map<string, Promise<boolean>>();
  /** Terminal card updates retained until CardKit confirms finalization. */
  private pendingCardFinalizations = new Map<string, FeishuCardFinalizationRequest>();
  private cardFinalizePromises = new Map<string, Promise<FeishuCardFinalizationAttemptResult>>();
  /** Cached tenant token for upload APIs. */
  private tenantTokenCache:
    | { token: string; expiresAt: number; appId: string; appSecret: string; domain: string }
    | null = null;
  private cardRequestTimeoutMs = CARD_REQUEST_TIMEOUT_MS;
  private cardFinalizeFlushWaitExtraMs = CARD_FINALIZE_FLUSH_WAIT_EXTRA_MS;
  private cardFullRefreshIntervalMs = CARD_FULL_REFRESH_INTERVAL_MS;
  private cardTerminalReactionDelayMs = CARD_TERMINAL_REACTION_DELAY_MS;
  private cardFinalizeRetryDelaysMs = CARD_FINALIZE_RETRY_DELAYS_MS;
  private cardStopFinalizeTimeoutMs = CARD_STOP_FINALIZE_TIMEOUT_MS;
  private stopping = false;

  constructor(instance?: AdapterRuntimeInstance) {
    super();
    this.channelType = instance?.id || 'feishu';
    this.alias = instance?.alias;
    this.channelConfig = (instance?.config || {}) as FeishuChannelConfig;
  }

  private get appId(): string {
    return this.channelConfig.appId?.trim() || '';
  }

  private get appSecret(): string {
    return this.channelConfig.appSecret?.trim() || '';
  }

  private get site(): 'feishu' | 'lark' {
    return normalizeFeishuSite(this.channelConfig.site);
  }

  private isStreamingEnabled(): boolean {
    return this.channelConfig.streamingEnabled !== false;
  }

  supportsStructuredStreamingUi(_chatId: string): boolean {
    return this.isStreamingEnabled();
  }

  private resolveStreamKey(chatId: string, streamKey?: string): string {
    return streamKey?.trim() || chatId;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = this.appId;
    const appSecret = this.appSecret;
    const site = this.site;
    const domain = site === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    // Create REST client
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
    });

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;

    // Create EventDispatcher and register event handlers.
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
    });

    // Create and start WSClient
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
    });

    // Monkey-patch WSClient.handleEventData to support card action events (type: "card").
    // The SDK's WSClient only processes type="event" messages. Card action callbacks
    // arrive as type="card" and would be silently dropped without this patch.
    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          console.log('[feishu-adapter] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopping = true;

    const finalizations = Array.from(this.activeCards.entries()).map(([cardKey, state]) => {
      const pending = this.pendingCardFinalizations.get(cardKey);
      return this.finalizeCard(
        state.chatId,
        pending?.status || 'interrupted',
        pending?.responseText || 'Bridge 服务正在停止，当前任务已中断。',
        cardKey,
      );
    });
    if (finalizations.length > 0) {
      let stopTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          Promise.allSettled(finalizations),
          new Promise<void>((resolve) => {
            stopTimeout = setTimeout(resolve, Math.max(0, this.cardStopFinalizeTimeoutMs));
          }),
        ]);
      } finally {
        if (stopTimeout) clearTimeout(stopTimeout);
      }
    }

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    // Reject all waiting consumers
    this.rejectPendingInboundConsumers();

    // Clean up active cards
    for (const [, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    for (const request of this.pendingCardFinalizations.values()) {
      if (request.retryTimer) clearTimeout(request.retryTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();
    this.pendingCardFinalizations.clear();
    this.cardFinalizePromises.clear();

    // Clear state
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    return this.consumeInboundMessage(this.running);
  }

  // ── Streaming lifecycle hooks ──────────────────────────────

  /**
   * Create the streaming card as early as possible.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string, streamKey?: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);

    // Create streaming card (fire-and-forget — fallback to traditional if fails)
    if (messageId && this.isStreamingEnabled()) {
      this.createStreamingCard(chatId, messageId, streamKey).catch(() => {});
    }
  }

  /**
   * Clean up card state.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (this.pendingCardFinalizations.has(cardKey)) return;
    this.cleanupCard(chatId, streamKey);
  }

  // ── Card Action Handler ─────────────────────────────────────

  /**
   * Handle card.action.trigger events (button clicks on permission cards).
   * Converts button clicks to synthetic InboundMessage with callbackData.
   * Must return within 3 seconds (Feishu timeout), so uses a 2.5s race.
   */
  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };

    try {
      const event = data as any;
      const value = event?.action?.value ?? {};
      const callbackData = value.callback_data;
      if (!callbackData) return FALLBACK_TOAST;

      // Extract chat/user context
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      if (!chatId) return FALLBACK_TOAST;

      const callbackMsg: import('../types.js').InboundMessage = {
        messageId: messageId || `card_action_${Date.now()}`,
        address: {
          channelType: this.channelType,
          channelProvider: this.provider,
          channelAlias: this.alias,
          chatId,
          userId,
        },
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      };
      this.enqueueInboundMessage(callbackMsg);

      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu-adapter] Card action handler error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Streaming Card (CardKit v2) ────────────────────────────────

  /**
   * Create a new streaming card and send it as a message.
   * Returns true if card was created successfully.
   */
  private createStreamingCard(chatId: string, replyToMessageId?: string, streamKey?: string): Promise<boolean> {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.restClient || this.activeCards.has(cardKey)) return Promise.resolve(false);

    // In-flight guard: if creation is already in progress, return the existing promise
    const existing = this.cardCreatePromises.get(cardKey);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId, cardKey);
    this.cardCreatePromises.set(cardKey, promise);
    promise.finally(() => this.cardCreatePromises.delete(cardKey));
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId?: string, streamKey?: string): Promise<boolean> {
    if (!this.restClient) return false;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const cardkit = (this.restClient as any).cardkit?.v1;
    if (!cardkit?.card) {
      console.warn('[feishu-adapter] CardKit v1 API is unavailable in the current Feishu SDK client');
      return false;
    }

    try {
      // Step 1: Create card via CardKit v1
      const cardBody = buildStreamingCardBody(
        '💭 Thinking...',
        EMPTY_STREAMING_TASKS,
        EMPTY_STREAMING_TOOLS,
        INITIAL_STREAMING_STATUS,
      );

      const createResp = await this.withFeishuRequestTimeout<{ data?: { card_id?: string } }>(cardKey, 'card.create', () => cardkit.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      }));
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-adapter] Card create returned no card_id');
        return false;
      }

      // Step 2: Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.withFeishuRequestTimeout(cardKey, 'im.message.reply:interactive', () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        }));
      } else {
        msgResp = await this.withFeishuRequestTimeout(cardKey, 'im.message.create:interactive', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        }));
      }

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu-adapter] Card message send returned no message_id');
        return false;
      }

      // Store card state
      const now = Date.now();
      this.activeCards.set(cardKey, {
        chatId,
        cardId,
        messageId,
        sequence: 0,
        startTime: now,
        taskItems: [],
        toolCalls: [],
        thinking: true,
        pendingText: null,
        pendingTasksText: EMPTY_STREAMING_TASKS,
        pendingStatusText: INITIAL_STREAMING_STATUS,
        renderedText: '💭 Thinking...',
        renderedTasksText: EMPTY_STREAMING_TASKS,
        renderedToolsText: EMPTY_STREAMING_TOOLS,
        renderedStatusText: INITIAL_STREAMING_STATUS,
        lastUpdateAt: 0,
        throttleTimer: null,
        flushInFlight: null,
        flushQueued: false,
        lastFlushStartedAt: null,
        lastSuccessfulFlushAt: null,
        lastFlushErrorAt: null,
        lastFlushError: null,
        consecutiveFlushFailures: 0,
        lastFullRefreshAttemptAt: now,
        lastSuccessfulFullRefreshAt: null,
      });

      console.log(`[feishu-adapter] Streaming card created: streamKey=${cardKey}, cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Update streaming card content with throttling.
   */
  private updateCardContent(chatId: string, text: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return;

    // Clear thinking state once text arrives
    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;

    this.scheduleCardFlush(cardKey);
  }

  private updateCardStatus(chatId: string, statusText: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state || !this.restClient) return;
    state.pendingStatusText = statusText || INITIAL_STREAMING_STATUS;
    this.scheduleCardFlush(cardKey);
  }

  private updateTaskProgress(chatId: string, tasks: TaskProgressInfo[], streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    state.taskItems = tasks;
    state.pendingTasksText = buildStreamingTaskContent(tasks) || EMPTY_STREAMING_TASKS;
    this.scheduleCardFlush(cardKey);
  }

  private enqueueCardFlush(streamKey: string): void {
    const state = this.activeCards.get(streamKey);
    if (!state) return;
    if (state.flushInFlight) {
      state.flushQueued = true;
      return;
    }

    state.lastFlushStartedAt = Date.now();
    state.flushInFlight = this.flushCardUpdate(streamKey)
      .catch((err: unknown) => {
        console.warn('[feishu-adapter] cardElement.content failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        const current = this.activeCards.get(streamKey);
        if (!current) return;
        current.flushInFlight = null;
        if (current.flushQueued) {
          current.flushQueued = false;
          this.enqueueCardFlush(streamKey);
        }
      });
  }

  private scheduleCardFlush(streamKey: string): void {
    const state = this.activeCards.get(streamKey);
    if (!state) return;
    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      // Schedule trailing-edge flush
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          this.enqueueCardFlush(streamKey);
        }, CARD_THROTTLE_MS - elapsed);
      }
      return;
    }

    // Clear pending timer and flush immediately
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.enqueueCardFlush(streamKey);
  }

  /**
   * Flush pending card update to Feishu API.
   */
  private async flushCardUpdate(streamKey: string): Promise<void> {
    const state = this.activeCards.get(streamKey);
    if (!state || !this.restClient) return;
    const cardkit = (this.restClient as any).cardkit?.v1;
    if (!cardkit?.cardElement?.content) return;

    const content = buildStreamingTextContent(state.pendingText || '');
    const tasksText = state.pendingTasksText || EMPTY_STREAMING_TASKS;
    const toolsText = buildStreamingToolsContent(state.toolCalls) || EMPTY_STREAMING_TOOLS;
    const statusText = state.pendingStatusText || INITIAL_STREAMING_STATUS;
    const updates: Array<{ elementId: string; content: string; onSuccess: () => void }> = [];

    if (this.shouldFullRefreshCard(state, Date.now())) {
      const refreshed = await this.flushFullCardRefresh(
        streamKey,
        state,
        content,
        tasksText,
        toolsText,
        statusText,
      );
      if (refreshed) return;
    }

    if (content !== state.renderedText) {
      updates.push({
        elementId: 'streaming_content',
        content,
        onSuccess: () => {
          state.renderedText = content;
        },
      });
    }
    if (tasksText !== state.renderedTasksText) {
      updates.push({
        elementId: 'streaming_tasks',
        content: tasksText,
        onSuccess: () => {
          state.renderedTasksText = tasksText;
        },
      });
    }
    if (toolsText !== state.renderedToolsText) {
      updates.push({
        elementId: 'streaming_tools',
        content: toolsText,
        onSuccess: () => {
          state.renderedToolsText = toolsText;
        },
      });
    }
    if (statusText !== state.renderedStatusText) {
      updates.push({
        elementId: 'streaming_status',
        content: statusText,
        onSuccess: () => {
          state.renderedStatusText = statusText;
        },
      });
    }
    if (updates.length === 0) return;

    const cardId = state.cardId;
    for (const update of updates) {
      state.sequence++;
      try {
        await this.withFeishuRequestTimeout(streamKey, `cardElement.content:${update.elementId}`, () => cardkit.cardElement.content({
          path: { card_id: cardId, element_id: update.elementId },
          data: { content: update.content, sequence: state.sequence },
        }));
        update.onSuccess();
        this.markCardFlushSuccess(state);
      } catch (err) {
        this.markCardFlushFailure(state, err);
        console.warn(
          `[feishu-adapter] cardElement.content failed for ${update.elementId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Update tool progress in the streaming card.
   */
  private updateToolProgress(chatId: string, tools: ToolCallInfo[], streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    state.toolCalls = tools;
    this.scheduleCardFlush(cardKey);
  }

  private async awaitCardFlushCompletion(
    streamKey: string,
    timeoutMs = this.getCardRequestTimeoutMs() + Math.max(0, this.cardFinalizeFlushWaitExtraMs),
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const state = this.activeCards.get(streamKey);
      if (!state) return true;
      const inFlight = state.flushInFlight;
      if (inFlight) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return false;
        const timedOut = Symbol('flush-timeout');
        let flushTimeout: ReturnType<typeof setTimeout> | null = null;
        try {
          const result = await Promise.race([
            inFlight.then(() => null),
            new Promise<typeof timedOut>((resolve) => {
              flushTimeout = setTimeout(() => resolve(timedOut), remainingMs);
            }),
          ]);
          if (result === timedOut) return false;
        } catch {
          // best effort only
        } finally {
          if (flushTimeout) clearTimeout(flushTimeout);
        }
        continue;
      }
      if (Date.now() >= deadline) return false;
      if (state.flushQueued) {
        state.flushQueued = false;
        this.enqueueCardFlush(streamKey);
        continue;
      }
      return true;
    }
  }

  /**
   * Finalize the streaming card: close streaming mode, update with final content + footer.
   */
  private async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    const pending = this.cardCreatePromises.get(cardKey);
    if (pending) {
      try { await pending; } catch { /* creation failed — no card to finalize */ }
    }

    const existingRequest = this.pendingCardFinalizations.get(cardKey);
    if (existingRequest?.retryTimer) {
      clearTimeout(existingRequest.retryTimer);
    }
    const request: FeishuCardFinalizationRequest = existingRequest || {
      chatId,
      status,
      responseText,
      streamKey,
      retryIndex: 0,
      retryTimer: null,
    };
    request.chatId = chatId;
    request.status = status;
    request.responseText = responseText;
    request.streamKey = streamKey;
    request.retryTimer = null;
    this.pendingCardFinalizations.set(cardKey, request);

    const result = await this.runCardFinalizationAttempt(cardKey);
    if (!result.finalized) {
      if (result.retryable) {
        this.scheduleCardFinalizationRetry(cardKey);
      } else {
        this.clearPendingCardFinalization(cardKey);
      }
    }
    return result.finalized && result.textCovered;
  }

  private async runCardFinalizationAttempt(
    cardKey: string,
  ): Promise<FeishuCardFinalizationAttemptResult> {
    const existing = this.cardFinalizePromises.get(cardKey);
    if (existing) return existing;

    const attempt = this.performCardFinalizationAttempt(cardKey);
    this.cardFinalizePromises.set(cardKey, attempt);
    try {
      return await attempt;
    } finally {
      if (this.cardFinalizePromises.get(cardKey) === attempt) {
        this.cardFinalizePromises.delete(cardKey);
      }
    }
  }

  private async performCardFinalizationAttempt(
    cardKey: string,
  ): Promise<FeishuCardFinalizationAttemptResult> {
    const request = this.pendingCardFinalizations.get(cardKey);
    const state = this.activeCards.get(cardKey);
    if (!request || !state) {
      return { finalized: false, textCovered: false, retryable: false };
    }
    if (!this.restClient) {
      return { finalized: false, textCovered: false, retryable: !this.stopping };
    }
    const cardkit = (this.restClient as any).cardkit?.v1;
    if (!cardkit?.card?.settings || !cardkit?.card?.update) {
      return { finalized: false, textCovered: false, retryable: false };
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    const flushed = await this.awaitCardFlushCompletion(cardKey);
    if (!flushed) {
      console.warn(`[feishu-adapter] Card finalize proceeding after flush wait timeout: streamKey=${cardKey}`);
      state.flushInFlight = null;
      state.flushQueued = false;
    }

    try {
      state.sequence++;
      await this.withFeishuRequestTimeout(cardKey, 'card.settings', () => cardkit.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: state.sequence,
        },
      }));

      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer = {
        status: statusLabels[request.status] || request.status,
        elapsed: formatElapsed(elapsedMs),
      };

      const existingText = state.pendingText || '';
      const trimmedExisting = existingText.trim();
      const trimmedResponse = request.responseText.trim();
      let finalText = trimmedResponse || trimmedExisting;
      if (
        request.status === 'interrupted'
        && trimmedExisting
        && trimmedResponse
        && trimmedResponse !== trimmedExisting
        && !trimmedExisting.includes(trimmedResponse)
      ) {
        finalText = `${trimmedExisting}\n\n${trimmedResponse}`;
      }

      const deliverTextSeparately = shouldDeliverFinalTextSeparately(finalText);
      const cardText = deliverTextSeparately ? buildFinalCardTextPreview(finalText) : finalText;
      const finalCardJson = buildFinalCardJson(cardText, state.taskItems, state.toolCalls, footer, request.status);

      state.sequence++;
      await this.withFeishuRequestTimeout(cardKey, 'card.update', () => cardkit.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: finalCardJson },
          sequence: state.sequence,
        },
      }));

      this.activeCards.delete(cardKey);
      this.clearPendingCardFinalization(cardKey);
      console.log(`[feishu-adapter] Card finalized: streamKey=${cardKey}, cardId=${state.cardId}, status=${request.status}, elapsed=${formatElapsed(elapsedMs)}`);

      const terminalReactionEmoji = request.status === 'completed'
        ? COMPLETED_EMOJI
        : request.status === 'error'
          ? ERROR_EMOJI
          : null;
      if (terminalReactionEmoji && this.hasTerminalReactionApi()) {
        await this.waitBeforeTerminalReaction();
        await this.addTerminalReaction(cardKey, state.messageId, terminalReactionEmoji);
      }

      return { finalized: true, textCovered: !deliverTextSeparately, retryable: false };
    } catch (err) {
      console.warn('[feishu-adapter] Card finalize failed:', err instanceof Error ? err.message : err);
      return { finalized: false, textCovered: false, retryable: true };
    }
  }

  private scheduleCardFinalizationRetry(cardKey: string): void {
    const request = this.pendingCardFinalizations.get(cardKey);
    if (!request || request.retryTimer || this.stopping || !this.restClient) return;

    if (request.retryIndex >= this.cardFinalizeRetryDelaysMs.length) {
      console.warn(`[feishu-adapter] Card finalize retries exhausted: streamKey=${cardKey}`);
      this.cleanupCard(request.chatId, request.streamKey || cardKey);
      return;
    }

    const delayMs = Math.max(0, this.cardFinalizeRetryDelaysMs[request.retryIndex] || 0);
    request.retryIndex += 1;
    request.retryTimer = setTimeout(() => {
      const current = this.pendingCardFinalizations.get(cardKey);
      if (!current) return;
      current.retryTimer = null;
      void this.runCardFinalizationAttempt(cardKey).then((result) => {
        if (result.finalized) return;
        if (result.retryable) {
          this.scheduleCardFinalizationRetry(cardKey);
        } else {
          this.cleanupCard(current.chatId, current.streamKey || cardKey);
        }
      }).catch((error) => {
        console.warn('[feishu-adapter] Card finalize retry failed:', error instanceof Error ? error.message : error);
        this.scheduleCardFinalizationRetry(cardKey);
      });
    }, delayMs);
    request.retryTimer.unref?.();
  }

  private clearPendingCardFinalization(cardKey: string): void {
    const request = this.pendingCardFinalizations.get(cardKey);
    if (request?.retryTimer) clearTimeout(request.retryTimer);
    this.pendingCardFinalizations.delete(cardKey);
  }

  private hasTerminalReactionApi(): boolean {
    const messageReaction = (this.restClient as any)?.im?.messageReaction;
    return typeof messageReaction?.create === 'function';
  }

  private async waitBeforeTerminalReaction(): Promise<void> {
    const delayMs = Math.max(0, this.cardTerminalReactionDelayMs);
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private async addTerminalReaction(streamKey: string, messageId: string, emojiType: string): Promise<void> {
    const messageReaction = (this.restClient as any)?.im?.messageReaction;
    if (typeof messageReaction?.create !== 'function') return;

    try {
      await this.withFeishuRequestTimeout(streamKey, `im.messageReaction.create:${emojiType}`, () => messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }));
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Terminal reaction failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Clean up card state without finalizing (e.g. on unexpected errors).
   */
  private cleanupCard(chatId: string, streamKey?: string): void {
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    this.cardCreatePromises.delete(cardKey);
    this.clearPendingCardFinalization(cardKey);
    const state = this.activeCards.get(cardKey);
    if (!state) return;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }
    this.activeCards.delete(cardKey);
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string, streamKey?: string): boolean {
    return this.activeCards.has(this.resolveStreamKey(chatId, streamKey));
  }

  hasActiveStreamingUi(chatId: string, streamKey?: string): boolean {
    return this.hasActiveCard(chatId, streamKey);
  }

  getStructuredStreamingUiSnapshot(chatId: string, streamKey?: string): StructuredStreamingUiSnapshot | null {
    const state = this.activeCards.get(this.resolveStreamKey(chatId, streamKey));
    if (!state) return null;
    return {
      active: true,
      lastAttemptAt: state.lastFlushStartedAt,
      lastUpdateAt: state.lastSuccessfulFlushAt ?? (state.lastUpdateAt > 0 ? state.lastUpdateAt : null),
      lastErrorAt: state.lastFlushErrorAt,
      lastError: state.lastFlushError,
      flushInFlight: Boolean(state.flushInFlight),
      flushInFlightSince: state.flushInFlight ? state.lastFlushStartedAt : null,
      consecutiveFailures: state.consecutiveFlushFailures,
    };
  }

  private shouldFullRefreshCard(state: FeishuCardState, now: number): boolean {
    const interval = Math.max(0, this.cardFullRefreshIntervalMs);
    if (interval <= 0) return false;
    if (!Number.isFinite(now)) return false;
    return now - state.lastFullRefreshAttemptAt >= interval;
  }

  private async flushFullCardRefresh(
    streamKey: string,
    state: FeishuCardState,
    content: string,
    tasksText: string,
    toolsText: string,
    statusText: string,
  ): Promise<boolean> {
    state.lastFullRefreshAttemptAt = Date.now();
    const cardkit = (this.restClient as any)?.cardkit?.v1;
    if (!cardkit?.card?.update) return false;

    try {
      state.sequence++;
      await this.withFeishuRequestTimeout(streamKey, 'card.update:streaming_refresh', () => cardkit.card.update({
        path: { card_id: state.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(buildStreamingCardBody(content, tasksText, toolsText, statusText)),
          },
          sequence: state.sequence,
        },
      }));
      state.renderedText = content;
      state.renderedTasksText = tasksText;
      state.renderedToolsText = toolsText;
      state.renderedStatusText = statusText;
      state.lastSuccessfulFullRefreshAt = Date.now();
      this.markCardFlushSuccess(state);
      return true;
    } catch (err) {
      this.markCardFlushFailure(state, err);
      console.warn(
        '[feishu-adapter] card.update streaming refresh failed:',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private getCardRequestTimeoutMs(): number {
    return Math.max(1, this.cardRequestTimeoutMs);
  }

  private logRequestOperation(
    phase: 'start' | 'success' | 'timeout' | 'error',
    scope: string,
    target: string,
    startedAt: number,
    detail?: string,
  ): void {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const suffix = detail ? `, detail=${detail}` : '';
    const line = `[feishu-adapter] Request ${phase}: scope=${scope}, target=${target}, duration=${durationMs}ms${suffix}`;
    if (phase === 'start' || phase === 'success') {
      console.log(line);
      return;
    }
    console.warn(line);
  }

  private async withFeishuRequestTimeout<T>(
    scope: string,
    target: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const timeoutMs = this.getCardRequestTimeoutMs();
    this.logRequestOperation('start', scope, target, startedAt);

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const operationPromise = operation();
    operationPromise.catch(() => {
      // Promise.race may already reject on timeout; keep late failures handled.
    });

    try {
      const result = await Promise.race([operationPromise, timeoutPromise]);
      this.logRequestOperation('success', scope, target, startedAt);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logRequestOperation(
        detail.startsWith('timeout after ') ? 'timeout' : 'error',
        scope,
        target,
        startedAt,
        detail,
      );
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private markCardFlushFailure(state: FeishuCardState, error: unknown): void {
    state.lastFlushErrorAt = Date.now();
    state.lastFlushError = error instanceof Error ? error.message : String(error);
    state.consecutiveFlushFailures += 1;
  }

  private markCardFlushSuccess(state: FeishuCardState): void {
    const now = Date.now();
    state.lastUpdateAt = now;
    state.lastSuccessfulFlushAt = now;
    state.lastFlushError = null;
    state.consecutiveFlushFailures = 0;
  }

  // ── Streaming adapter interface ────────────────────────────────

  /**
   * Called by bridge-manager on each text SSE event.
   * Creates streaming card on first call, then updates content.
   */
  onStreamText(chatId: string, fullText: string, streamKey?: string): void {
    if (!this.isStreamingEnabled()) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      // Card should have been created by onMessageStart, but create lazily if not
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText, cardKey);
  }

  onMirrorStreamStart(chatId: string, streamKey?: string): void {
    if (!this.isStreamingEnabled()) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (this.activeCards.has(cardKey)) return;
    this.createStreamingCard(chatId, undefined, cardKey).catch(() => {});
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[], streamKey?: string): void {
    if (!this.isStreamingEnabled()) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateToolProgress(chatId, tools, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateToolProgress(chatId, tools, streamKey);
  }

  onTaskEvent(chatId: string, tasks: TaskProgressInfo[], streamKey?: string): void {
    if (!this.isStreamingEnabled()) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateTaskProgress(chatId, tasks, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateTaskProgress(chatId, tasks, streamKey);
  }

  onStreamStatus(chatId: string, statusText: string, streamKey?: string): void {
    if (!this.isStreamingEnabled()) return;
    const cardKey = this.resolveStreamKey(chatId, streamKey);
    if (!this.activeCards.has(cardKey)) {
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId, cardKey).then((ok) => {
        if (ok) this.updateCardStatus(chatId, statusText, cardKey);
      }).catch(() => {});
      return;
    }
    this.updateCardStatus(chatId, statusText, cardKey);
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    if (!this.isStreamingEnabled()) return false;
    return this.finalizeCard(chatId, status, responseText, streamKey);
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (message.attachments && message.attachments.length > 0) {
      return this.sendAttachments(message.address.chatId, message.attachments, message.replyToMessageId);
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown before converting it to Feishu post content.
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    if (message.parseMode === 'plain') {
      return this.sendAsPlainText(message.address.chatId, text);
    }

    // Rendering strategy (aligned with Openclaw):
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (md tag)
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(message.address.chatId, text);
    }
    return this.sendAsPost(message.address.chatId, text);
  }

  private getOpenApiBaseUrl(): string {
    return feishuSiteToApiBaseUrl(this.site);
  }

  private async getTenantAccessToken(): Promise<string> {
    const appId = this.appId;
    const appSecret = this.appSecret;
    const domain = this.getOpenApiBaseUrl();
    if (!appId || !appSecret) {
      throw new Error('Feishu App ID / App Secret not configured');
    }

    const now = Date.now();
    if (
      this.tenantTokenCache
      && this.tenantTokenCache.appId === appId
      && this.tenantTokenCache.appSecret === appSecret
      && this.tenantTokenCache.domain === domain
      && this.tenantTokenCache.expiresAt > now + 60_000
    ) {
      return this.tenantTokenCache.token;
    }

    const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
      signal: AbortSignal.timeout(CARD_REQUEST_TIMEOUT_MS),
    });
    const data = await response.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
      throw new Error(data.msg || `tenant_access_token failed: HTTP ${response.status}`);
    }

    this.tenantTokenCache = {
      token: data.tenant_access_token,
      expiresAt: now + Math.max(60, Number(data.expire || 7200)) * 1000,
      appId,
      appSecret,
      domain,
    };
    return data.tenant_access_token;
  }

  private async sendAttachments(
    chatId: string,
    attachments: OutboundAttachment[],
    replyToMessageId?: string,
  ): Promise<SendResult> {
    let lastMessageId: string | undefined;

    for (const attachment of attachments) {
      const result = await this.sendAttachment(chatId, attachment, replyToMessageId);
      if (!result.ok) return result;
      lastMessageId = result.messageId;
    }

    return { ok: true, messageId: lastMessageId };
  }

  private async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const validationError = validateFeishuAttachmentPath(attachment.path);
    if (validationError) return { ok: false, error: validationError };

    try {
      if (attachment.kind === 'image') {
        const imageKey = await this.uploadImage(attachment);
        return await this.sendStructuredMessage(
          chatId,
          'image',
          JSON.stringify({ image_key: imageKey }),
          replyToMessageId,
        );
      }

      const fileKey = await this.uploadFile(attachment);
      return await this.sendStructuredMessage(
        chatId,
        'file',
        JSON.stringify({ file_key: fileKey }),
        replyToMessageId,
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Attachment send failed' };
    }
  }

  private async uploadImage(attachment: OutboundAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const fileName = normalizeAttachmentFileName(
      attachment.name || path.basename(attachment.path) || 'image.png',
    );
    const form = new FormData();
    form.set('image_type', 'message');
    form.set('image', new Blob([await fs.promises.readFile(attachment.path)]), fileName);

    const response = await fetch(`${this.getOpenApiBaseUrl()}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(ATTACHMENT_REQUEST_TIMEOUT_MS),
    });
    const data = await response.json() as {
      code?: number;
      msg?: string;
      data?: { image_key?: string };
    };
    if (!response.ok || data.code !== 0 || !data.data?.image_key) {
      throw new Error(data.msg || `image upload failed: HTTP ${response.status}`);
    }
    return data.data.image_key;
  }

  private async uploadFile(attachment: OutboundAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const fileName = normalizeAttachmentFileName(
      attachment.name || path.basename(attachment.path) || 'attachment.bin',
    );
    const form = new FormData();
    form.set('file_type', 'stream');
    form.set('file_name', fileName);
    form.set('file', new Blob([await fs.promises.readFile(attachment.path)]), fileName);

    const response = await fetch(`${this.getOpenApiBaseUrl()}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(ATTACHMENT_REQUEST_TIMEOUT_MS),
    });
    const data = await response.json() as {
      code?: number;
      msg?: string;
      data?: { file_key?: string };
    };
    if (!response.ok || data.code !== 0 || !data.data?.file_key) {
      throw new Error(data.msg || `file upload failed: HTTP ${response.status}`);
    }
    return data.data.file_key;
  }

  private async sendStructuredMessage(
    chatId: string,
    msgType: 'image' | 'file',
    content: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    try {
      const res = replyToMessageId
        ? await this.withFeishuRequestTimeout(chatId, `im.message.reply:${msgType}`, () => this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: msgType, content },
        }))
        : await this.withFeishuRequestTimeout(chatId, `im.message.create:${msgType}`, () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content,
          },
        }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || `${msgType} send failed` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `${msgType} send failed` };
    }
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:interactive-card', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:post', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        },
      }));

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    return this.sendAsPlainText(chatId, text);
  }

  private async sendAsPlainText(chatId: string, text: string): Promise<SendResult> {
    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:text', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      }));
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardAction().
   * Falls back to text-based /perm commands if button card fails.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Convert HTML text from permission-broker to Feishu markdown.
    // permission-broker sends HTML (<b>, <code>, <pre>, &amp; entities)
    // but Feishu card markdown elements don't understand HTML.
    const mdText = text
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extract permissionRequestId from the first button's callback data
    const firstBtn = inlineButtons.flat()[0];
    const permId = firstBtn?.callbackData?.startsWith('perm:')
      ? firstBtn.callbackData.split(':').slice(2).join(':')
      : '';

    if (permId) {
      // Use real card action buttons
      const cardJson = buildPermissionButtonCard(mdText, permId, chatId);

      try {
        const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:permission-button-card', () => this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
          },
        }));
        if (res?.data?.message_id) {
          return { ok: true, messageId: res.data.message_id };
        }
        console.warn('[feishu-adapter] Permission button card send failed:', JSON.stringify({ code: (res as any)?.code, msg: res?.msg }));
      } catch (err) {
        console.warn('[feishu-adapter] Permission button card error, falling back to text:', err instanceof Error ? err.message : err);
      }
    }

    // Fallback: text-based permission commands (same as before, for backward compat)
    const permCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const id = parts.slice(2).join(':');
        return `\`/perm ${action} ${id}\``;
      }
      return btn.text;
    });

    const cardContent = [
      mdText,
      '',
      '---',
      '**Reply:**',
      '`1` - Allow once',
      '`2` - Allow session',
      '`3` - Deny',
      '',
      'Or use full commands:',
      ...permCommands,
    ].join('\n');

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: cardContent },
        ],
      },
    });

    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:permission-fallback-card', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      }));
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Fallback card also failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Fallback card error, sending plain text:', err instanceof Error ? err.message : err);
    }

    // Last resort: plain text message (works even without card permissions)
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
      '',
      ...permCommands,
    ].join('\n');

    try {
      const res = await this.withFeishuRequestTimeout(chatId, 'im.message.create:permission-fallback-text', () => this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: plainText }),
        },
      }));
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const appId = this.appId;
    if (!appId) return 'Feishu App ID 未配置';

    const appSecret = this.appSecret;
    if (!appSecret) return 'Feishu App Secret 未配置';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = (this.channelConfig.allowedUsers || []).join(',');
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: this.channelType,
            channelProvider: this.provider,
            channelAlias: this.alias,
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const fileKey = this.extractFileKey(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: this.channelType,
              channelProvider: this.provider,
              channelAlias: this.alias,
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: this.channelType,
              channelProvider: this.provider,
              channelAlias: this.alias,
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) {
          attachments.push(attachment);
        }
        // Don't add fallback text for individual post images — the text already carries context
      }
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: this.channelType,
      channelProvider: this.provider,
      channelAlias: this.alias,
      chatId,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueueInboundMessage(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: this.channelType,
        channelProvider: this.provider,
        channelAlias: this.alias,
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueueInboundMessage(inbound);
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', (instance) => new FeishuAdapter(instance));
