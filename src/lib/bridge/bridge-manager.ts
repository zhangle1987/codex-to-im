/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
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
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  getDesktopSessionByThreadId,
  listDesktopSessions,
  readDesktopSessionEventDeltaByFilePath,
  readDesktopSessionEventStreamByFilePath,
  readDesktopSessionMessages,
} from '../../desktop-sessions.js';
import type { DesktopSessionEvent } from '../../desktop-sessions.js';
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
import { CTI_HOME, DEFAULT_WORKSPACE_ROOT } from '../../config.js';

const GLOBAL_KEY = '__bridge_manager__';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HIDDEN_DRAFT_SESSIONS = 20;
const INTERNAL_SESSION_ROOT = path.join(CTI_HOME, 'runtime', 'internal-sessions');
const DRAFT_SESSION_PREFIX = 'Draft';
const HISTORY_SESSION_PREFIX = 'History Summary';
const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const MODE_OPTIONS_TEXT = '可选：`code`（直接执行，默认） `plan`（先分析再行动） `ask`（轻对话 / 草稿）';
const REASONING_OPTIONS_TEXT = '可选：`1=minimal` `2=low` `3=medium` `4=high` `5=xhigh`';
const MIRROR_POLL_INTERVAL_MS = 2_500;
const MIRROR_WATCH_DEBOUNCE_MS = 350;
const MIRROR_EVENT_BATCH_LIMIT = 8;
const MIRROR_SUPPRESSION_WINDOW_MS = 4_000;

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
      return args ? '/thread' : '/threads';
    case '/s':
      return args ? '/use' : '/sessions';
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

function getDisplayedDesktopThreads(limit = 10) {
  return listDesktopSessions(limit);
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

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
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

function isCommandMarkdownEnabled(channelType: string): boolean {
  const { store } = getBridgeContext();
  if (channelType === 'feishu') {
    return store.getSetting('bridge_feishu_command_markdown_enabled') !== 'false';
  }
  if (channelType === 'weixin') {
    return store.getSetting('bridge_weixin_command_markdown_enabled') === 'true';
  }
  return false;
}

function getCommandResponseParseMode(channelType: string): 'Markdown' | 'plain' {
  return isCommandMarkdownEnabled(channelType) ? 'Markdown' : 'plain';
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

function isSessionExpired(session: BridgeSession | null | undefined): boolean {
  if (!session?.expires_at) return false;
  const expiresAt = Date.parse(session.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function sanitizePathSlug(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scratch';
}

function getInternalScratchDir(kind: 'draft' | 'history_summary', key: string): string {
  const dir = path.join(INTERNAL_SESSION_ROOT, kind, sanitizePathSlug(key));
  ensureDirectory(dir);
  return dir;
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

function ensureWorkingDirectoryExists(workDir: string): void {
  ensureDirectory(workDir);
}

function makeDraftSessionName(address: { channelType: string; chatId: string }): string {
  return `${DRAFT_SESSION_PREFIX}:${address.channelType}:${address.chatId}`;
}

function makeHistorySummarySessionName(parentSessionId: string): string {
  return `${HISTORY_SESSION_PREFIX}:${parentSessionId}`;
}

function cleanupHiddenSessions(): void {
  const { store } = getBridgeContext();
  const bindings = store.listChannelBindings();
  const boundSessionIds = new Set(bindings.map((binding) => binding.codepilotSessionId));
  const hiddenSessions = store.listSessions().filter((session) => session.hidden === true);

  for (const session of hiddenSessions) {
    if (isSessionExpired(session) && !boundSessionIds.has(session.id)) {
      store.deleteSession(session.id);
    }
  }

  const draftSessions = store.listSessions()
    .filter((session) => session.hidden === true && session.session_type === 'draft' && !boundSessionIds.has(session.id))
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || '') - Date.parse(a.updated_at || a.created_at || ''));

  for (const session of draftSessions.slice(MAX_HIDDEN_DRAFT_SESSIONS)) {
    store.deleteSession(session.id);
  }
}

function getOrCreateDraftSession(address: { channelType: string; chatId: string }): BridgeSession {
  const { store } = getBridgeContext();
  cleanupHiddenSessions();
  const expectedName = makeDraftSessionName(address);
  const existing = store.listSessions().find((session) =>
    session.hidden === true
    && session.session_type === 'draft'
    && session.name === expectedName
    && !isSessionExpired(session)
  );

  if (existing) {
    store.updateSession(existing.id, {
      preferred_mode: 'ask',
      expires_at: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
    });
    return store.getSession(existing.id) || existing;
  }

  const scratchDir = getInternalScratchDir('draft', `${address.channelType}-${address.chatId}`);
  return store.createSession(
    expectedName,
    store.getSetting('bridge_default_model') || '',
    undefined,
    scratchDir,
    'ask',
    {
      hidden: true,
      sessionType: 'draft',
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
      reasoningEffort: 'low',
    },
  );
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
  const expectedName = makeDraftSessionName(address);
  for (const session of store.listSessions()) {
    if (session.hidden === true && session.session_type === 'draft' && session.name === expectedName) {
      store.deleteSession(session.id);
    }
  }
  return getOrCreateDraftSession(address);
}

function getOrCreateHistorySummarySession(parentSession: BridgeSession): BridgeSession {
  const { store } = getBridgeContext();
  cleanupHiddenSessions();
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

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
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
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
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
  activeTasks: Map<string, AbortController>;
  mirrorSubscriptions: Map<string, DesktopMirrorSubscription>;
  mirrorSyncInFlight: boolean;
  mirrorSuppressUntil: Map<string, number>;
  queuedCounts: Map<string, number>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
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
  if (!Object.prototype.hasOwnProperty.call(g[GLOBAL_KEY], 'mirrorSyncInFlight')) {
    g[GLOBAL_KEY].mirrorSyncInFlight = false;
  }
  return g[GLOBAL_KEY];
}

function getQueuedCount(sessionId: string): number {
  const state = getState();
  return state.queuedCounts.get(sessionId) || 0;
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

function markMirrorSuppressed(sessionId: string, durationMs = MIRROR_SUPPRESSION_WINDOW_MS): void {
  getState().mirrorSuppressUntil.set(sessionId, Date.now() + durationMs);
}

function isMirrorSuppressed(sessionId: string): boolean {
  const state = getState();
  const until = state.mirrorSuppressUntil.get(sessionId);
  if (!until) return false;
  if (until <= Date.now()) {
    state.mirrorSuppressUntil.delete(sessionId);
    return false;
  }
  return true;
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

function formatMirrorMessage(threadTitle: string | null, events: DesktopSessionEvent[]): string {
  const recentEvents = events
    .filter((event) => event.role !== 'user')
    .slice(-MIRROR_EVENT_BATCH_LIMIT)
    .map((event) => event.content.trim())
    .filter(Boolean);

  if (recentEvents.length === 0) {
    return '';
  }

  const title = threadTitle?.trim() || '桌面线程';
  return `${title} 回复:\n${recentEvents.join('\n\n')}`;
}

async function deliverMirrorEvents(subscription: DesktopMirrorSubscription, events: DesktopSessionEvent[]): Promise<void> {
  if (events.length === 0) return;

  const state = getState();
  const adapter = state.adapters.get(subscription.channelType);
  if (!adapter || !adapter.isRunning()) return;

  const text = formatMirrorMessage(getDesktopThreadTitle(subscription.threadId), events);
  if (!text) return;

  const response = await deliver(adapter, {
    address: {
      channelType: subscription.channelType,
      chatId: subscription.chatId,
    },
    text,
    parseMode: 'plain',
  }, {
    sessionId: subscription.sessionId,
    dedupKey: `mirror:${subscription.bindingId}:${events[0]?.signature}:${events[events.length - 1]?.signature}`,
  });

  if (!response.ok) {
    throw new Error(response.error || 'mirror delivery failed');
  }

  subscription.lastDeliveredAt = events[events.length - 1]?.timestamp || nowIso();
}

function removeMirrorSubscription(bindingId: string): void {
  const state = getState();
  const existing = state.mirrorSubscriptions.get(bindingId);
  if (!existing) return;
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
    existing.cursor = { initialized: false, lastEventCount: 0 };
    existing.lastDeliveredAt = session.mirror_last_event_at || null;
    existing.dirty = true;
    resetMirrorReadState(existing);
  } else if (filePathChanged) {
    existing.dirty = true;
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
  if (unchanged) {
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  let deliverableEvents: DesktopSessionEvent[] = [];

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
    const events = readDesktopSessionEventStreamByFilePath(subscription.filePath);
    const delta = reconcileDesktopMirrorCursor(subscription.cursor, events);
    subscription.cursor = delta.nextCursor;
    deliverableEvents = filterDuplicateAssistantEvents(previousCursor, delta.deliverableEvents);
    subscription.trailingText = '';
    subscription.fileOffset = snapshot.size;
  } else if (snapshot.size > subscription.fileOffset || subscription.trailingText) {
    const previousCursor = subscription.cursor;
    const delta = readDesktopSessionEventDeltaByFilePath(
      subscription.filePath,
      subscription.fileOffset,
      snapshot.size,
      subscription.trailingText,
    );
    deliverableEvents = filterDuplicateAssistantEvents(previousCursor, delta.events);
    subscription.cursor = advanceDesktopMirrorCursor(subscription.cursor, delta.events);
    subscription.trailingText = delta.trailingText;
    subscription.fileOffset = delta.nextOffset;
  }

  subscription.fileSize = snapshot.size;
  subscription.fileMtimeMs = snapshot.mtimeMs;
  subscription.fileIdentity = snapshot.identity;
  subscription.dirty = false;

  if (deliverableEvents.length === 0) {
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  if (getState().activeTasks.has(subscription.sessionId) || isMirrorSuppressed(subscription.sessionId)) {
    syncMirrorSessionState(subscription.sessionId);
    return;
  }

  try {
    await deliverMirrorEvents(subscription, deliverableEvents);
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
      await reconcileMirrorSubscription(subscription);
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
  const { store } = getBridgeContext();
  let changed = false;

  for (const channelType of getRegisteredTypes()) {
    const enabled = store.getSetting(`bridge_${channelType}_enabled`) === 'true';
    const existing = state.adapters.get(channelType);

    if (!enabled) {
      if (existing) {
        await stopAdapterInstance(channelType);
        changed = true;
      }
      continue;
    }

    if (existing) {
      continue;
    }

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (configError) {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
      continue;
    }

    try {
      state.adapters.set(channelType, adapter);
      state.adapterMeta.set(channelType, {
        lastMessageAt: null,
        lastError: null,
      });
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${channelType}`);
      if (options.startLoops && state.running && adapter.isRunning()) {
        runAdapterLoop(adapter);
      }
      changed = true;
    } catch (err) {
      state.adapters.delete(channelType);
      state.adapterMeta.delete(channelType);
      console.error(`[bridge-manager] Failed to start adapter ${channelType}:`, err);
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
  for (const abort of state.activeTasks.values()) {
    abort.abort();
  }
  state.activeTasks.clear();
  state.mirrorSuppressUntil.clear();
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
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
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
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
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
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
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
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
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
        parseMode: getCommandResponseParseMode(adapter.channelType),
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
        parseMode: getCommandResponseParseMode(adapter.channelType),
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: getCommandResponseParseMode(adapter.channelType),
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
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
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
            parseMode: getCommandResponseParseMode(adapter.channelType),
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: getCommandResponseParseMode(adapter.channelType),
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
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: getCommandResponseParseMode(adapter.channelType),
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
    await handleCommand(adapter, msg, rawText);
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

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);
  markMirrorSuppressed(binding.codepilotSessionId);
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

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

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
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
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
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
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
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    markMirrorSuppressed(binding.codepilotSessionId);
    state.activeTasks.delete(binding.codepilotSessionId);
    syncSessionRuntimeState(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
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
      text: `Command rejected: invalid input detected.`,
      parseMode: getCommandResponseParseMode(adapter.channelType),
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let responseParseMode: 'HTML' | 'Markdown' | 'plain' = getCommandResponseParseMode(adapter.channelType);
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
      // Abort any running task on the current session before creating a new one
      if (currentBinding) {
        const st = getState();
        const oldTask = st.activeTasks.get(currentBinding.codepilotSessionId);
        if (oldTask) {
          oldTask.abort();
          st.activeTasks.delete(currentBinding.codepilotSessionId);
          syncSessionRuntimeState(currentBinding.codepilotSessionId);
        }
      }

      let workDir: string | undefined;
      if (args) {
        const resolved = resolveNewWorkingDirectory(args);
        if (!resolved.ok) {
          response = resolved.message;
          break;
        }
        workDir = resolved.workDir;
        ensureWorkingDirectoryExists(workDir);
      }
      const binding = router.createBinding(msg.address, workDir);
      const session = store.getSession(binding.codepilotSessionId);
      response = buildCommandFields(
        '已新建会话',
        [
          ['标题', getSessionDisplayName(session, binding.workingDirectory)],
          ['目录', formatCommandPath(binding.workingDirectory)],
          ['模式', binding.mode],
        ],
        ['接下来直接发送文本即可继续。'],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/bind': {
      if (!args) {
        response = '用法：/bind <序号>';
        break;
      }

      const prefersThreadList = parseListIndex(args) !== null;
      const displayedThreads = getDisplayedDesktopThreads(10);
      if (prefersThreadList) {
        const threadPick = resolveByIndexOrPrefix(args, displayedThreads, (session) => session.threadId);
        if (threadPick.match) {
          const importedBinding = router.bindToSdkSession(msg.address, threadPick.match.threadId, {
            workingDirectory: threadPick.match.cwd,
            displayName: threadPick.match.title,
          });
          const session = store.getSession(importedBinding.codepilotSessionId);
          response = buildCommandFields(
            '已绑定桌面会话',
            [
              ['标题', threadPick.match.title || getSessionDisplayName(session, importedBinding.workingDirectory)],
              ['目录', formatCommandPath(importedBinding.workingDirectory)],
            ],
            ['接下来直接发送文本即可继续。'],
            responseParseMode === 'Markdown',
          );
          break;
        }
      }

      const displayedSessions = getDisplayedBridgeSessions(currentBinding?.codepilotSessionId);
      const sessionPick = resolveByIndexOrPrefix(args, displayedSessions, (session) => session.id);
      if (sessionPick.ambiguous) {
        response = '匹配到多个兼容会话，请使用更长的编号，或直接改用 `/t` 切换桌面会话。';
        break;
      }
      if (sessionPick.match) {
        const binding = router.bindToSession(msg.address, sessionPick.match.id);
        if (binding) {
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
      }

      const threadPick = resolveByIndexOrPrefix(args, displayedThreads, (session) => session.threadId);
      if (threadPick.ambiguous) {
        response = '匹配到多个桌面会话，请先发送 `/t` 查看列表，再用 `/t 1` 这种序号切换。';
        break;
      }
      if (!threadPick.match) {
        response = '没有找到对应目标。先发送 `/t` 查看桌面会话，再按序号切换。';
        break;
      }

      const importedBinding = router.bindToSdkSession(msg.address, threadPick.match.threadId, {
        workingDirectory: threadPick.match.cwd,
        displayName: threadPick.match.title,
      });
      const importedSession = store.getSession(importedBinding.codepilotSessionId);
      response = buildCommandFields(
        '已绑定桌面会话',
        [
          ['标题', threadPick.match.title || getSessionDisplayName(importedSession, importedBinding.workingDirectory)],
          ['目录', formatCommandPath(importedBinding.workingDirectory)],
        ],
        ['接下来直接发送文本即可继续。'],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/thread': {
      if (args === '0' || args === '0 reset') {
        const draftSession = args === '0 reset'
          ? resetDraftSession(msg.address)
          : getOrCreateDraftSession(msg.address);
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
        response = '用法：/thread <序号>，或 /thread 0 进入临时草稿线程';
        break;
      }
      const displayedThreads = getDisplayedDesktopThreads(10);
      const threadPick = resolveByIndexOrPrefix(args, displayedThreads, (session) => session.threadId);
      if (threadPick.ambiguous) {
        response = '匹配到多个桌面会话，请先发送 `/t` 查看列表，再用 `/t 1` 这种序号切换。';
        break;
      }
      if (!threadPick.match) {
        if (validateSessionId(args)) {
          const desktop = getDesktopSessionByThreadId(args);
          const binding = router.bindToSdkSession(msg.address, args, desktop ? {
            workingDirectory: desktop.cwd,
            displayName: desktop.title,
          } : undefined);
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
      const binding = router.bindToSdkSession(msg.address, threadPick.match.threadId, {
        workingDirectory: threadPick.match.cwd,
        displayName: threadPick.match.title,
      });
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
      const desktopSessions = getDisplayedDesktopThreads(10);
      if (desktopSessions.length === 0) {
        response = '没有找到最近桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。';
        break;
      }
      response = buildIndexedCommandList(
        '最近桌面会话',
        desktopSessions.map((session) => ({
          heading: session.title || '未命名线程',
          details: [
            `目录：${formatCommandPath(session.cwd)}`,
            `来源：${session.originator || 'Codex Desktop'}`,
          ],
        })),
        [
          '发送 `/t 1` 可接管第 1 条桌面会话。',
          '完整命令仍兼容，例如 `/thread 1`。',
        ],
        responseParseMode === 'Markdown',
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
      const binding = router.bindToSession(msg.address, sessionPick.match.id);
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
      response = '当前版本已不支持 /cwd。请使用 /new 新建会话，或使用 /thread /bind /use 切换到已有工作空间。';
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

    case '/status': {
      const binding = router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      const threadTitle = getDesktopThreadTitle(binding.sdkSessionId);
      const sandboxMode = resolveEffectiveSandboxMode();
      const reasoningEffort = resolveEffectiveReasoningEffort(session);
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
          ['模型', binding.model || 'default'],
          ['类型', sessionKind],
          ['运行状态', formatRuntimeStatus(session)],
          ['共享镜像', formatMirrorStatus(session)],
          ['文件系统权限', sandboxMode],
          ['思考级别', formatReasoningEffort(reasoningEffort)],
        ],
        [
          binding.sdkSessionId
            ? '当前聊天已绑定到一条共享会话，直接发送消息即可继续。'
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
            ['来源', desktopMessages.length > 0 ? 'desktop thread' : 'bridge cache'],
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
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        syncSessionRuntimeState(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
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

    case '/help':
      responseParseMode = getCommandResponseParseMode(adapter.channelType);
      response = [
        '**命令速览**',
        '',
        '**常用**',
        '- `/` 当前会话',
        '- `/h` 帮助',
        '- `/t` 最近桌面会话',
        '- `/t 1` 接管第 1 条会话',
        '- `/n proj1` 新建会话',
        '- `/his` 历史摘要',
        '',
        '**设置**',
        '- `/m` 查看模式；可用 `code | plan | ask`',
        '- `/r` 查看思考级别；可用 `1 | 2 | 3 | 4 | 5`',
        '- `/t 0` 临时草稿线程',
        '- `/t 0 reset` 重置草稿线程',
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

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  resolveNewWorkingDirectory,
  resolveCommandAlias,
  normalizeReasoningEffort,
  formatRuntimeStatus,
  formatMirrorStatus,
  formatMirrorMessage,
};
