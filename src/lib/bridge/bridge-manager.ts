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
  ChannelAddress,
  ChannelBinding,
  InboundMessage,
  OutboundAttachment,
  OutboundMessage,
  SendResult,
  StreamingPreviewState,
  ToolCallInfo,
} from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { AdapterRuntimeInstance, BaseChannelAdapter } from './channel-adapter.js';
import type { BridgeMessage, BridgeSession, LLMProvider, PermissionLinkRecord, StreamChatParams } from './host.js';
import fs from 'node:fs';
import path from 'node:path';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { markdownToPlainText } from './markdown/plain.js';
import {
  stripOutboundArtifactBlocksForStreaming,
  supportsOutboundArtifacts,
} from './outbound-artifacts.js';
import { getBridgeContext } from './context.js';
import {
  getDesktopSessionByThreadId,
  listDesktopSessions,
  readDesktopSessionMirrorRecordDeltaByFilePath,
  readDesktopSessionMessages,
} from '../../desktop-sessions.js';
import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import {
  advanceDesktopMirrorCursor,
  filterDuplicateAssistantEvents,
  reconcileDesktopMirrorCursor,
} from '../../desktop-session-mirror.js';
import type { DesktopMirrorCursor } from '../../desktop-session-mirror.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import { DEFAULT_WORKSPACE_ROOT, type ChannelInstance, type ChannelProvider } from '../../config.js';
import {
  cleanupHiddenSessions,
  getInternalScratchDir,
  getOrCreateDraftSession,
  isSessionExpired,
  makeHistorySummarySessionName,
  resetDraftSession as resetDraftSessionForStore,
} from '../../internal-sessions.js';
import {
  isCliOnlyCodexModel,
  listSelectableCodexModels,
  readConfiguredCodexModel,
} from '../../codex-models.js';

const GLOBAL_KEY = '__bridge_manager__';
const HISTORY_SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;
const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const MODE_OPTIONS_TEXT = '可选：`code`（直接执行，默认） `plan`（先分析再行动） `ask`（轻对话 / 草稿）';
const REASONING_OPTIONS_TEXT = '可选：`1=minimal` `2=low` `3=medium` `4=high` `5=xhigh`';
const DEFAULT_DESKTOP_THREAD_LIST_LIMIT = 10;
const MAX_DESKTOP_THREAD_LIST_LIMIT = 200;
const MIRROR_POLL_INTERVAL_MS = 2_500;
const MIRROR_WATCH_DEBOUNCE_MS = 350;
const MIRROR_EVENT_BATCH_LIMIT = 8;
const MIRROR_SUPPRESSION_WINDOW_MS = 4_000;
const MIRROR_PROMPT_MATCH_GRACE_MS = 120_000;
const INTERACTIVE_IDLE_REMINDER_MS = 600_000;
// Idle timeout after the last desktop event before we flush a buffered turn
// without seeing task_complete.
const MIRROR_IDLE_TIMEOUT_MS = 600_000;
const AVAILABLE_CODEX_MODELS = listSelectableCodexModels();
const AVAILABLE_CODEX_MODEL_MAP = new Map(AVAILABLE_CODEX_MODELS.map((model) => [model.slug, model]));

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function listConfiguredChannelInstances(): ChannelInstance[] {
  const { store } = getBridgeContext();
  const raw = store.getSetting('bridge_channel_instances_json');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ChannelInstance[] : [];
  } catch {
    return [];
  }
}

function getConfiguredChannelInstance(channelType: string): ChannelInstance | null {
  return listConfiguredChannelInstances().find((channel) => channel.id === channelType) || null;
}

function inferChannelProvider(channelType: string): ChannelProvider | undefined {
  const instance = getConfiguredChannelInstance(channelType);
  return instance?.provider;
}

function getChannelProviderKey(channelType: string): string {
  return inferChannelProvider(channelType) || channelType;
}

function parseListIndex(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function resolveCommandAlias(rawCommand: string, args: string): string {
  switch (rawCommand) {
    case '/':
      return '/status';
    case '/h':
      return '/help';
    case '/t':
      return !args
        ? '/threads'
        : /^(all|n\b)/i.test(args.trim())
          ? '/threads'
          : '/thread';
    case '/n':
      return '/new';
    case '/m':
      return '/mode';
    case '/r':
      return '/reasoning';
    case '/his':
      return '/history';
    default:
      return rawCommand;
  }
}

function resolveByIndexOrPrefix<T>(
  raw: string,
  items: T[],
  getId: (item: T) => string,
): { match: T | null; ambiguous: boolean; index?: number } {
  const token = raw.trim().toLowerCase();
  if (!token) return { match: null, ambiguous: false };

  const index = parseListIndex(token);
  if (index !== null) {
    return { match: items[index - 1] ?? null, ambiguous: false, index };
  }

  const exact = items.find((item) => getId(item).toLowerCase() === token);
  if (exact) return { match: exact, ambiguous: false };

  const prefixMatches = items.filter((item) => getId(item).toLowerCase().startsWith(token));
  if (prefixMatches.length === 1) {
    return { match: prefixMatches[0], ambiguous: false };
  }
  if (prefixMatches.length > 1) {
    return { match: null, ambiguous: true };
  }

  return { match: null, ambiguous: false };
}

function getDisplayedDesktopThreads(limit = DEFAULT_DESKTOP_THREAD_LIST_LIMIT) {
  return listDesktopSessions(limit);
}

function parseDesktopThreadListArgs(args: string): { showAll: boolean; limit: number } | null {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) {
    return { showAll: false, limit: DEFAULT_DESKTOP_THREAD_LIST_LIMIT };
  }
  if (trimmed === 'all') {
    return { showAll: true, limit: MAX_DESKTOP_THREAD_LIST_LIMIT };
  }
  const match = trimmed.match(/^n\s+(\d+)$/);
  if (!match) return null;
  const requestedLimit = Number(match[1]);
  const limit = Math.min(requestedLimit, MAX_DESKTOP_THREAD_LIST_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) return null;
  return { showAll: false, limit };
}

function getDisplayedBridgeSessions(currentSessionId?: string): BridgeSession[] {
  const { store } = getBridgeContext();
  const sessions = store.listSessions()
    .filter((session) => session.hidden !== true)
    .toReversed();
  return sessions.sort((a, b) => {
    if (a.id === currentSessionId && b.id !== currentSessionId) return -1;
    if (b.id === currentSessionId && a.id !== currentSessionId) return 1;
    const aShared = a.sdk_session_id ? 1 : 0;
    const bShared = b.sdk_session_id ? 1 : 0;
    if (aShared !== bShared) return bShared - aShared;
    return a.name?.localeCompare(b.name || '') || 0;
  });
}

function getSessionDisplayName(session: BridgeSession | null | undefined, fallbackDirectory?: string): string {
  if (session?.name?.trim()) return session.name.trim();
  const cwd = session?.working_directory || fallbackDirectory || '';
  if (cwd) return path.basename(cwd) || cwd;
  if (session?.id) return session.id.slice(0, 8);
  return '未命名会话';
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildInteractiveStreamKey(sessionId: string, messageId: string): string {
  return `im:${sessionId}:${messageId}`;
}

function buildMirrorStreamKey(sessionId: string, turnId: string | null | undefined, startedAt: string): string {
  return `mirror:${sessionId}:${turnId || startedAt}`;
}

function getWorkspaceRoot(): string {
  const { store } = getBridgeContext();
  return store.getSetting('bridge_default_workspace_root') || DEFAULT_WORKSPACE_ROOT;
}

function normalizeReasoningEffort(raw: string): typeof REASONING_LEVELS[number] | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  if (REASONING_LEVELS.includes(token as typeof REASONING_LEVELS[number])) {
    return token as typeof REASONING_LEVELS[number];
  }

  switch (token) {
    case '1':
      return 'minimal';
    case '2':
      return 'low';
    case '3':
      return 'medium';
    case '4':
      return 'high';
    case '5':
      return 'xhigh';
    default:
      return null;
  }
}

function formatReasoningEffort(reasoning: string): string {
  switch (reasoning) {
    case 'minimal':
      return 'minimal (1)';
    case 'low':
      return 'low (2)';
    case 'medium':
      return 'medium (3)';
    case 'high':
      return 'high (4)';
    case 'xhigh':
      return 'xhigh (5)';
    default:
      return reasoning;
  }
}

function buildCommandFields(
  title: string,
  fields: Array<[string, string | null | undefined]>,
  notes: string[] = [],
  markdown = false,
): string {
  const normalizedFields = fields.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  const normalizedNotes = notes.filter((note) => note.trim().length > 0);

  if (markdown) {
    const lines = [`**${title}**`, ''];
    for (const [label, value] of normalizedFields) {
      lines.push(`- **${label}**：${value}`);
    }
    if (normalizedNotes.length > 0) {
      lines.push('', '**说明**');
      for (const note of normalizedNotes) {
        lines.push(`- ${note}`);
      }
    }
    return lines.join('\n').trim();
  }

  return [
    title,
    '',
    ...normalizedFields.map(([label, value]) => `${label}: ${value}`),
    ...(normalizedNotes.length > 0 ? ['', ...normalizedNotes] : []),
  ].join('\n').trim();
}

function buildIndexedCommandList(
  title: string,
  items: Array<{ heading: string; details: string[] }>,
  footer: string[] = [],
  markdown = false,
): string {
  if (markdown) {
    const lines = [`**${title}**`, ''];
    items.forEach((item, index) => {
      const marker = `${index + 1}.`;
      const childIndent = ' '.repeat(marker.length + 1);
      lines.push(`${marker} **${item.heading}**`);
      item.details.filter(Boolean).forEach((detail) => lines.push(`${childIndent}- ${detail}`));
      lines.push('');
    });
    footer.filter(Boolean).forEach((line) => lines.push(`- ${line}`));
    return lines.join('\n').trim();
  }

  const lines = [title, ''];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.heading}`);
    item.details.filter(Boolean).forEach((detail) => lines.push(`   ${detail}`));
    lines.push('');
  });
  footer.filter(Boolean).forEach((line) => lines.push(line));
  return lines.join('\n').trim();
}

function buildDesktopThreadsCommandResponse(
  desktopSessions: ReturnType<typeof getDisplayedDesktopThreads>,
  markdown: boolean,
  showAll: boolean,
  limit = 10,
): string {
  return buildIndexedCommandList(
    showAll ? `桌面会话（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）` : `最近 ${limit} 条桌面会话`,
    desktopSessions.map((session) => ({
      heading: session.title || '未命名线程',
      details: [
        `目录：${formatCommandPath(session.cwd)}`,
        `来源：${session.originator || 'Codex Desktop'}`,
      ],
    })),
    showAll
      ? [
          '发送 `/t 1` 可接管第 1 条桌面会话。',
          `发送 \`/t\` 可只看最近 ${DEFAULT_DESKTOP_THREAD_LIST_LIMIT} 条。`,
        ]
      : [
          '发送 `/t 1` 可接管第 1 条桌面会话。',
          `发送 \`/t all\` 可查看最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条桌面会话。`,
          `发送 \`/t n 100\` 可查看最近 100 条桌面会话（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）。`,
        ],
    markdown,
  );
}

function isFeedbackMarkdownEnabled(channelType: string): boolean {
  const instance = getConfiguredChannelInstance(channelType);
  if (instance?.provider === 'feishu') {
    return (instance.config as ChannelInstance['config'] & { feedbackMarkdownEnabled?: boolean }).feedbackMarkdownEnabled !== false;
  }
  if (instance?.provider === 'weixin') {
    return (instance.config as ChannelInstance['config'] & { feedbackMarkdownEnabled?: boolean }).feedbackMarkdownEnabled === true;
  }
  return false;
}

function getFeedbackParseMode(channelType: string): 'Markdown' | 'plain' {
  return isFeedbackMarkdownEnabled(channelType)
    ? 'Markdown'
    : 'plain';
}

function renderFeedbackText(text: string, parseMode: 'Markdown' | 'plain'): string {
  return parseMode === 'Markdown' ? text : markdownToPlainText(text);
}

function renderFeedbackTextForChannel(channelType: string, text: string): string {
  return renderFeedbackText(text, getFeedbackParseMode(channelType));
}

function toUserVisibleBindingError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message) return message;
  }
  return fallback;
}

function formatBindingChatLabel(binding: Pick<ChannelBinding, 'channelType' | 'channelProvider' | 'channelAlias' | 'chatId' | 'chatDisplayName'>): string {
  const instance = getConfiguredChannelInstance(binding.channelType);
  const channelLabel = binding.channelAlias
    || instance?.alias
    || (binding.channelProvider === 'feishu'
      ? '飞书'
      : binding.channelProvider === 'weixin'
        ? '微信'
        : binding.channelType);
  const chatLabel = binding.chatDisplayName?.trim() || binding.chatId;
  return `${channelLabel} 聊天 ${chatLabel}`;
}

function toUserVisibleCommandError(command: string, error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message && /一个会话只能绑定一个聊天|已绑定到/.test(message)) {
      return message;
    }
  }

  if (command === '/history') {
    return '整理历史失败，请稍后重试；也可以发送 /history raw 查看原始记录。';
  }
  if (command === '/new') {
    return '新建会话失败。请检查目录是否可写，或改用 /new 绝对路径。';
  }
  return `${command} 执行失败，请稍后重试。`;
}

function resolveEffectiveReasoningEffort(session: BridgeSession | null | undefined): string {
  const { store } = getBridgeContext();
  const configured = session?.reasoning_effort || store.getSetting('bridge_codex_reasoning_effort');
  if (
    configured === 'minimal'
    || configured === 'low'
    || configured === 'medium'
    || configured === 'high'
    || configured === 'xhigh'
  ) {
    return configured;
  }
  return 'medium';
}

function resolveEffectiveSandboxMode(): string {
  const { store } = getBridgeContext();
  const configured = store.getSetting('bridge_codex_sandbox_mode');
  if (
    configured === 'read-only'
    || configured === 'workspace-write'
    || configured === 'danger-full-access'
  ) {
    return configured;
  }
  return 'workspace-write';
}

function resolveDisplayedModel(
  binding: ChannelBinding | null | undefined,
  session: BridgeSession | null | undefined,
  configuredDefaultModel?: string | null,
  codexDefaultModel?: string | null,
): string {
  return binding?.model
    || session?.model
    || configuredDefaultModel
    || codexDefaultModel
    || 'default';
}

function formatDisplayedModel(model: string): string {
  const metadata = AVAILABLE_CODEX_MODEL_MAP.get(model);
  return metadata && isCliOnlyCodexModel(metadata)
    ? `${model}（仅 IM / CLI）`
    : model;
}

function getAvailableModelChoicesText(): string {
  if (AVAILABLE_CODEX_MODELS.length === 0) {
    return '当前没有可用模型缓存；请检查 `~/.codex/models_cache.json`，然后重启 Bridge。';
  }
  return `可选模型：${AVAILABLE_CODEX_MODELS.map((model) => formatDisplayedModel(model.slug)).join('、')}`;
}

function resolveNewWorkingDirectory(rawArgs: string): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { ok: false, message: '缺少路径参数。' };
  }

  if (path.isAbsolute(trimmed)) {
    const validated = validateWorkingDirectory(trimmed);
    if (!validated) {
      return { ok: false, message: '路径无效。必须是绝对路径，且不能包含目录穿越或特殊字符。' };
    }
    return { ok: true, workDir: validated };
  }

  const workspaceRoot = getWorkspaceRoot();

  if (trimmed.includes('\0') || /[$`;|&><(){}\x00-\x1f]/.test(trimmed)) {
    return { ok: false, message: '项目名无效。' };
  }

  const normalizedRelative = path.normalize(trimmed);
  if (
    !normalizedRelative
    || normalizedRelative === '.'
    || normalizedRelative.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    return { ok: false, message: '项目名无效。不能使用 .. 或空路径。' };
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelative);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, message: '项目路径越界。新项目必须创建在默认工作空间内。' };
  }

  const validated = validateWorkingDirectory(resolvedPath);
  if (!validated) {
    return { ok: false, message: '解析后的工作目录无效。' };
  }
  return { ok: true, workDir: validated };
}

function resolveNewSessionWorkingDirectory(
  rawArgs: string,
  binding: ChannelBinding | null,
  session: BridgeSession | null | undefined,
): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = rawArgs.trim();
  if (trimmed) {
    return resolveNewWorkingDirectory(trimmed);
  }

  if (!binding || !session) {
    return {
      ok: false,
      message: '当前聊天还没有绑定正式会话。请先用 `/t 1` 接管，或使用 `/new proj1` / `/new 绝对路径` 创建项目会话。',
    };
  }

  if (session.session_type === 'draft' || session.session_type === 'history_summary') {
    return {
      ok: false,
      message: '当前不是正式工作会话。无参 `/new` 只能基于当前正式会话的目录创建新线程；请先切回正式会话，或使用 `/new proj1` / `/new 绝对路径`。',
    };
  }

  const validated = validateWorkingDirectory(session.working_directory || binding.workingDirectory || '');
  if (!validated) {
    return {
      ok: false,
      message: '当前会话没有有效的工作目录。请改用 `/new proj1` 或 `/new 绝对路径`。',
    };
  }

  return { ok: true, workDir: validated };
}

function ensureWorkingDirectoryExists(workDir: string): void {
  fs.mkdirSync(workDir, { recursive: true });
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

function resetDraftSession(address: { channelType: string; chatId: string }): BridgeSession {
  const { store } = getBridgeContext();
  return resetDraftSessionForStore(store, address);
}

function getOrCreateHistorySummarySession(parentSession: BridgeSession): BridgeSession {
  const { store } = getBridgeContext();
  cleanupHiddenSessions(store);
  const existing = store.listSessions().find((session) =>
    session.hidden === true
    && session.session_type === 'history_summary'
    && session.parent_session_id === parentSession.id
    && !isSessionExpired(session)
  );

  if (existing) {
    store.updateSession(existing.id, {
      expires_at: new Date(Date.now() + HISTORY_SUMMARY_TTL_MS).toISOString(),
    });
    return store.getSession(existing.id) || existing;
  }

  const scratchDir = getInternalScratchDir('history_summary', parentSession.id);
  return store.createSession(
    makeHistorySummarySessionName(parentSession.id),
    parentSession.model,
    undefined,
    scratchDir,
    'ask',
    {
      hidden: true,
      sessionType: 'history_summary',
      parentSessionId: parentSession.id,
      expiresAt: new Date(Date.now() + HISTORY_SUMMARY_TTL_MS).toISOString(),
      reasoningEffort: 'low',
    },
  );
}

async function collectInternalTextResponse(
  llm: LLMProvider,
  params: StreamChatParams,
): Promise<{ ok: boolean; text: string; sessionId: string | null; error?: string }> {
  const stream = llm.streamChat(params);
  const reader = stream.getReader();
  let text = '';
  let sessionId: string | null = null;
  let error = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let event: { type: string; data: string };
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      if (event.type === 'text') {
        text += event.data;
        continue;
      }

      if (event.type === 'status' || event.type === 'result') {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.session_id) sessionId = parsed.session_id;
        } catch {
          // ignore malformed payloads
        }
        continue;
      }

      if (event.type === 'error') {
        error = event.data || 'Internal summary failed';
      }
    }
  }

  return {
    ok: !error,
    text: text.trim(),
    sessionId,
    ...(error ? { error } : {}),
  };
}

function buildHistoryTranscript(messages: BridgeMessage[]): string {
  return messages.map((message, index) => {
    const role = formatHistoryRole(message.role);
    return `${index + 1}. ${role}\n${truncateHistoryContent(formatStoredMessageContent(message.content), 1600)}`;
  }).join('\n\n');
}

async function summarizeHistory(currentBinding: ReturnType<typeof router.resolve>): Promise<string> {
  const { store, llm } = getBridgeContext();
  const currentSession = store.getSession(currentBinding.codepilotSessionId);
  if (!currentSession) {
    return '当前会话不存在，无法整理历史记录。';
  }

  const limit = getHistoryMessageLimit();
  const desktopMessages = currentBinding.sdkSessionId
    ? readDesktopSessionMessages(currentBinding.sdkSessionId, limit)
    : [];
  const { messages: storedMessages } = store.getMessages(currentBinding.codepilotSessionId, { limit });
  const messages = desktopMessages.length > 0 ? desktopMessages : storedMessages;
  if (messages.length === 0) {
    return '当前会话还没有历史消息。';
  }

  const summarySession = getOrCreateHistorySummarySession(currentSession);
  const transcript = buildHistoryTranscript(messages);
  const prompt = [
    '请只基于下面的会话记录做整理，不要调用任何工具，也不要引用工作区外的信息。',
    '输出格式固定为 4 段：',
    '1. 当前目标',
    '2. 最近进展',
    '3. 当前阻塞/风险',
    '4. 下一步建议',
    '每段控制在 1-3 句，中文输出，直接给结果。',
    '',
    transcript,
  ].join('\n');

  const result = await collectInternalTextResponse(llm, {
    prompt,
    sessionId: summarySession.id,
    sdkSessionId: summarySession.sdk_session_id || undefined,
    model: currentSession.model || currentBinding.model || undefined,
    modelReasoningEffort: 'low',
    sandboxMode: 'read-only',
    permissionMode: 'never',
    workingDirectory: summarySession.working_directory,
    conversationHistory: [],
  });

  if (result.sessionId) {
    store.updateSdkSessionId(summarySession.id, result.sessionId);
  }

  if (!result.ok) {
    return `历史整理失败：${result.error || 'unknown error'}`;
  }

  return result.text || '当前没有可整理的历史摘要。';
}

function getDesktopThreadTitle(threadId: string | undefined | null): string | null {
  if (!threadId) return null;
  return getDesktopSessionByThreadId(threadId)?.title || null;
}

function formatCommandMessageId(id: string | undefined | null): string {
  if (!id) return '未共享';
  return id;
}

function formatCommandPath(cwd: string | undefined | null): string {
  return cwd?.trim() || '~';
}

function getHistoryMessageLimit(): number {
  const { store } = getBridgeContext();
  const configured = Number.parseInt(store.getSetting('bridge_history_message_limit') || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return 8;
  return Math.max(1, Math.min(20, configured));
}

function stripStoredAttachmentMarker(content: string): string {
  return content.replace(/\n?<!--files:[\s\S]*?-->$/u, '').trim();
}

function formatStoredMessageContent(content: string): string {
  const stripped = stripStoredAttachmentMarker(content);
  if (!stripped) return '[empty]';

  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return stripped;

    const lines: string[] = [];
    for (const block of parsed) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lines.push(block.text.trim());
        continue;
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        lines.push(`[tool] ${block.name}`);
        continue;
      }
      if (block.type === 'tool_result') {
        const suffix = block.is_error === true ? ' error' : '';
        if (typeof block.content === 'string' && block.content.trim()) {
          lines.push(`[tool_result${suffix}] ${block.content.trim()}`);
        } else {
          lines.push(`[tool_result${suffix}]`);
        }
      }
    }
    return lines.length > 0 ? lines.join('\n') : stripped;
  } catch {
    return stripped;
  }
}

function truncateHistoryContent(content: string, maxChars = 800): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}...`;
}

function formatHistoryRole(role: string): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Codex';
  return role || 'unknown';
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
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

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram/Discord/Feishu: use native markdown rendering when enabled.
 * Other channels: fall back to the adapter's plain/markdown handling.
 */
async function deliverTextResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (!responseText.trim()) return { ok: true };

  const parseMode = getFeedbackParseMode(adapter.channelType);
  const renderedText = renderFeedbackText(responseText, parseMode);

  if (parseMode === 'Markdown' && adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (parseMode === 'Markdown' && adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (parseMode === 'Markdown' && adapter.provider === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: let the adapter handle the selected parse mode directly.
  return deliver(adapter, {
    address,
    text: parseMode === 'Markdown' ? responseText : renderedText,
    parseMode,
    replyToMessageId,
  }, { sessionId });
}

async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  attachments: OutboundAttachment[] = [],
): Promise<SendResult> {
  let lastResult: SendResult = { ok: true };

  if (responseText.trim()) {
    lastResult = await deliverTextResponse(adapter, address, responseText, sessionId, replyToMessageId);
    if (!lastResult.ok) return lastResult;
  }

  for (const attachment of attachments) {
    if (attachment.caption) {
      const captionResult = await deliverTextResponse(adapter, address, attachment.caption, sessionId, replyToMessageId);
      if (!captionResult.ok) return captionResult;
      lastResult = captionResult;
    }

    if (!supportsOutboundArtifacts(adapter.provider)) {
      lastResult = await deliverTextResponse(
        adapter,
        address,
        `生成了一个本地${attachment.kind === 'image' ? '图片' : '文件'}，但当前通道暂不支持直接发送：${attachment.path}`,
        sessionId,
        replyToMessageId,
      );
      if (!lastResult.ok) return lastResult;
      continue;
    }

    const attachmentResult = await deliver(adapter, {
      address,
      text: '',
      parseMode: 'plain',
      attachments: [attachment],
      replyToMessageId,
    }, { sessionId });

    if (!attachmentResult.ok) {
      return deliverTextResponse(
        adapter,
        address,
        `附件发送失败：${attachment.path}\n${attachmentResult.error || '未知错误'}`,
        sessionId,
        replyToMessageId,
      );
    }

    lastResult = attachmentResult;
  }

  return lastResult;
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
  configFingerprint: string;
}

interface DesktopMirrorSubscription {
  bindingId: string;
  sessionId: string;
  channelType: string;
  chatId: string;
  threadId: string;
  filePath: string | null;
  cursor: DesktopMirrorCursor;
  dirty: boolean;
  status: 'inactive' | 'watching' | 'stale';
  watcher: fs.FSWatcher | null;
  watcherTarget: string | null;
  lastDeliveredAt: string | null;
  lastReconciledAt: string | null;
  fileOffset: number;
  fileSize: number | null;
  fileMtimeMs: number | null;
  fileIdentity: string | null;
  trailingText: string;
  activeMirrorTurnId: string | null;
  bufferedRecords: DesktopMirrorRecord[];
  pendingTurn: DesktopMirrorTurnState | null;
}

interface DesktopMirrorTurnState {
  turnId: string | null;
  streamKey: string;
  startedAt: string;
  lastActivityAt: string;
  userText: string | null;
  lastAssistantText: string | null;
  lastCommentaryText: string | null;
  streamedText: string;
  streamStarted: boolean;
  toolCalls: Map<string, ToolCallInfo>;
}

interface FinalizedDesktopMirrorTurn {
  streamKey: string;
  userText: string | null;
  text: string;
  signature: string;
  timestamp: string;
  status: 'completed' | 'interrupted';
  timedOut?: boolean;
}

interface InteractiveTaskState {
  id: string;
  abortController: AbortController;
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  requestMessageId: string;
  streamKey: string;
  sessionId: string;
  hasStreamingCards: boolean;
  lastActivityAt: number;
  idleReminderSent: boolean;
  streamFinalized: boolean;
  uiEnded: boolean;
  mirrorSuppressionId: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  reconcileTimer: NodeJS.Timeout | null;
  mirrorPollTimer: NodeJS.Timeout | null;
  mirrorWakeTimer: NodeJS.Timeout | null;
  activeTasks: Map<string, InteractiveTaskState>;
  mirrorSubscriptions: Map<string, DesktopMirrorSubscription>;
  mirrorSyncInFlight: boolean;
  mirrorSuppressUntil: Map<string, MirrorSuppressionState[]>;
  mirrorIgnoredTurnIds: Map<string, Map<string, number>>;
  queuedCounts: Map<string, number>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

interface MirrorSuppressionState {
  id: string;
  until: number;
  promptText: string | null;
  awaitingPromptMatch: boolean;
  candidateTurnId: string | null;
  activeTurnId: string | null;
  droppingTurn: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
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

function getQueuedCount(sessionId: string): number {
  const state = getState();
  return state.queuedCounts.get(sessionId) || 0;
}

function buildInteractiveIdleReminderNotice(): string {
  return [
    '提醒：这轮任务仍在运行，但已经超过 10 分钟没有新的执行输出。',
    '系统不会自动终止它；如果你仍在对应线程，可发送 `/stop` 主动停止；如果已经切到别的线程，需要先切回对应线程。',
  ].join('\n');
}

function isCurrentInteractiveTask(sessionId: string, taskId: string): boolean {
  return getState().activeTasks.get(sessionId)?.id === taskId;
}

function touchInteractiveTask(sessionId: string, taskId: string): void {
  const task = getState().activeTasks.get(sessionId);
  if (task?.id !== taskId) return;
  task.lastActivityAt = Date.now();
  task.idleReminderSent = false;
}

function releaseInteractiveTask(sessionId: string, taskId: string): void {
  const state = getState();
  const current = state.activeTasks.get(sessionId);
  if (current?.id !== taskId) return;
  state.activeTasks.delete(sessionId);
  syncSessionRuntimeState(sessionId);
}

async function remindIdleInteractiveTask(task: InteractiveTaskState): Promise<void> {
  if (!isCurrentInteractiveTask(task.sessionId, task.id) || task.idleReminderSent) return;
  task.idleReminderSent = true;

  try {
    await deliver(task.adapter, {
      address: task.address,
      text: renderFeedbackTextForChannel(
        task.adapter.channelType,
        buildInteractiveIdleReminderNotice(),
      ),
      parseMode: getFeedbackParseMode(task.adapter.channelType),
      replyToMessageId: task.requestMessageId,
    });
  } catch {
    // best effort reminder
  }
}

async function reconcileIdleInteractiveTasks(): Promise<void> {
  const now = Date.now();
  const tasks = Array.from(getState().activeTasks.values());
  for (const task of tasks) {
    if (task.idleReminderSent) continue;
    if (now - task.lastActivityAt < INTERACTIVE_IDLE_REMINDER_MS) continue;
    await remindIdleInteractiveTask(task);
  }
}

function syncSessionRuntimeState(sessionId: string): void {
  const { store } = getBridgeContext();
  const session = store.getSession(sessionId);
  if (!session) return;

  const queuedCount = getQueuedCount(sessionId);
  const isRunning = getState().activeTasks.has(sessionId);
  const runtimeStatus: BridgeSession['runtime_status'] = queuedCount > 0
    ? 'queued'
    : isRunning
      ? 'running'
      : 'idle';

  if (
    session.queued_count === queuedCount
    && session.runtime_status === runtimeStatus
  ) {
    return;
  }

  store.updateSession(sessionId, {
    queued_count: queuedCount,
    runtime_status: runtimeStatus,
    last_runtime_update_at: nowIso(),
  });
}

function incrementQueuedCount(sessionId: string): void {
  const state = getState();
  state.queuedCounts.set(sessionId, getQueuedCount(sessionId) + 1);
  syncSessionRuntimeState(sessionId);
}

function decrementQueuedCount(sessionId: string): void {
  const state = getState();
  const next = Math.max(0, getQueuedCount(sessionId) - 1);
  if (next > 0) {
    state.queuedCounts.set(sessionId, next);
  } else {
    state.queuedCounts.delete(sessionId);
  }
  syncSessionRuntimeState(sessionId);
}

function formatRuntimeStatus(session: BridgeSession | null | undefined): string {
  const status = session?.runtime_status || 'idle';
  const queuedCount = session?.queued_count && session.queued_count > 0
    ? session.queued_count
    : 0;

  if (status === 'queued') {
    return queuedCount > 0 ? `排队中（${queuedCount}）` : '排队中';
  }
  if (status === 'running') {
    return '运行中';
  }
  return '空闲';
}

function formatMirrorStatus(session: BridgeSession | null | undefined): string {
  if (session?.mirror_status === 'watching') {
    return session.mirror_last_event_at
      ? `监听中 · 最近同步 ${session.mirror_last_event_at}`
      : '监听中';
  }
  if (session?.mirror_status === 'stale') {
    return '待恢复（暂时没定位到桌面 thread 文件）';
  }
  return '未监听';
}

function normalizeMirrorPromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').normalize('NFKC').trim();
}

function getIgnoredMirrorTurns(sessionId: string): Map<string, number> {
  const state = getState();
  const existing = state.mirrorIgnoredTurnIds.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, number>();
  state.mirrorIgnoredTurnIds.set(sessionId, created);
  return created;
}

function cleanupIgnoredMirrorTurns(sessionId: string): Map<string, number> {
  const turns = getIgnoredMirrorTurns(sessionId);
  const now = Date.now();
  for (const [turnId, until] of turns) {
    if (until <= now) {
      turns.delete(turnId);
    }
  }
  if (turns.size === 0) {
    getState().mirrorIgnoredTurnIds.delete(sessionId);
  }
  return turns;
}

function markIgnoredMirrorTurn(sessionId: string, turnId: string | null | undefined, durationMs = MIRROR_PROMPT_MATCH_GRACE_MS): void {
  const normalized = (turnId || '').trim();
  if (!normalized) return;
  const state = getState();
  const turns = cleanupIgnoredMirrorTurns(sessionId);
  turns.set(normalized, Date.now() + durationMs);
  state.mirrorIgnoredTurnIds.set(sessionId, turns);
}

function clearIgnoredMirrorTurn(sessionId: string, turnId: string | null | undefined): void {
  const normalized = (turnId || '').trim();
  if (!normalized) return;
  const turns = cleanupIgnoredMirrorTurns(sessionId);
  turns.delete(normalized);
  if (turns.size === 0) {
    getState().mirrorIgnoredTurnIds.delete(sessionId);
  }
}

function getMirrorSuppressionStates(sessionId: string): MirrorSuppressionState[] {
  const state = getState();
  const existing = state.mirrorSuppressUntil.get(sessionId) || [];
  if (existing.length === 0) return [];
  const now = Date.now();
  const active = existing.filter((suppression) => suppression.until > now);
  if (active.length === 0) {
    state.mirrorSuppressUntil.delete(sessionId);
    return [];
  }
  if (active.length !== existing.length) {
    state.mirrorSuppressUntil.set(sessionId, active);
  }
  return active;
}

function clearMirrorSuppression(sessionId: string, suppressionId?: string | null): void {
  const state = getState();
  const existing = state.mirrorSuppressUntil.get(sessionId);
  if (!existing || existing.length === 0) return;
  if (!suppressionId) {
    state.mirrorSuppressUntil.delete(sessionId);
    return;
  }
  const next = existing.filter((suppression) => suppression.id !== suppressionId);
  if (next.length > 0) {
    state.mirrorSuppressUntil.set(sessionId, next);
  } else {
    state.mirrorSuppressUntil.delete(sessionId);
  }
}

function beginMirrorSuppression(sessionId: string, promptText: string): string {
  const suppressionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const state = getState();
  const suppressions = getMirrorSuppressionStates(sessionId);
  suppressions.push({
    id: suppressionId,
    until: Number.POSITIVE_INFINITY,
    promptText: normalizeMirrorPromptText(promptText) || null,
    awaitingPromptMatch: true,
    candidateTurnId: null,
    activeTurnId: null,
    droppingTurn: false,
  });
  state.mirrorSuppressUntil.set(sessionId, suppressions);
  return suppressionId;
}

function settleMirrorSuppression(
  sessionId: string,
  suppressionId?: string | null,
  durationMs = MIRROR_SUPPRESSION_WINDOW_MS,
): void {
  const suppressions = getMirrorSuppressionStates(sessionId);
  if (suppressions.length === 0) return;
  const target = suppressionId
    ? suppressions.find((suppression) => suppression.id === suppressionId)
    : suppressions[suppressions.length - 1];
  if (!target) return;
  if (target.awaitingPromptMatch || target.droppingTurn) {
    target.until = Date.now() + MIRROR_PROMPT_MATCH_GRACE_MS;
    return;
  }
  target.until = Date.now() + durationMs;
}

function isMirrorSuppressed(sessionId: string): boolean {
  return getMirrorSuppressionStates(sessionId).length > 0;
}

function filterSuppressedMirrorRecords(
  sessionId: string,
  records: DesktopMirrorRecord[],
): DesktopMirrorRecord[] {
  const suppressions = getMirrorSuppressionStates(sessionId);
  if (suppressions.length === 0 || records.length === 0) return records;

  const filtered: DesktopMirrorRecord[] = [];
  cleanupIgnoredMirrorTurns(sessionId);

  for (const record of records) {
    const normalizedContent = record.type === 'message'
      ? normalizeMirrorPromptText(record.content || '')
      : '';
    let handled = false;

    while (true) {
      const ignoredTurnIds = cleanupIgnoredMirrorTurns(sessionId);
      if (record.turnId && ignoredTurnIds.has(record.turnId)) {
        if (record.type === 'task_complete') {
          clearIgnoredMirrorTurn(sessionId, record.turnId);
        }
        handled = true;
        break;
      }

      const suppression = getMirrorSuppressionStates(sessionId)[0];
      if (!suppression) break;

      if (suppression.awaitingPromptMatch) {
        if (record.type === 'task_started') {
          suppression.candidateTurnId = record.turnId || suppression.candidateTurnId;
          handled = true;
          break;
        }

        if (
          record.turnId
          && suppression.candidateTurnId
          && record.turnId !== suppression.candidateTurnId
        ) {
          break;
        }

        if (record.type === 'message' && record.role === 'user') {
          if (suppression.promptText && normalizedContent === suppression.promptText) {
            suppression.awaitingPromptMatch = false;
            suppression.droppingTurn = true;
            suppression.activeTurnId = record.turnId || suppression.candidateTurnId || null;
            handled = true;
            break;
          }
          clearMirrorSuppression(sessionId, suppression.id);
          continue;
        }

        if (
          record.type === 'task_complete'
          && suppression.candidateTurnId
          && record.turnId
          && record.turnId === suppression.candidateTurnId
        ) {
          clearMirrorSuppression(sessionId, suppression.id);
          handled = true;
          break;
        }

        break;
      }

      if (suppression.droppingTurn) {
        if (record.turnId && suppression.activeTurnId && record.turnId !== suppression.activeTurnId) {
          if (record.type === 'task_started') {
            markIgnoredMirrorTurn(sessionId, suppression.activeTurnId);
            clearMirrorSuppression(sessionId, suppression.id);
            continue;
          }
          break;
        }

        if (record.type === 'task_started') {
          handled = true;
          break;
        }

        if (record.type === 'task_complete') {
          clearMirrorSuppression(sessionId, suppression.id);
          handled = true;
          break;
        }

        if (
          record.type === 'message'
          && record.role === 'user'
          && suppression.promptText
          && normalizedContent !== suppression.promptText
        ) {
          markIgnoredMirrorTurn(sessionId, suppression.activeTurnId);
          clearMirrorSuppression(sessionId, suppression.id);
          continue;
        }

        handled = true;
        break;
      }

      break;
    }

    if (!handled) {
      filtered.push(record);
    }
  }

  return filtered;
}

function resetMirrorSessionForInteractiveRun(sessionId: string): void {
  const state = getState();
  for (const subscription of state.mirrorSubscriptions.values()) {
    if (subscription.sessionId !== sessionId) continue;
    stopMirrorStreaming(subscription, 'interrupted');
    if (subscription.pendingTurn) {
      subscription.pendingTurn.streamStarted = false;
    }
  }
}

interface MirrorFileSnapshot {
  size: number;
  mtimeMs: number;
  identity: string;
}

function resetMirrorReadState(subscription: DesktopMirrorSubscription): void {
  subscription.fileOffset = 0;
  subscription.fileSize = null;
  subscription.fileMtimeMs = null;
  subscription.fileIdentity = null;
  subscription.trailingText = '';
  subscription.activeMirrorTurnId = null;
  subscription.bufferedRecords = [];
}

function statMirrorFile(filePath: string): MirrorFileSnapshot | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch {
    return null;
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

function scheduleMirrorWake(delayMs = MIRROR_WATCH_DEBOUNCE_MS): void {
  const state = getState();
  if (!state.running) return;
  if (state.mirrorWakeTimer) return;

  state.mirrorWakeTimer = setTimeout(() => {
    state.mirrorWakeTimer = null;
    void reconcileMirrorSubscriptions();
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

function getMirrorAssistantRuntimeLabel(): string {
  const { store } = getBridgeContext();
  const runtime = (store.getSetting('bridge_runtime') || 'codex').trim().toLowerCase();
  return runtime || 'codex';
}

function buildMirrorTitle(threadTitle: string | null, markdown = false): string {
  const title = threadTitle?.trim() || '桌面线程';
  const rendered = markdown ? `&lt;${title}&gt;` : `<${title}>`;
  return markdown ? `**${rendered}**` : rendered;
}

function buildMirrorSpeakerLabel(label: string, markdown = false): string {
  return markdown ? `**${label}:**` : `${label}:`;
}

function formatMirrorSpeakerBlock(
  label: string,
  text: string | null | undefined,
  markdown = false,
  forceLabel = false,
): string {
  const normalized = (text || '').trim();
  if (!normalized) {
    return forceLabel ? buildMirrorSpeakerLabel(label, markdown) : '';
  }
  const speaker = buildMirrorSpeakerLabel(label, markdown);
  return normalized.includes('\n')
    ? `${speaker}\n${normalized}`
    : `${speaker} ${normalized}`;
}

function formatMirrorMessage(
  threadTitle: string | null,
  userText: string | null | undefined,
  assistantText: string | null | undefined,
  markdown = false,
  forceAssistantLabel = false,
): string {
  const sections: string[] = [];
  const userBlock = formatMirrorSpeakerBlock('我', userText, markdown);
  if (userBlock) {
    sections.push(userBlock);
  }
  const assistantBlock = formatMirrorSpeakerBlock(
    getMirrorAssistantRuntimeLabel(),
    assistantText,
    markdown,
    forceAssistantLabel,
  );
  if (assistantBlock) {
    sections.push(assistantBlock);
  }
  if (sections.length === 0) {
    return '';
  }
  sections.unshift(buildMirrorTitle(threadTitle, markdown));
  return sections.join('\n\n').trim();
}

function buildMirrorTimeoutNotice(markdown = false): string {
  return markdown
    ? '> 超时提醒：长时间没有收到新的桌面会话输出，本次流式同步已先结束；如果桌面后续继续产出内容，会重新开始新一轮同步。'
    : '超时提醒：长时间没有收到新的桌面会话输出，本次流式同步已先结束；如果桌面后续继续产出内容，会重新开始新一轮同步。';
}

function appendMirrorTimeoutNotice(text: string, markdown = false): string {
  const notice = buildMirrorTimeoutNotice(markdown);
  const normalized = text.trim();
  return normalized ? `${normalized}\n\n${notice}` : notice;
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

function updateMirrorStreaming(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter) return;
  startMirrorStreaming(subscription, turnState);
  const text = renderFeedbackTextForChannel(
    subscription.channelType,
    getMirrorStreamingText(subscription, turnState),
  );
  if (!text) return;
  try {
    adapter.onStreamText?.(subscription.chatId, text, turnState.streamKey);
  } catch {
    // Non-critical best effort only.
  }
}

function updateMirrorToolProgress(
  subscription: DesktopMirrorSubscription,
  turnState: DesktopMirrorTurnState,
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  if (!adapter || typeof adapter.onToolEvent !== 'function') return;
  startMirrorStreaming(subscription, turnState);
  try {
    adapter.onToolEvent(subscription.chatId, Array.from(turnState.toolCalls.values()), turnState.streamKey);
  } catch {
    // Non-critical best effort only.
  }
}

function stopMirrorStreaming(
  subscription: DesktopMirrorSubscription,
  status: 'completed' | 'interrupted' = 'interrupted',
): void {
  const adapter = getMirrorStreamingAdapter(subscription);
  const pendingTurn = subscription.pendingTurn;
  if (!adapter || !pendingTurn?.streamStarted || typeof adapter.onStreamEnd !== 'function') return;
  const text = renderFeedbackTextForChannel(
    subscription.channelType,
    getMirrorStreamingText(subscription, pendingTurn),
  );
  void adapter.onStreamEnd(subscription.chatId, status, text, pendingTurn.streamKey).catch(() => {});
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
): Promise<void> {
  for (const turn of turns.slice(-MIRROR_EVENT_BATCH_LIMIT)) {
    await deliverMirrorTurn(subscription, turn);
  }
}

function createMirrorTurnState(sessionId: string, timestamp: string, turnId?: string): DesktopMirrorTurnState {
  const safeTimestamp = timestamp || nowIso();
  return {
    turnId: turnId || null,
    streamKey: buildMirrorStreamKey(sessionId, turnId || null, safeTimestamp),
    startedAt: safeTimestamp,
    lastActivityAt: safeTimestamp,
    userText: null,
    lastAssistantText: null,
    lastCommentaryText: null,
    streamedText: '',
    streamStarted: false,
    toolCalls: new Map(),
  };
}

function appendMirrorUserText(
  turnState: DesktopMirrorTurnState,
  chunk: string,
): void {
  const normalized = chunk.trim();
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

function appendMirrorStreamText(
  turnState: DesktopMirrorTurnState,
  chunk: string,
): void {
  const normalized = chunk.trim();
  if (!normalized) return;
  turnState.streamedText = turnState.streamedText
    ? `${turnState.streamedText}\n\n${normalized}`
    : normalized;
}

function ensureMirrorTurnState(
  subscription: DesktopMirrorSubscription,
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

function finalizeMirrorTurn(
  subscription: DesktopMirrorSubscription,
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
  if (!text && !userText && pendingTurn.toolCalls.size === 0) return null;

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

function consumeMirrorRecords(
  subscription: DesktopMirrorSubscription,
  records: DesktopMirrorRecord[],
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
      startMirrorStreaming(subscription, subscription.pendingTurn);
      continue;
    }

    if (record.type === 'task_complete') {
      ensureMirrorTurnState(subscription, record);
      const completed = finalizeMirrorTurn(subscription, record.signature, record.timestamp, 'completed', record.content);
      if (completed) finalized.push(completed);
      continue;
    }

    if (record.type === 'message' && record.role === 'user') {
      const pendingTurn = ensureMirrorTurnState(subscription, record);
      const text = record.content.trim();
      if (text) {
        appendMirrorUserText(pendingTurn, text);
        startMirrorStreaming(subscription, pendingTurn);
        updateMirrorStreaming(subscription, pendingTurn);
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
          updateMirrorStreaming(subscription, pendingTurn);
        }
      } else if (record.role === 'commentary') {
        const text = record.content.trim();
        if (text) {
          pendingTurn.lastCommentaryText = text;
          appendMirrorStreamText(pendingTurn, text);
          updateMirrorStreaming(subscription, pendingTurn);
        }
      }
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
      updateMirrorToolProgress(subscription, pendingTurn);
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
      updateMirrorToolProgress(subscription, pendingTurn);
    }
  }

  return finalized;
}

function flushTimedOutMirrorTurn(
  subscription: DesktopMirrorSubscription,
  nowMs = Date.now(),
): FinalizedDesktopMirrorTurn | null {
  const pendingTurn = subscription.pendingTurn;
  if (!pendingTurn?.lastActivityAt) return null;
  const lastActivityMs = Date.parse(pendingTurn.lastActivityAt);
  if (!Number.isFinite(lastActivityMs)) return null;
  if (nowMs - lastActivityMs < MIRROR_IDLE_TIMEOUT_MS) {
    return null;
  }

  return finalizeMirrorTurn(
    subscription,
    `timeout:${subscription.threadId}:${pendingTurn.turnId || pendingTurn.lastActivityAt}`,
    pendingTurn.lastActivityAt,
    'interrupted',
  );
}

function hasPendingMirrorWork(subscription: DesktopMirrorSubscription): boolean {
  return subscription.bufferedRecords.length > 0 || subscription.pendingTurn !== null;
}

function consumeBufferedMirrorTurns(
  subscription: DesktopMirrorSubscription,
  nowMs = Date.now(),
): FinalizedDesktopMirrorTurn[] {
  const bufferedRecords = subscription.bufferedRecords;
  subscription.bufferedRecords = [];

  const finalizedTurns = bufferedRecords.length > 0
    ? consumeMirrorRecords(subscription, bufferedRecords)
    : [];
  const timedOutTurn = flushTimedOutMirrorTurn(subscription, nowMs);
  if (timedOutTurn) {
    finalizedTurns.push(timedOutTurn);
  }
  return finalizedTurns;
}

function removeMirrorSubscription(bindingId: string): void {
  const state = getState();
  const existing = state.mirrorSubscriptions.get(bindingId);
  if (!existing) return;
  stopMirrorStreaming(existing);
  closeMirrorWatcher(existing);
  state.mirrorSubscriptions.delete(bindingId);
  syncMirrorSessionState(existing.sessionId);
}

function upsertMirrorSubscription(binding: { id: string; channelType: string; chatId: string; codepilotSessionId: string; sdkSessionId: string }): void {
  const { store } = getBridgeContext();
  const state = getState();
  const session = store.getSession(binding.codepilotSessionId);
  if (!session) {
    removeMirrorSubscription(binding.id);
    return;
  }

  const threadId = binding.sdkSessionId || session.sdk_session_id || '';
  if (!threadId) {
    removeMirrorSubscription(binding.id);
    return;
  }

  const desktopSession = getDesktopSessionByThreadId(threadId);
  const filePath = desktopSession?.filePath || null;
  const existing = state.mirrorSubscriptions.get(binding.id);

  if (!existing) {
    const created: DesktopMirrorSubscription = {
      bindingId: binding.id,
      sessionId: binding.codepilotSessionId,
      channelType: binding.channelType,
      chatId: binding.chatId,
      threadId,
      filePath,
      cursor: { initialized: false, lastEventCount: 0 },
      dirty: true,
      status: filePath ? 'watching' : 'stale',
      watcher: null,
      watcherTarget: null,
      lastDeliveredAt: session.mirror_last_event_at || null,
      lastReconciledAt: null,
      fileOffset: 0,
      fileSize: null,
      fileMtimeMs: null,
      fileIdentity: null,
      trailingText: '',
      activeMirrorTurnId: null,
      bufferedRecords: [],
      pendingTurn: null,
    };
    watchMirrorFile(created, filePath);
    state.mirrorSubscriptions.set(binding.id, created);
    syncMirrorSessionState(binding.codepilotSessionId);
    return;
  }

  const previousSessionId = existing.sessionId;
  const threadChanged = existing.threadId !== threadId;
  const filePathChanged = existing.filePath !== filePath;
  existing.sessionId = binding.codepilotSessionId;
  existing.channelType = binding.channelType;
  existing.chatId = binding.chatId;
  existing.threadId = threadId;
  existing.filePath = filePath;
  existing.status = filePath ? 'watching' : 'stale';
  if (threadChanged) {
    stopMirrorStreaming(existing);
    existing.cursor = { initialized: false, lastEventCount: 0 };
    existing.lastDeliveredAt = session.mirror_last_event_at || null;
    existing.dirty = true;
    existing.pendingTurn = null;
    resetMirrorReadState(existing);
  } else if (filePathChanged) {
    stopMirrorStreaming(existing);
    existing.dirty = true;
    existing.pendingTurn = null;
    resetMirrorReadState(existing);
  }
  watchMirrorFile(existing, filePath);
  if (previousSessionId !== binding.codepilotSessionId) {
    syncMirrorSessionState(previousSessionId);
  }
  syncMirrorSessionState(binding.codepilotSessionId);
}

function syncMirrorSubscriptionSet(): void {
  const { store } = getBridgeContext();
  const state = getState();
  const desiredBindings = store.listChannelBindings().filter((binding) => {
    if (binding.active === false) return false;
    if (!state.adapters.has(binding.channelType)) return false;
    const session = store.getSession(binding.codepilotSessionId);
    return Boolean(binding.sdkSessionId || session?.sdk_session_id);
  });
  const desiredIds = new Set<string>();

  for (const binding of desiredBindings) {
    desiredIds.add(binding.id);
    upsertMirrorSubscription(binding);
  }

  for (const bindingId of Array.from(state.mirrorSubscriptions.keys())) {
    if (!desiredIds.has(bindingId)) {
      removeMirrorSubscription(bindingId);
    }
  }
}

async function reconcileMirrorSubscription(subscription: DesktopMirrorSubscription): Promise<void> {
  const { store } = getBridgeContext();
  const session = store.getSession(subscription.sessionId);
  if (!session) {
    removeMirrorSubscription(subscription.bindingId);
    return;
  }

  const desktopSession = getDesktopSessionByThreadId(subscription.threadId);
  const filePathChanged = subscription.filePath !== (desktopSession?.filePath || null);
  subscription.filePath = desktopSession?.filePath || null;
  subscription.status = subscription.filePath ? 'watching' : 'stale';
  if (filePathChanged) {
    subscription.dirty = true;
    resetMirrorReadState(subscription);
  }
  watchMirrorFile(subscription, subscription.filePath);
  subscription.lastReconciledAt = nowIso();

  if (!subscription.filePath) {
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  const snapshot = statMirrorFile(subscription.filePath);
  if (!snapshot) {
    subscription.status = 'stale';
    subscription.dirty = true;
    resetMirrorReadState(subscription);
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  const unchanged = !subscription.dirty
    && subscription.fileIdentity === snapshot.identity
    && subscription.fileSize === snapshot.size
    && subscription.fileMtimeMs === snapshot.mtimeMs;
  if (unchanged && !hasPendingMirrorWork(subscription)) {
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  let deliverableRecords: DesktopMirrorRecord[] = [];

  const requiresFullRecover = !subscription.cursor.initialized
    || subscription.fileOffset === 0
    || (subscription.fileIdentity !== null && subscription.fileIdentity !== snapshot.identity)
    || (subscription.fileSize !== null && snapshot.size < subscription.fileOffset)
    || (
      subscription.fileSize !== null
      && snapshot.size === subscription.fileOffset
      && subscription.fileMtimeMs !== null
      && snapshot.mtimeMs !== subscription.fileMtimeMs
    );

  if (requiresFullRecover) {
    const previousCursor = subscription.cursor;
    const fullDelta = readDesktopSessionMirrorRecordDeltaByFilePath(
      subscription.filePath,
      0,
      snapshot.size,
      '',
      null,
    );
    const delta = reconcileDesktopMirrorCursor(subscription.cursor, fullDelta.records);
    subscription.cursor = delta.nextCursor;
    deliverableRecords = filterDuplicateAssistantEvents(previousCursor, delta.deliverableRecords);
    subscription.trailingText = '';
    subscription.fileOffset = snapshot.size;
    subscription.activeMirrorTurnId = fullDelta.nextTurnId;
  } else if (snapshot.size > subscription.fileOffset || subscription.trailingText) {
    const previousCursor = subscription.cursor;
    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(
      subscription.filePath,
      subscription.fileOffset,
      snapshot.size,
      subscription.trailingText,
      subscription.activeMirrorTurnId,
    );
    deliverableRecords = filterDuplicateAssistantEvents(previousCursor, delta.records);
    subscription.cursor = advanceDesktopMirrorCursor(subscription.cursor, delta.records);
    subscription.trailingText = delta.trailingText;
    subscription.fileOffset = delta.nextOffset;
    subscription.activeMirrorTurnId = delta.nextTurnId;
  }

  subscription.fileSize = snapshot.size;
  subscription.fileMtimeMs = snapshot.mtimeMs;
  subscription.fileIdentity = snapshot.identity;
  subscription.dirty = false;

  if (deliverableRecords.length > 0) {
    const filteredRecords = filterSuppressedMirrorRecords(subscription.sessionId, deliverableRecords);
    if (filteredRecords.length > 0) {
      subscription.bufferedRecords.push(...filteredRecords);
    }
  }

  const timedOutTurn = flushTimedOutMirrorTurn(subscription);

  if (getState().activeTasks.has(subscription.sessionId) || isMirrorSuppressed(subscription.sessionId)) {
    if (timedOutTurn) {
      try {
        await deliverMirrorTurns(subscription, [timedOutTurn]);
      } catch (error) {
        subscription.dirty = true;
        console.warn('[bridge-manager] Mirror delivery failed:', error instanceof Error ? error.message : error);
      }
    }
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  const finalizedTurns = timedOutTurn ? [timedOutTurn] : [];
  finalizedTurns.push(...consumeBufferedMirrorTurns(subscription));

  if (finalizedTurns.length === 0) {
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  try {
    await deliverMirrorTurns(subscription, finalizedTurns);
  } catch (error) {
    subscription.dirty = true;
    console.warn('[bridge-manager] Mirror delivery failed:', error instanceof Error ? error.message : error);
  }

  syncMirrorSessionState(subscription.sessionId);
}

async function reconcileMirrorSubscriptions(): Promise<void> {
  const state = getState();
  if (!state.running || state.mirrorSyncInFlight) return;
  state.mirrorSyncInFlight = true;

  try {
    syncMirrorSubscriptionSet();
    for (const subscription of state.mirrorSubscriptions.values()) {
      try {
        await reconcileMirrorSubscription(subscription);
      } catch (error) {
        stopMirrorStreaming(subscription, 'interrupted');
        resetMirrorReadState(subscription);
        subscription.status = 'stale';
        subscription.dirty = false;
        console.error(
          `[bridge-manager] Mirror reconcile failed for thread ${subscription.threadId}:`,
          error instanceof Error ? error.stack || error.message : error,
        );
        syncMirrorSessionState(subscription.sessionId);
      }
    }
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

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const queued = state.sessionLocks.has(sessionId);
  if (queued) {
    incrementQueuedCount(sessionId);
  }
  const wrapped = async () => {
    if (queued) {
      decrementQueuedCount(sessionId);
    }
    await fn();
  };
  const current = prev.then(wrapped, wrapped);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

function getActiveChannelTypes(state = getState()): string[] {
  return Array.from(state.adapters.keys()).sort();
}

function notifyAdapterSetChanged(): void {
  const { lifecycle } = getBridgeContext();
  lifecycle.onBridgeAdaptersChanged?.(getActiveChannelTypes());
}

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableFingerprintValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entryValue]) => [key, stableFingerprintValue(entryValue)]),
    );
  }
  return value;
}

function buildAdapterConfigFingerprint(instance: AdapterRuntimeInstance): string {
  const normalizedConfig = stableFingerprintValue(instance.config);
  return JSON.stringify({
    provider: instance.provider,
    alias: instance.alias,
    enabled: instance.enabled,
    config: normalizedConfig,
  });
}

function listEnabledAdapterInstances(): AdapterRuntimeInstance[] {
  const { store } = getBridgeContext();
  const configured = listConfiguredChannelInstances()
    .filter((channel) => channel.enabled)
    .map<AdapterRuntimeInstance>((channel) => ({
      id: channel.id,
      provider: channel.provider,
      alias: channel.alias,
      enabled: channel.enabled,
      config: channel.config,
    }));
  const configuredProviders = new Set(configured.map((channel) => channel.provider));

  for (const provider of getRegisteredTypes()) {
    if (provider === 'feishu' || provider === 'weixin') continue;
    if (configuredProviders.has(provider)) continue;
    const enabled = store.getSetting(`bridge_${provider}_enabled`) === 'true';
    if (!enabled) continue;
    configured.push({
      id: provider,
      provider,
      alias: provider,
      enabled: true,
      config: {},
    });
  }

  return configured;
}

async function stopAdapterInstance(channelType: string): Promise<void> {
  const state = getState();
  const adapter = state.adapters.get(channelType);
  if (!adapter) return;

  state.loopAborts.get(channelType)?.abort();
  state.loopAborts.delete(channelType);

  try {
    await adapter.stop();
    console.log(`[bridge-manager] Stopped adapter: ${channelType}`);
  } catch (err) {
    console.error(`[bridge-manager] Error stopping adapter ${channelType}:`, err);
  }

  state.adapters.delete(channelType);
  state.adapterMeta.delete(channelType);
}

async function syncConfiguredAdapters(options: { startLoops: boolean }): Promise<void> {
  const state = getState();
  let changed = false;
  const desiredInstances = listEnabledAdapterInstances();
  const desiredKeys = new Set(desiredInstances.map((channel) => channel.id));
  const desiredFingerprints = new Map(
    desiredInstances.map((instance) => [instance.id, buildAdapterConfigFingerprint(instance)]),
  );

  for (const existingKey of Array.from(state.adapters.keys())) {
    if (desiredKeys.has(existingKey)) continue;
    await stopAdapterInstance(existingKey);
    changed = true;
  }

  for (const instance of desiredInstances) {
    const existing = state.adapters.get(instance.id);
    const desiredFingerprint = desiredFingerprints.get(instance.id) || '';
    const existingMeta = state.adapterMeta.get(instance.id);
    if (existing && existingMeta?.configFingerprint === desiredFingerprint) continue;
    if (existing) {
      await stopAdapterInstance(instance.id);
      changed = true;
    }

    const adapter = createAdapter(instance);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (configError) {
      console.warn(`[bridge-manager] ${instance.id} adapter not valid:`, configError);
      continue;
    }

    try {
      state.adapters.set(instance.id, adapter);
      state.adapterMeta.set(instance.id, {
        lastMessageAt: null,
        lastError: null,
        configFingerprint: desiredFingerprint,
      });
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${instance.id}`);
      if (options.startLoops && state.running && adapter.isRunning()) {
        runAdapterLoop(adapter);
      }
      changed = true;
    } catch (err) {
      state.adapters.delete(instance.id);
      state.adapterMeta.delete(instance.id);
      console.error(`[bridge-manager] Failed to start adapter ${instance.id}:`, err);
    }
  }

  if (changed) {
    notifyAdapterSetChanged();
  }
}

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

  await syncConfiguredAdapters({ startLoops: false });
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
      runAdapterLoop(adapter);
    }
  }

  state.reconcileTimer = setInterval(() => {
    void syncConfiguredAdapters({ startLoops: true }).catch((err) => {
      console.error('[bridge-manager] Adapter reconcile failed:', err);
    });
    void reconcileIdleInteractiveTasks().catch((err) => {
      console.error('[bridge-manager] Interactive idle reminder reconcile failed:', err);
    });
  }, 5_000);

  state.mirrorPollTimer = setInterval(() => {
    void reconcileMirrorSubscriptions().catch((err) => {
      console.error('[bridge-manager] Mirror reconcile failed:', err);
    });
  }, MIRROR_POLL_INTERVAL_MS);
  void reconcileMirrorSubscriptions().catch((err) => {
    console.error('[bridge-manager] Initial mirror reconcile failed:', err);
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
  for (const sessionId of activeSessionIds) {
    syncSessionRuntimeState(sessionId);
  }
  clearMirrorSubscriptions();

  // Stop all adapters
  for (const type of Array.from(state.adapters.keys())) {
    await stopAdapterInstance(type);
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
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
        isNumericPermissionShortcut(adapter.provider, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null, configFingerprint: '' };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null, configFingerprint: '' };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
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
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: getFeedbackParseMode(adapter.channelType),
      };
      await deliver(adapter, confirmMsg);
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
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: getFeedbackParseMode(adapter.channelType),
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: getFeedbackParseMode(adapter.channelType),
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
          adapter.provider === 'feishu'
          || adapter.provider === 'qq'
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
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: getFeedbackParseMode(adapter.channelType),
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: getFeedbackParseMode(adapter.channelType),
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `当前有 ${pendingLinks.length} 条待处理权限，数字快捷回复会有歧义。请使用完整命令：\n/perm allow|allow_session|deny <id>`,
          parseMode: getFeedbackParseMode(adapter.channelType),
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
      await deliver(adapter, {
        address: msg.address,
        text: toUserVisibleCommandError(resolvedCommand, error),
        parseMode: getFeedbackParseMode(adapter.channelType),
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

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);
  const streamKey = buildInteractiveStreamKey(binding.codepilotSessionId, msg.messageId);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId, streamKey);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const state = getState();
  resetMirrorSessionForInteractiveRun(binding.codepilotSessionId);
  const taskState: InteractiveTaskState = {
    id: taskId,
    abortController: taskAbort,
    adapter,
    address: msg.address,
    requestMessageId: msg.messageId,
    streamKey,
    sessionId: binding.codepilotSessionId,
    hasStreamingCards: false,
    lastActivityAt: Date.now(),
    idleReminderSent: false,
    streamFinalized: false,
    uiEnded: false,
    mirrorSuppressionId: null,
  };
  state.activeTasks.set(binding.codepilotSessionId, taskState);
  syncSessionRuntimeState(binding.codepilotSessionId);

  // ── Streaming preview setup ──────────────────────────────────
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

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;
    const sanitizedText = stripOutboundArtifactBlocksForStreaming(fullText);

    // Truncate to maxChars + ellipsis
    ps.pendingText = sanitizedText.length > cfg.maxChars
      ? sanitizedText.slice(0, cfg.maxChars) + '...'
      : sanitizedText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  taskState.hasStreamingCards = hasStreamingCards;
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    if (!isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    const rendered = renderFeedbackTextForChannel(
      adapter.channelType,
      stripOutboundArtifactBlocksForStreaming(fullText),
    );
    try { adapter.onStreamText!(msg.address.chatId, rendered, streamKey); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (!isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    touchInteractiveTask(binding.codepilotSessionId, taskId);
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()), streamKey);
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (!isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) return;
    touchInteractiveTask(binding.codepilotSessionId, taskId);
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent, (preparedPrompt) => {
      if (!taskState.mirrorSuppressionId) {
        taskState.mirrorSuppressionId = beginMirrorSuppression(binding.codepilotSessionId, preparedPrompt);
      }
    });

    if (!isCurrentInteractiveTask(binding.codepilotSessionId, taskId)) {
      return;
    }

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(
          msg.address.chatId,
          status,
          renderFeedbackTextForChannel(adapter.channelType, result.responseText),
          streamKey,
        );
        taskState.streamFinalized = cardFinalized;
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText || result.outboundAttachments.length > 0) {
      const textToDeliver = cardFinalized ? '' : result.responseText;
      await deliverResponse(
        adapter,
        msg.address,
        textToDeliver,
        binding.codepilotSessionId,
        msg.messageId,
        result.outboundAttachments,
      );
    } else if (result.hasError) {
      await deliverResponse(
        adapter,
        msg.address,
        `**Error:** ${result.errorMessage}`,
        binding.codepilotSessionId,
        msg.messageId,
        [],
      );
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    try {
      persistSdkSessionUpdate(binding.codepilotSessionId, result.sdkSessionId, result.hasError);
    } catch { /* best effort */ }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (
      hasStreamingCards
      && adapter.onStreamEnd
      && taskAbort.signal.aborted
      && !taskState.streamFinalized
    ) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '', streamKey);
        taskState.streamFinalized = true;
      } catch { /* best effort */ }
    }

    if (taskState.mirrorSuppressionId) {
      settleMirrorSuppression(binding.codepilotSessionId, taskState.mirrorSuppressionId);
      taskState.mirrorSuppressionId = null;
    }
    releaseInteractiveTask(binding.codepilotSessionId, taskId);
    // Notify adapter that message processing ended
    if (!taskState.uiEnded) {
      adapter.onMessageEnd?.(msg.address.chatId, streamKey);
      taskState.uiEnded = true;
    }
    // Commit the offset only after full processing (success or failure)
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
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const rawCommand = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();
  const command = resolveCommandAlias(rawCommand, args);

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: '命令被拒绝：检测到无效输入。',
      parseMode: getFeedbackParseMode(adapter.channelType),
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let responseParseMode: 'Markdown' | 'plain' = getFeedbackParseMode(adapter.channelType);
  const currentBinding = store.getChannelBinding(msg.address.channelType, msg.address.chatId);

  switch (command) {
    case '/start':
      response = [
        'Codex to IM',
        '',
        '直接发送文本，就会继续当前聊天绑定的会话。',
        '',
        '常用流程',
        '1. /t 查看最近桌面会话',
        '2. /t 1 接管第 1 条桌面会话',
        '3. 之后直接发消息即可继续这条会话',
        '',
        '发送 /h 查看完整说明。',
      ].join('\n');
      break;

    case '/new': {
      const currentSession = currentBinding
        ? store.getSession(currentBinding.codepilotSessionId)
        : null;
      const resolved = resolveNewSessionWorkingDirectory(args, currentBinding, currentSession);
      if (!resolved.ok) {
        response = resolved.message;
        break;
      }

      const workDir = resolved.workDir;
      ensureWorkingDirectoryExists(workDir);
      const binding = router.createBinding(msg.address, workDir);
      const session = store.getSession(binding.codepilotSessionId);
      response = buildCommandFields(
        '已新建会话',
        [
          ['标题', getSessionDisplayName(session, binding.workingDirectory)],
          ['目录', formatCommandPath(binding.workingDirectory)],
          ['模式', binding.mode],
        ],
        [
          args.trim() ? '接下来直接发送文本即可继续。' : '已在当前工作目录下新建一个线程。接下来直接发送文本即可继续。',
          '如果当前聊天里已有旧任务在运行，它不会被终止，仍会在后台继续执行并可能稍后回消息。',
          '这是 IM 侧线程，当前只保证在 IM 中可继续；不会自动出现在 Codex Desktop 会话列表中。',
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/thread': {
      if (args === '0' || args === '0 reset') {
          const draftSession = args === '0 reset'
            ? resetDraftSession(msg.address)
            : getOrCreateDraftSession(store, msg.address);
        const binding = router.bindToSession(msg.address, draftSession.id);
        if (!binding) {
          response = '草稿线程切换失败。';
          break;
        }
        router.updateBinding(binding.id, {
          mode: 'ask',
          workingDirectory: draftSession.working_directory,
          model: draftSession.model || binding.model,
        });
        response = buildCommandFields(
          args === '0 reset' ? '已重置临时草稿线程' : '已切换到临时草稿线程',
          [
            ['标题', getSessionDisplayName(draftSession, draftSession.working_directory)],
            ['目录', formatCommandPath(draftSession.working_directory)],
            ['过期时间', draftSession.expires_at || '-'],
            ['模式', 'ask'],
          ],
          ['这是隐藏的草稿线程，不会出现在常规会话列表中。'],
          responseParseMode === 'Markdown',
        );
        break;
      }

      if (!args) {
        response = `用法：/thread <序号>，或 /thread 0 进入临时草稿线程；发送 /t all 查看最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条，或 /t n 100 查看最近 100 条桌面会话`;
        break;
      }
      if (args === 'all') {
        const desktopSessions = getDisplayedDesktopThreads(MAX_DESKTOP_THREAD_LIST_LIMIT);
        if (desktopSessions.length === 0) {
          response = '没有找到桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。';
          break;
        }
        response = buildDesktopThreadsCommandResponse(
          desktopSessions,
          responseParseMode === 'Markdown',
          true,
        );
        break;
      }
      const displayedThreads = getDisplayedDesktopThreads(DEFAULT_DESKTOP_THREAD_LIST_LIMIT);
      const threadPick = resolveByIndexOrPrefix(args, displayedThreads, (session) => session.threadId);
      if (threadPick.ambiguous) {
        response = '匹配到多个桌面会话，请先发送 `/t` 查看列表，再用 `/t 1` 这种序号切换。';
        break;
      }
      if (!threadPick.match) {
        if (validateSessionId(args)) {
          const desktop = getDesktopSessionByThreadId(args);
          let binding: ReturnType<typeof router.bindToSdkSession>;
          try {
            binding = router.bindToSdkSession(msg.address, args, desktop ? {
              workingDirectory: desktop.cwd,
              displayName: desktop.title,
            } : undefined);
          } catch (error) {
            response = toUserVisibleBindingError(error, '切换桌面会话失败。');
            break;
          }
          const session = store.getSession(binding.codepilotSessionId);
          response = buildCommandFields(
            '已切换到桌面会话',
            [
              ['标题', desktop?.title || getSessionDisplayName(session, binding.workingDirectory)],
              ['目录', formatCommandPath(binding.workingDirectory)],
            ],
            ['接下来直接发送文本即可继续。'],
            responseParseMode === 'Markdown',
          );
          break;
        }
        response = '没有找到对应的桌面会话。先发送 `/t` 查看最近会话，再用 `/t 1` 接管。';
        break;
      }
      let binding: ReturnType<typeof router.bindToSdkSession>;
      try {
        binding = router.bindToSdkSession(msg.address, threadPick.match.threadId, {
          workingDirectory: threadPick.match.cwd,
          displayName: threadPick.match.title,
        });
      } catch (error) {
        response = toUserVisibleBindingError(error, '切换桌面会话失败。');
        break;
      }
      response = buildCommandFields(
        '已切换到桌面会话',
        [
          ['标题', threadPick.match.title || '未命名线程'],
          ['目录', formatCommandPath(binding.workingDirectory)],
        ],
        ['接下来直接发送文本即可继续。'],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/threads': {
      const listArgs = parseDesktopThreadListArgs(args);
      if (!listArgs) {
        response = `用法：/threads、/threads all、/threads n 100（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）`;
        break;
      }
      const { showAll, limit } = listArgs;
      const desktopSessions = getDisplayedDesktopThreads(limit);
      if (desktopSessions.length === 0) {
        response = showAll
          ? '没有找到桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。'
          : '没有找到最近桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。';
        break;
      }
      response = buildDesktopThreadsCommandResponse(
        desktopSessions,
        responseParseMode === 'Markdown',
        showAll,
        limit,
      );
      break;
    }

    case '/use': {
      if (!args) {
        response = '用法：/use <session-id | 序号>';
        break;
      }
      const displayedSessions = getDisplayedBridgeSessions(currentBinding?.codepilotSessionId);
      const sessionPick = resolveByIndexOrPrefix(args, displayedSessions, (session) => session.id);
      if (sessionPick.ambiguous) {
        response = '匹配到多个内部会话，请使用更长的编号。';
        break;
      }
      if (!sessionPick.match) {
        response = '没有找到对应的内部会话。先发送 /sessions 查看可选项。';
        break;
      }
      let binding: ReturnType<typeof router.bindToSession>;
      try {
        binding = router.bindToSession(msg.address, sessionPick.match.id);
      } catch (error) {
        response = toUserVisibleBindingError(error, '切换会话失败。');
        break;
      }
      if (!binding) {
        response = '切换失败，该会话不存在。';
        break;
      }
      response = buildCommandFields(
        '已切换会话（兼容命令）',
        [
          ['标题', getSessionDisplayName(sessionPick.match, binding.workingDirectory)],
          ['目录', formatCommandPath(binding.workingDirectory)],
        ],
        ['普通使用建议直接通过 `/t` 切换桌面会话。'],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/reasoning': {
      if (!currentBinding) {
        response = '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管桌面会话。';
        break;
      }
      const session = store.getSession(currentBinding.codepilotSessionId);
      if (!session) {
        response = '当前会话不存在。';
        break;
      }
      if (!args) {
        response = buildCommandFields(
          '当前思考级别',
          [['级别', formatReasoningEffort(resolveEffectiveReasoningEffort(session))]],
          [REASONING_OPTIONS_TEXT, '发送 `/r 4` 或 `/r high` 可切换。'],
          responseParseMode === 'Markdown',
        );
        break;
      }
      const reasoning = normalizeReasoningEffort(args);
      if (!reasoning) {
        response = buildCommandFields(
          '思考级别用法',
          [['命令', '`/reasoning minimal|low|medium|high|xhigh`']],
          ['也支持完整命令：`/reasoning 1|2|3|4|5`', REASONING_OPTIONS_TEXT],
          responseParseMode === 'Markdown',
        );
        break;
      }
      store.updateSession(session.id, {
        reasoning_effort: reasoning as BridgeSession['reasoning_effort'],
      });
      response = buildCommandFields(
        '已更新思考级别',
        [['级别', formatReasoningEffort(reasoning)]],
        [REASONING_OPTIONS_TEXT],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/cwd': {
      response = '当前版本已不支持 /cwd。请使用 /new 新建会话，或使用 /thread /use 切换到已有工作空间。';
      break;
    }

    case '/mode': {
      const binding = currentBinding || router.resolve(msg.address);
      if (!args) {
        response = buildCommandFields(
          '当前模式',
          [['模式', binding.mode]],
          [MODE_OPTIONS_TEXT, '发送 `/m code`、`/m plan` 或 `/m ask` 切换。完整命令也兼容：`/mode code`。'],
          responseParseMode === 'Markdown',
        );
        break;
      }
      if (!validateMode(args)) {
        response = buildCommandFields(
          '模式用法',
          [['命令', '`/mode plan|code|ask`']],
          [MODE_OPTIONS_TEXT],
          responseParseMode === 'Markdown',
        );
        break;
      }
      const session = store.getSession(binding.codepilotSessionId);
      if (session) {
        store.updateSession(session.id, {
          preferred_mode: args,
        });
      }
      router.updateBinding(binding.id, { mode: args });
      response = buildCommandFields(
        '已切换模式',
        [['模式', args]],
        [MODE_OPTIONS_TEXT],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/model': {
      const binding = currentBinding || router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      if (!session) {
        response = '当前会话不存在。';
        break;
      }

      if (!args) {
        const currentModel = resolveDisplayedModel(
          binding,
          session,
          store.getSetting('default_model'),
          readConfiguredCodexModel(),
        );
        response = buildCommandFields(
          '当前模型',
          [['模型', formatDisplayedModel(currentModel)]],
          [
            getAvailableModelChoicesText(),
            binding.sdkSessionId
              ? '当前是共享桌面线程，只支持查看模型；如需切换，请先用 `/new` 新建一个 IM 会话线程。'
              : '发送 `/model gpt-5.4` 可切换；发送 `/model default` 可回退到默认模型。',
            '模型切换只影响后续从 IM 发起的 Codex CLI 请求。',
          ],
          responseParseMode === 'Markdown',
        );
        break;
      }

      if (binding.sdkSessionId) {
        response = '当前是共享桌面线程，不支持直接切换模型。请先用 `/new` 新建一个线程，再执行 `/model ...`。';
        break;
      }

      const requestedModel = args.trim();
      if (requestedModel === 'default') {
        store.updateSessionModel(session.id, '');
        router.updateBinding(binding.id, { model: '' });
        const updatedBinding = router.resolve(msg.address);
        const updatedSession = store.getSession(updatedBinding.codepilotSessionId);
        const currentModel = resolveDisplayedModel(
          updatedBinding,
          updatedSession,
          store.getSetting('default_model'),
          readConfiguredCodexModel(),
        );
        response = buildCommandFields(
          '已恢复默认模型',
          [['模型', formatDisplayedModel(currentModel)]],
          ['后续从 IM 发起的 Codex CLI 请求会跟随默认模型。'],
          responseParseMode === 'Markdown',
        );
        break;
      }

      const selectedModel = AVAILABLE_CODEX_MODEL_MAP.get(requestedModel) || null;
      if (!selectedModel) {
        response = buildCommandFields(
          '模型用法',
          [['命令', '`/model <slug>`']],
          [
            getAvailableModelChoicesText(),
            '发送 `/model default` 可回退到默认模型。',
          ],
          responseParseMode === 'Markdown',
        );
        break;
      }

      store.updateSessionModel(session.id, selectedModel.slug);
      router.updateBinding(binding.id, { model: selectedModel.slug });
      response = buildCommandFields(
        '已更新模型',
        [['模型', formatDisplayedModel(selectedModel.slug)]],
        [
          '后续从 IM 发起的 Codex CLI 请求会使用这个模型。',
          ...(isCliOnlyCodexModel(selectedModel)
            ? ['这是 CLI only 模型，只能在 IM -> Codex CLI 调用中使用，Codex Desktop 不支持。']
            : []),
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      const threadTitle = getDesktopThreadTitle(binding.sdkSessionId);
      const sandboxMode = resolveEffectiveSandboxMode();
      const reasoningEffort = resolveEffectiveReasoningEffort(session);
      const currentModel = resolveDisplayedModel(
        binding,
        session,
        store.getSetting('default_model'),
        readConfiguredCodexModel(),
      );
      const sessionKind = session?.session_type === 'draft'
        ? '临时草稿线程'
        : session?.session_type === 'history_summary'
          ? '历史摘要线程'
          : '普通会话';
      response = buildCommandFields(
        '当前会话',
        [
          ['标题', threadTitle || getSessionDisplayName(session, binding.workingDirectory)],
          ['目录', formatCommandPath(binding.workingDirectory)],
          ['模式', binding.mode],
          ['当前模型', formatDisplayedModel(currentModel)],
          ['类型', sessionKind],
          ['运行状态', formatRuntimeStatus(session)],
          ['共享镜像', formatMirrorStatus(session)],
          ['文件系统权限', sandboxMode],
          ['思考级别', formatReasoningEffort(reasoningEffort)],
        ],
        [
            binding.sdkSessionId
              ? '当前聊天已绑定到一条共享会话，直接发送消息即可继续。'
            : session?.session_type === 'draft'
              ? '当前聊天正在使用临时草稿线程（等同 `/t 0`）。可直接发送消息，或用 `/t` / `/new proj1` / `/new 绝对路径` 切换到正式会话。'
              : '当前聊天还没有绑定桌面会话。可先发送 `/t`，再用 `/t 1` 接管。',
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/history': {
      if (!currentBinding) {
        response = '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管桌面会话。';
        break;
      }

      const limit = getHistoryMessageLimit();
      const desktopMessages = currentBinding.sdkSessionId
        ? readDesktopSessionMessages(currentBinding.sdkSessionId, limit)
        : [];
      const { messages: storedMessages } = store.getMessages(currentBinding.codepilotSessionId, { limit });
      const messages = desktopMessages.length > 0 ? desktopMessages : storedMessages;
      if (messages.length === 0) {
        response = '当前会话还没有历史消息。';
        break;
      }
      const threadTitle = getDesktopThreadTitle(currentBinding.sdkSessionId);
      const session = store.getSession(currentBinding.codepilotSessionId);

      if (args === 'raw') {
        const header = buildCommandFields(
          '最近对话（raw）',
          [
            ['标题', threadTitle || getSessionDisplayName(session, currentBinding.workingDirectory)],
            ['来源', desktopMessages.length > 0 ? '桌面线程' : 'Bridge 缓存'],
            ['返回条数', `${messages.length} / 配置 ${limit}`],
          ],
          [],
          responseParseMode === 'Markdown',
        );
        const body = messages.map((message, index) => {
          if (responseParseMode === 'Markdown') {
            return `${index + 1}. **${formatHistoryRole(message.role)}**\n\n${truncateHistoryContent(formatStoredMessageContent(message.content))}`;
          }
          return `${index + 1}. ${formatHistoryRole(message.role)}\n${truncateHistoryContent(formatStoredMessageContent(message.content))}`;
        }).join('\n\n');
        response = [header, body].join('\n\n').trim();
        break;
      }

      const summary = await summarizeHistory(currentBinding);
      const header = buildCommandFields(
        '最近对话（整理）',
        [
          ['标题', threadTitle || getSessionDisplayName(session, currentBinding.workingDirectory)],
        ],
        [`原始记录可发送 \`/his raw\` 查看（完整命令：\`/history raw\`；当前抓取 ${messages.length} 条，配置 ${limit} 条）。`],
        responseParseMode === 'Markdown',
      );
      response = [header, summary].join('\n\n').trim();
      break;
    }

    case '/sessions': {
      const sessions = getDisplayedBridgeSessions(currentBinding?.codepilotSessionId);
      if (sessions.length === 0) {
        response = '当前没有内部会话。普通使用建议直接发送消息创建会话，或先用 `/t 1` 接管桌面会话。';
      } else {
        response = buildIndexedCommandList(
          '可切换的内部会话（兼容命令）',
          sessions.slice(0, 10).map((session) => {
            const threadTitle = session.sdk_session_id ? getDesktopThreadTitle(session.sdk_session_id) : null;
            return {
              heading: `${getSessionDisplayName(session, session.working_directory)}${session.id === currentBinding?.codepilotSessionId ? ' [当前]' : ''}`,
              details: [
                `状态：${formatRuntimeStatus(session)}`,
                `目录：${formatCommandPath(session.working_directory)}`,
              ],
            };
          }),
          [
            '普通使用建议直接通过 `/t` 切换桌面会话。',
            '兼容命令仍可用，例如 `/use 2`。',
          ],
          responseParseMode === 'Markdown',
        );
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abortController.abort();
        response = '正在停止当前任务...';
      } else {
        response = '当前没有正在运行的任务。';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = '用法：/perm allow|allow_session|deny <permission_id>';
        break;
      }
      const link = store.getPermissionLink(permId);
      if (!link) {
        response = '没有找到对应权限，或该权限已处理。';
        break;
      }
      if (
        currentBinding?.codepilotSessionId
        && link.sessionId
        && link.sessionId !== currentBinding.codepilotSessionId
      ) {
        response = '这条权限请求不属于当前会话。请先切回对应会话，再处理该权限。';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `已记录权限操作：${permAction}`;
      } else {
        response = '没有找到对应权限，或该权限已处理。';
      }
      break;
    }

    case '/unbind': {
      if (!currentBinding) {
        response = '当前聊天还没有绑定任何会话。';
        break;
      }
      store.deleteChannelBinding(currentBinding.id);
      response = buildCommandFields(
        '已解绑当前聊天',
        [
          ['聊天', formatBindingChatLabel(currentBinding)],
        ],
        [
          '这个聊天已释放当前会话绑定。',
          '之后如果直接发送文本，会自动进入新的临时草稿线程。',
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/help':
      responseParseMode = getFeedbackParseMode(adapter.channelType);
      response = [
        '**命令速览**',
        '',
        '**常用**',
        '- `/` 当前会话',
        '- `/h` 帮助',
        `- \`/t\` 最近 ${DEFAULT_DESKTOP_THREAD_LIST_LIMIT} 条桌面会话`,
        `- \`/t all\` 最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条桌面会话`,
        `- \`/t n 100\` 最近 100 条桌面会话（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）`,
        '- `/t 1` 接管第 1 条会话',
        '- `/n` 在当前工作目录下新建线程（仅保证 IM 可继续，不会自动出现在桌面会话列表）',
        '- `/n proj1` 在默认工作空间下新建项目会话',
        '- 直接发文本：继续当前会话；未绑定时进入临时草稿线程',
        '- `/his` 历史摘要',
        '',
        '**设置**',
        '- `/m` 查看模式；可用 `code | plan | ask`',
        '- `/r` 查看思考级别；可用 `1 | 2 | 3 | 4 | 5`',
        '- `/model` 查看当前模型；`/model gpt-5.4` 可切换，`/model default` 回退到默认模型',
        '- `/t 0` 临时草稿线程',
        '- `/t 0 reset` 重置草稿线程',
        '- `/unbind` 解绑当前聊天，释放当前会话',
        '- `/stop` 停止当前任务',
        '',
        '**其它**',
        '- `/his raw` 原始记录',
        '- `/perm allow|allow_session|deny <id>` 或 `1 / 2 / 3` 处理权限',
      ].join('\n');
      break;

    default:
      response = `未知命令：${rawCommand}\n发送 /h 或 /help 查看可用命令。`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: responseParseMode,
      replyToMessageId: msg.messageId,
    });
  }
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
  resolveNewWorkingDirectory,
  resolveNewSessionWorkingDirectory,
  resolveCommandAlias,
  parseDesktopThreadListArgs,
  toUserVisibleBindingError,
  toUserVisibleCommandError,
  normalizeReasoningEffort,
  resolveDisplayedModel,
  formatDisplayedModel,
  formatBindingChatLabel,
  formatRuntimeStatus,
  formatMirrorStatus,
  formatMirrorMessage,
  buildInteractiveStreamKey,
  buildMirrorStreamKey,
  appendMirrorTimeoutNotice,
  buildAdapterConfigFingerprint,
  consumeMirrorRecords,
  consumeBufferedMirrorTurns,
  flushTimedOutMirrorTurn,
  filterSuppressedMirrorRecords,
  reconcileIdleInteractiveTasks,
  beginMirrorSuppression,
  settleMirrorSuppression,
  persistSdkSessionUpdate,
  resetStateForTests,
};
