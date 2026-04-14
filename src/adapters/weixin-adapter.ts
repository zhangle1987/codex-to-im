import type {
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../lib/bridge/types.js';
import type { WeixinChannelConfig } from '../config.js';
import { BaseChannelAdapter, registerAdapterFactory, type AdapterRuntimeInstance } from '../lib/bridge/channel-adapter.js';
import { getBridgeContext } from '../lib/bridge/context.js';
import {
  getWeixinAccount,
  getWeixinContextToken,
  listWeixinAccounts,
  upsertWeixinContextToken,
} from '../weixin-store.js';
import { getConfig, getUpdates, sendTextMessage, sendTyping } from './weixin/weixin-api.js';
import { decodeWeixinChatId, encodeWeixinChatId } from './weixin/weixin-ids.js';
import { downloadMediaFromItem } from './weixin/weixin-media.js';
import { clearAllPauses, isPaused, setPaused } from './weixin/weixin-session-guard.js';
import type {
  GetUpdatesResponse,
  WeixinCredentials,
  WeixinMessage,
} from './weixin/weixin-types.js';
import { markdownToPlainText } from '../lib/bridge/markdown/plain.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  ERRCODE_SESSION_EXPIRED,
  MessageItemType,
  TypingStatus,
} from './weixin/weixin-types.js';

const DEDUP_MAX = 500;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export class WeixinAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType;
  readonly provider = 'weixin';
  readonly alias?: string;
  private readonly channelConfig: WeixinChannelConfig;

  private _running = false;
  private idleLogged = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private pollAborts = new Map<string, AbortController>();
  private workerSignatures = new Map<string, string>();
  private seenMessageIds = new Map<string, Set<string>>();
  private consecutiveFailures = new Map<string, number>();
  private typingTickets = new Map<string, string>();
  private pendingCursors = new Map<number, {
    offsetKey: string;
    cursor: string;
    remaining: number;
    sealed: boolean;
  }>();
  private nextBatchId = 1;

  constructor(instance?: AdapterRuntimeInstance) {
    super();
    this.channelType = instance?.id || 'weixin';
    this.alias = instance?.alias;
    this.channelConfig = (instance?.config || {}) as WeixinChannelConfig;
  }

  private get mediaEnabled(): boolean {
    return this.channelConfig.mediaEnabled === true;
  }

  private get configuredAccountId(): string | undefined {
    const value = this.channelConfig.accountId?.trim();
    return value || undefined;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.idleLogged = false;
    clearAllPauses();

    await this.reconcileAccounts();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAccounts().catch((error) => {
        console.warn(
          '[weixin-adapter] Failed to reconcile linked accounts:',
          error instanceof Error ? error.message : error,
        );
      });
    }, 10_000);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    for (const accountId of this.pollAborts.keys()) {
      this.stopAccountWorker(accountId);
    }
    this.pendingCursors.clear();
    this.clearInboundQueue();
    this.rejectPendingInboundConsumers();

    console.log('[weixin-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.consumeInboundMessage(this._running);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const decoded = decodeWeixinChatId(message.address.chatId);
      if (!decoded) {
        return { ok: false, error: 'Invalid WeChat chatId format' };
      }

      const { accountId, peerUserId } = decoded;
      const account = getWeixinAccount(accountId);
      if (!account) {
        return { ok: false, error: `Linked WeChat account ${accountId} not found` };
      }

      const contextToken = getWeixinContextToken(accountId, peerUserId);
      if (!contextToken) {
        return { ok: false, error: `No context token for peer ${peerUserId} on account ${accountId}` };
      }

      const content = stripFormatting(message.text, message.parseMode);
      const { clientId } = await sendTextMessage(
        this.accountToCreds(account),
        peerUserId,
        content,
        contextToken,
      );

      return { ok: true, messageId: clientId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  validateConfig(): string | null {
    const configuredAccountId = this.configuredAccountId;
    const accounts = listWeixinAccounts();
    const enabledAccounts = accounts.filter((account) => account.enabled && account.token);

    if (configuredAccountId) {
      const configured = getWeixinAccount(configuredAccountId);
      if (!configured) {
        return `Linked WeChat account ${configuredAccountId} not found`;
      }
      if (!configured.enabled || !configured.token) {
        return `Linked WeChat account ${configuredAccountId} is disabled or missing token`;
      }
      return null;
    }

    if (enabledAccounts.length > 1) {
      return 'Multiple linked WeChat accounts detected. Please select a WeChat account for this channel.';
    }

    return null;
  }

  isAuthorized(_userId: string, _chatId: string): boolean {
    return true;
  }

  acknowledgeUpdate(updateId: number): void {
    const batch = this.pendingCursors.get(updateId);
    if (!batch) return;
    batch.remaining = Math.max(0, batch.remaining - 1);
    this.maybeCommitPendingCursor(updateId);
  }

  onMessageStart(chatId: string): void {
    this.sendTypingIndicator(chatId, TypingStatus.TYPING).catch(() => {});
  }

  onMessageEnd(chatId: string): void {
    this.sendTypingIndicator(chatId, TypingStatus.CANCEL).catch(() => {});
  }

  private async reconcileAccounts(): Promise<void> {
    const linkedAccounts = this.filterConfiguredAccounts(
      listWeixinAccounts().filter((account) => account.enabled && account.token),
    );
    if (linkedAccounts.length === 0 && this.pollAborts.size === 0) {
      if (!this.idleLogged) {
        console.log('[weixin-adapter] No linked WeChat account is enabled, adapter started but idle');
        this.idleLogged = true;
      }
    } else {
      this.idleLogged = false;
    }

    const activeAccountIds = new Set(this.pollAborts.keys());
    const nextAccountIds = new Set(linkedAccounts.map((account) => account.accountId));

    for (const account of linkedAccounts) {
      const creds = this.accountToCreds(account);
      const signature = this.accountSignature(account);
      const existingSignature = this.workerSignatures.get(account.accountId);

      if (!activeAccountIds.has(account.accountId)) {
        this.startAccountWorker(account.accountId, creds);
        this.workerSignatures.set(account.accountId, signature);
        console.log(`[weixin-adapter] Linked account ${account.accountId} is now active`);
        continue;
      }

      if (existingSignature !== signature) {
        this.stopAccountWorker(account.accountId);
        this.startAccountWorker(account.accountId, creds);
        this.workerSignatures.set(account.accountId, signature);
        console.log(`[weixin-adapter] Refreshed linked account ${account.accountId}`);
      }
    }

    for (const accountId of activeAccountIds) {
      if (nextAccountIds.has(accountId)) continue;
      this.stopAccountWorker(accountId);
      console.log(`[weixin-adapter] Linked account ${accountId} was removed or disabled`);
    }
  }

  private startAccountWorker(accountId: string, creds: WeixinCredentials): void {
    const controller = new AbortController();
    this.pollAborts.set(accountId, controller);
    this.seenMessageIds.set(accountId, new Set());
    this.consecutiveFailures.set(accountId, 0);
    void this.runPollLoop(accountId, creds, controller.signal);
  }

  private stopAccountWorker(accountId: string): void {
    this.pollAborts.get(accountId)?.abort();
    this.pollAborts.delete(accountId);
    this.workerSignatures.delete(accountId);
    this.seenMessageIds.delete(accountId);
    this.consecutiveFailures.delete(accountId);
    for (const key of Array.from(this.typingTickets.keys())) {
      if (key.startsWith(`${accountId}:`)) {
        this.typingTickets.delete(key);
      }
    }
  }

  private async runPollLoop(accountId: string, creds: WeixinCredentials, signal: AbortSignal): Promise<void> {
    console.log(`[weixin-adapter] Poll loop started for account ${accountId}`);

    while (this._running && !signal.aborted) {
      if (isPaused(accountId)) {
        await this.sleep(10_000, signal);
        continue;
      }

      try {
        const { store } = getBridgeContext();
        const offsetKey = `weixin:${accountId}`;
        const rawOffset = store.getChannelOffset(offsetKey);
        const cursor = rawOffset === '0' ? '' : rawOffset;
        const response: GetUpdatesResponse = await getUpdates(creds, cursor);

        if (response.errcode === ERRCODE_SESSION_EXPIRED) {
          setPaused(accountId, 'Session expired (errcode -14)');
          console.warn(`[weixin-adapter] Account ${accountId} session expired, pausing`);
          continue;
        }
        if (response.errcode && response.errcode !== 0) {
          throw new Error(`API error: ${response.errcode} ${response.errmsg || ''}`.trim());
        }

        let batchId: number | undefined;
        let batchCompleted = false;

        if (response.msgs && response.msgs.length > 0 && response.get_updates_buf) {
          batchId = this.nextBatchId++;
          this.pendingCursors.set(batchId, {
            offsetKey,
            cursor: response.get_updates_buf,
            remaining: 0,
            sealed: false,
          });

          for (const message of response.msgs) {
            await this.processMessage(accountId, message, batchId);
          }
          batchCompleted = true;
        } else if (response.msgs && response.msgs.length > 0) {
          for (const message of response.msgs) {
            await this.processMessage(accountId, message);
          }
        }

        if (batchId !== undefined && response.get_updates_buf) {
          const batch = this.pendingCursors.get(batchId);
          if (batchCompleted && batch) {
            batch.sealed = true;
            this.maybeCommitPendingCursor(batchId);
          } else if (!batchCompleted) {
            this.pendingCursors.delete(batchId);
          }
        }

        this.consecutiveFailures.set(accountId, 0);
      } catch (err) {
        if (signal.aborted) break;

        const failures = (this.consecutiveFailures.get(accountId) || 0) + 1;
        this.consecutiveFailures.set(accountId, failures);
        const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);

        console.error(
          `[weixin-adapter] Poll error for ${accountId} (failure ${failures}):`,
          err instanceof Error ? err.message : err,
        );
        await this.sleep(backoff, signal);
      }
    }

    console.log(`[weixin-adapter] Poll loop ended for account ${accountId}`);
  }

  private async processMessage(accountId: string, message: WeixinMessage, batchId?: number): Promise<void> {
    if (!message.from_user_id) return;

    const messageKey = message.message_id || `seq_${message.seq}`;
    const seenIds = this.seenMessageIds.get(accountId);
    if (seenIds?.has(messageKey)) {
      return;
    }

    seenIds?.add(messageKey);
    if (seenIds && seenIds.size > DEDUP_MAX) {
      const overflow = Array.from(seenIds).slice(0, seenIds.size - DEDUP_MAX);
      for (const staleKey of overflow) {
        seenIds.delete(staleKey);
      }
    }

    if (message.context_token) {
      upsertWeixinContextToken(accountId, message.from_user_id, message.context_token);
    }

    let text = '';
    const attachments: FileAttachment[] = [];
    let failedCount = 0;
    let missingVoiceTranscriptCount = 0;
    const mediaEnabled = this.mediaEnabled;
    const account = mediaEnabled ? getWeixinAccount(accountId) : undefined;
    const creds = account ? this.accountToCreds(account) : undefined;

    for (const item of message.item_list || []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        text += item.text_item.text;
        continue;
      }

      if (item.type === MessageItemType.VOICE) {
        const transcript = item.voice_item?.text?.trim();
        if (transcript) {
          text = text.trim() ? `${text}\n${transcript}` : transcript;
        } else {
          missingVoiceTranscriptCount++;
        }
        continue;
      }

      if (!mediaEnabled || !creds) {
        continue;
      }

      try {
        const attachment = await downloadMediaFromItem(item, creds.cdnBaseUrl);
        if (attachment) {
          attachments.push(attachment);
        }
      } catch (err) {
        failedCount++;
        console.warn(
          `[weixin-adapter] Failed to download media for ${accountId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (message.ref_message) {
      const quoted: string[] = [];
      if (message.ref_message.title) quoted.push(message.ref_message.title);
      if (message.ref_message.content) quoted.push(message.ref_message.content);
      if (quoted.length > 0) {
        text = `[引用: ${quoted.join(' | ')}]\n${text}`;
      }
    }

    if (failedCount > 0) {
      const failureNote = `[${failedCount} attachment(s) failed to download]`;
      text = text.trim() ? `${text}\n${failureNote}` : (attachments.length > 0 ? failureNote : text);
    }

    const chatId = encodeWeixinChatId(accountId, message.from_user_id);
    const inbound: InboundMessage = {
      messageId: message.message_id || `weixin_${accountId}_${message.seq || Date.now()}`,
      address: {
        channelType: this.channelType,
        channelProvider: this.provider,
        channelAlias: this.alias,
        chatId,
        userId: message.from_user_id,
        displayName: message.from_user_id.slice(0, 12),
      },
      text: text.trim(),
      timestamp: message.create_time ? message.create_time * 1000 : Date.now(),
      raw: failedCount > 0 && attachments.length === 0 && !text.trim()
        ? {
            accountId,
            originalMessage: message,
            attachmentDownloadFailed: true,
            failedCount,
            failedLabel: 'attachment(s)',
          }
        : missingVoiceTranscriptCount > 0 && attachments.length === 0 && !text.trim()
          ? {
              accountId,
              originalMessage: message,
              userVisibleError: 'WeChat did not provide speech-to-text for this voice message. Please enable WeChat voice transcription and send it again.',
            }
          : { accountId, originalMessage: message },
      updateId: batchId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    if (!inbound.text && attachments.length === 0 && failedCount === 0 && missingVoiceTranscriptCount === 0) {
      return;
    }

    if (batchId !== undefined) {
      const batch = this.pendingCursors.get(batchId);
      if (batch) batch.remaining++;
    }
    this.enqueueInboundMessage(inbound);

    const summary = attachments.length > 0
      ? `[${attachments.length} attachment(s)] ${inbound.text.slice(0, 150)}`
      : missingVoiceTranscriptCount > 0 && !inbound.text
        ? '[voice transcription unavailable]'
      : failedCount > 0 && !inbound.text
        ? `[${failedCount} attachment(s) failed]`
        : inbound.text.slice(0, 200);
    getBridgeContext().store.insertAuditLog({
      channelType: this.channelType,
      channelProvider: this.provider,
      channelAlias: this.alias,
      chatId,
      direction: 'inbound',
      messageId: inbound.messageId,
      summary,
    });
  }

  private async sendTypingIndicator(chatId: string, status: number): Promise<void> {
    const decoded = decodeWeixinChatId(chatId);
    if (!decoded) return;

    const { accountId, peerUserId } = decoded;
    const account = getWeixinAccount(accountId);
    if (!account) return;

    const contextToken = getWeixinContextToken(accountId, peerUserId);
    if (!contextToken) return;

    const creds = this.accountToCreds(account);
    const ticketKey = `${accountId}:${peerUserId}`;
    let typingTicket = this.typingTickets.get(ticketKey);
    if (!typingTicket) {
      const config = await getConfig(creds, peerUserId, contextToken);
      if (!config.typing_ticket) return;
      typingTicket = config.typing_ticket;
      this.typingTickets.set(ticketKey, typingTicket);
    }

    await sendTyping(creds, peerUserId, typingTicket, status);
  }

  private accountToCreds(account: {
    accountId: string;
    token: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
  }): WeixinCredentials {
    return {
      botToken: account.token,
      ilinkBotId: account.accountId,
      baseUrl: account.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
    };
  }

  private accountSignature(account: {
    accountId: string;
    token: string;
    baseUrl?: string;
    cdnBaseUrl?: string;
  }): string {
    return JSON.stringify({
      accountId: account.accountId,
      token: account.token,
      baseUrl: account.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
    });
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private maybeCommitPendingCursor(updateId: number): void {
    const batch = this.pendingCursors.get(updateId);
    if (!batch || !batch.sealed || batch.remaining > 0) {
      return;
    }
    getBridgeContext().store.setChannelOffset(batch.offsetKey, batch.cursor);
    this.pendingCursors.delete(updateId);
  }

  private filterConfiguredAccounts(accounts: ReturnType<typeof listWeixinAccounts>) {
    if (!this.configuredAccountId) return accounts;
    return accounts.filter((account) => account.accountId === this.configuredAccountId);
  }
}

function stripFormatting(text: string, parseMode?: 'HTML' | 'Markdown' | 'plain'): string {
  if (parseMode === 'HTML') {
    return text.replace(/<[^>]+>/g, '');
  }
  if (parseMode === 'Markdown') {
    return markdownToPlainText(text);
  }
  return text;
}

registerAdapterFactory('weixin', (instance) => new WeixinAdapter(instance));
