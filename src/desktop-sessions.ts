import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BridgeMessage } from './lib/bridge/host.js';
import type { TaskProgressInfo } from './lib/bridge/types.js';

export interface DesktopSessionSummary {
  threadId: string;
  filePath: string;
  cwd: string;
  originator: string;
  source?: string;
  cliVersion?: string;
  firstSeenAt: string;
  lastEventAt: string;
  title: string;
  activeEstimate: boolean;
}

export interface DesktopSessionEvent {
  signature: string;
  role: 'user' | 'assistant' | 'commentary';
  content: string;
  timestamp: string;
}

export interface DesktopSessionEventDelta {
  events: DesktopSessionEvent[];
  nextOffset: number;
  trailingText: string;
}

export interface DesktopMirrorRecord {
  signature: string;
  type: 'message' | 'reasoning' | 'plan_update' | 'task_started' | 'task_complete' | 'task_aborted' | 'tool_started' | 'tool_finished';
  role?: 'user' | 'assistant' | 'commentary';
  content: string;
  timestamp: string;
  turnId?: string;
  toolId?: string;
  toolName?: string;
  isError?: boolean;
  tasks?: TaskProgressInfo[];
}

export interface DesktopMirrorRecordDelta {
  records: DesktopMirrorRecord[];
  nextOffset: number;
  trailingText: string;
  nextTurnId: string | null;
  nextSpecialCallIds: string[];
  unknownKinds: string[];
}

interface SessionMetaLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    timestamp?: string;
    cwd?: string;
    originator?: unknown;
    cli_version?: unknown;
    source?: unknown;
  };
}

interface SessionMessageLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    name?: unknown;
    namespace?: unknown;
    arguments?: string;
    execution?: unknown;
    call_id?: unknown;
    id?: unknown;
    output?: unknown;
    is_error?: boolean;
    status?: unknown;
    input?: unknown;
    query?: unknown;
    server?: unknown;
    tool?: unknown;
    summary?: unknown;
    aggregated_output?: unknown;
    formatted_output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exit_code?: unknown;
    success?: unknown;
    changes?: unknown;
    revised_prompt?: unknown;
    saved_path?: unknown;
    tools?: unknown;
    content?: Array<{
      type?: string;
      text?: unknown;
    }>;
  };
}

interface SessionEventLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    message?: unknown;
    text?: unknown;
    final_response?: unknown;
    response?: unknown;
    phase?: unknown;
    last_agent_message?: unknown;
    turn_id?: string;
    turnId?: string;
    reason?: unknown;
    call_id?: unknown;
    callId?: unknown;
    id?: unknown;
    query?: unknown;
    command?: unknown;
    aggregated_output?: unknown;
    formatted_output?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exit_code?: unknown;
    status?: unknown;
    success?: unknown;
    changes?: unknown;
    revised_prompt?: unknown;
    saved_path?: unknown;
    tool?: unknown;
    arguments?: unknown;
    content_items?: unknown;
    error?: unknown;
    invocation?: {
      server?: unknown;
      tool?: unknown;
      arguments?: unknown;
    };
  };
}

interface TurnContextLine {
  timestamp?: string;
  type?: string;
  payload?: {
    turn_id?: string;
  };
}

interface SessionIndexLine {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

interface ThreadIndexEntry {
  title: string;
  updatedAt: string;
}

interface VisibleDesktopThreadRow {
  id: string;
  updatedAtMs: number;
}

interface CodexGlobalState {
  'electron-saved-workspace-roots'?: unknown;
}

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_TITLE_SCAN_BYTES = 512 * 1024;
const TITLE_MAX_CHARS = 72;

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function getCodexSessionsRoot(): string {
  return path.join(getCodexHome(), 'sessions');
}

function getArchivedSessionsRoot(): string {
  return path.join(getCodexHome(), 'archived_sessions');
}

function getSessionIndexPath(): string {
  return path.join(getCodexHome(), 'session_index.jsonl');
}

function getCodexGlobalStatePath(): string {
  return path.join(getCodexHome(), '.codex-global-state.json');
}

function getDesktopStateDbPath(): string | null {
  const codexHome = getCodexHome();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(codexHome, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
    .map((entry) => path.join(codexHome, entry.name))
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });

  return candidates[0] || null;
}

function extractThreadIdFromRolloutName(name: string): string | null {
  const match = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function normalizeComparablePath(value: string): string {
  if (!value) return '';
  const stripped = value.replace(/^\\\\\?\\/, '');
  return path.resolve(stripped).replace(/[\\/]+$/, '').toLowerCase();
}

function isInternalSkillWorkspace(cwd: string): boolean {
  const normalizedCwd = normalizeComparablePath(cwd);
  if (!normalizedCwd) return false;

  const skillsRoot = normalizeComparablePath(path.join(getCodexHome(), 'skills'));
  if (!skillsRoot) return false;

  return normalizedCwd === skillsRoot || normalizedCwd.startsWith(`${skillsRoot}\\`) || normalizedCwd.startsWith(`${skillsRoot}/`);
}

function loadSavedWorkspaceRoots(): string[] | null {
  const statePath = getCodexGlobalStatePath();
  if (!fs.existsSync(statePath)) return null;

  let parsed: CodexGlobalState;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as CodexGlobalState;
  } catch {
    return null;
  }

  const roots = Array.isArray(parsed['electron-saved-workspace-roots'])
    ? parsed['electron-saved-workspace-roots']
        .map((value) => (typeof value === 'string' ? normalizeComparablePath(value) : ''))
        .filter(Boolean)
    : [];

  return roots.length > 0 ? roots : null;
}

function isWithinSavedWorkspaceRoots(cwd: string, roots: string[] | null): boolean {
  if (!roots || roots.length === 0) return true;
  const normalizedCwd = normalizeComparablePath(cwd);
  if (!normalizedCwd) return false;

  return roots.some((root) =>
    normalizedCwd === root || normalizedCwd.startsWith(`${root}\\`) || normalizedCwd.startsWith(`${root}/`));
}

function loadArchivedThreadIds(): Set<string> {
  const archivedRoot = getArchivedSessionsRoot();
  if (!fs.existsSync(archivedRoot)) return new Set();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archivedRoot, { withFileTypes: true });
  } catch {
    return new Set();
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const threadId = extractThreadIdFromRolloutName(entry.name);
    if (threadId) ids.add(threadId);
  }
  return ids;
}

function readFirstLine(filePath: string, maxBytes = MAX_SESSION_META_BYTES): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    const buffer = Buffer.alloc(4096);

    while (bytesReadTotal < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, bytesReadTotal);
      if (bytesRead <= 0) break;

      const slice = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(slice);
      bytesReadTotal += bytesRead;

      const newlineIndex = slice.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const combined = Buffer.concat(chunks);
        return combined.subarray(0, combined.indexOf(0x0a)).toString('utf-8').replace(/\r$/, '');
      }
    }

    return Buffer.concat(chunks).toString('utf-8').split(/\r?\n/, 1)[0] || '';
  } finally {
    fs.closeSync(fd);
  }
}

function readFilePrefix(filePath: string, maxBytes = MAX_SESSION_TITLE_SCAN_BYTES): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, 64 * 1024));
    const chunks: Buffer[] = [];
    let offset = 0;

    while (offset < maxBytes) {
      const bytesToRead = Math.min(buffer.length, maxBytes - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      offset += bytesRead;
    }

    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function walkSessionFiles(dirPath: string, target: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(entryPath, target);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      target.push(entryPath);
    }
  }
}

function isDesktopLike(meta: SessionMetaLine['payload']): boolean {
  const originator = typeof meta?.originator === 'string' ? meta.originator.toLowerCase() : '';
  const source = typeof meta?.source === 'string' ? meta.source.toLowerCase() : '';
  if (source === 'exec') return false;
  return originator.includes('desktop') || source === 'vscode' || source === 'desktop';
}

function loadThreadIndexEntries(archivedThreadIds: Set<string>): Map<string, ThreadIndexEntry> {
  const indexPath = getSessionIndexPath();
  if (!fs.existsSync(indexPath)) return new Map();

  let content = '';
  try {
    content = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return new Map();
  }

  const titles = new Map<string, ThreadIndexEntry>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let parsed: SessionIndexLine;
    try {
      parsed = JSON.parse(line) as SessionIndexLine;
    } catch {
      continue;
    }

    const threadId = parsed.id?.trim();
    const title = trimTitle(parsed.thread_name || '');
    if (!threadId || !title || archivedThreadIds.has(threadId)) continue;

    const updatedAt = parsed.updated_at || '';
    const existing = titles.get(threadId);
    if (!existing || updatedAt >= existing.updatedAt) {
      titles.set(threadId, { title, updatedAt });
    }
  }

  return titles;
}

function parseUpdatedAtValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function loadVisibleDesktopThreads(limit?: number): VisibleDesktopThreadRow[] | null {
  const dbPath = getDesktopStateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
    const sql = `
      SELECT id, updated_at
      FROM threads
      WHERE archived = 0
        AND source != 'exec'
      ORDER BY updated_at DESC
      ${hasLimit ? 'LIMIT ?' : ''}
    `;
    const rows = hasLimit
      ? db.prepare(sql).all(Math.max(1, Math.floor(limit!))) as Array<{ id?: string; updated_at?: string | number }>
      : db.prepare(sql).all() as Array<{ id?: string; updated_at?: string | number }>;

    const ids = rows
      .map((row) => {
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        if (!id) return null;
        return {
          id,
          updatedAtMs: parseUpdatedAtValue(row.updated_at),
        } satisfies VisibleDesktopThreadRow;
      })
      .filter((row): row is VisibleDesktopThreadRow => Boolean(row));

    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function buildFallbackTitle(threadId: string, filePath: string, cwd: string): string {
  try {
    const content = readFilePrefix(filePath);
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;

      let parsed: SessionMessageLine | SessionEventLine;
      try {
        parsed = JSON.parse(line) as SessionMessageLine | SessionEventLine;
      } catch {
        continue;
      }

      if (!isSessionEventLine(parsed) || parsed.payload?.type !== 'user_message') continue;

      const firstUserMessage = trimTitle(extractNormalizedFreeText(parsed.payload.message));
      if (firstUserMessage) return firstUserMessage;
    }
  } catch {
    // Best-effort fallback only.
  }

  const dirName = trimTitle(path.basename(cwd || ''));
  if (dirName) return dirName;
  return `Session ${threadId.slice(0, 8)}`;
}

function parseDesktopSession(
  filePath: string,
  threadIndexEntries: Map<string, ThreadIndexEntry>,
  archivedThreadIds: Set<string>,
): DesktopSessionSummary | null {
  const firstLine = readFirstLine(filePath);
  if (!firstLine) return null;

  let parsed: SessionMetaLine;
  try {
    parsed = JSON.parse(firstLine) as SessionMetaLine;
  } catch {
    return null;
  }

  if (parsed.type !== 'session_meta' || !parsed.payload?.id || !isDesktopLike(parsed.payload)) {
    return null;
  }

  if (archivedThreadIds.has(parsed.payload.id)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cwd = parsed.payload.cwd || '';
  if (isInternalSkillWorkspace(cwd)) {
    return null;
  }
  const lastEventAt = stat.mtime.toISOString();
  const firstSeenAt = parsed.payload.timestamp || parsed.timestamp || stat.birthtime.toISOString();
  const threadId = parsed.payload.id;
  const title = threadIndexEntries.get(threadId)?.title || buildFallbackTitle(threadId, filePath, cwd);

  return {
    threadId,
    filePath,
    cwd,
    originator: typeof parsed.payload.originator === 'string' ? parsed.payload.originator : 'Codex Desktop',
    source: typeof parsed.payload.source === 'string' ? parsed.payload.source : undefined,
    cliVersion: typeof parsed.payload.cli_version === 'string' ? parsed.payload.cli_version : undefined,
    firstSeenAt,
    lastEventAt,
    title,
    activeEstimate: Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS,
  };
}

function trimTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= TITLE_MAX_CHARS) return normalized;
  return `${normalized.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

function normalizeFreeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeStructuredText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function collectStructuredTextParts(value: unknown, parts: string[], depth = 0): void {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredTextParts(item, parts, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    parts.push(record.text);
  }
  if (typeof record.message === 'string') {
    parts.push(record.message);
  }
  if (typeof record.summary === 'string') {
    parts.push(record.summary);
  }
  if ('content' in record) {
    collectStructuredTextParts(record.content, parts, depth + 1);
  }
  if ('items' in record) {
    collectStructuredTextParts(record.items, parts, depth + 1);
  }
}

function extractNormalizedFreeText(value: unknown): string {
  if (typeof value === 'string') return normalizeFreeText(value);
  const parts: string[] = [];
  collectStructuredTextParts(value, parts);
  return parts.length > 0 ? normalizeFreeText(parts.join('\n')) : '';
}

function extractNormalizedStructuredText(value: unknown): string {
  if (typeof value === 'string') return normalizeStructuredText(value);
  const parts: string[] = [];
  collectStructuredTextParts(value, parts);
  return parts.length > 0 ? normalizeStructuredText(parts.join('\n\n')) : '';
}

function parseJsonSafely(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeTaskStatus(value: unknown): TaskProgressInfo['status'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'in_progress' || normalized === 'running' || normalized === 'active') {
    return 'in_progress';
  }
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
    return 'completed';
  }
  return 'pending';
}

function parseTaskProgressItems(value: unknown): TaskProgressInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as { step?: unknown; text?: unknown; status?: unknown };
      const text = extractNormalizedStructuredText(record.text ?? record.step);
      if (!text) return null;
      return {
        text,
        status: normalizeTaskStatus(record.status),
      } satisfies TaskProgressInfo;
    })
    .filter((item): item is TaskProgressInfo => Boolean(item));
}

function parseUpdatePlanTasks(argumentsJson: string | undefined): TaskProgressInfo[] {
  const parsed = parseJsonSafely(argumentsJson) as { plan?: unknown; tasks?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') return [];
  return parseTaskProgressItems(parsed.plan ?? parsed.tasks);
}

function extractReasoningSummary(payload: { summary?: unknown; content?: unknown; text?: unknown; message?: unknown }): string {
  for (const value of [payload.summary, payload.content, payload.text, payload.message]) {
    const text = extractNormalizedStructuredText(value);
    if (text) return text;
  }
  return '';
}

function extractToolOutputText(value: unknown): string {
  if (typeof value !== 'string') return extractNormalizedFreeText(value);
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonSafely(trimmed) as { output?: unknown } | null;
    if (parsed && typeof parsed === 'object') {
      const extracted = extractNormalizedFreeText(parsed.output ?? parsed);
      if (extracted) return extracted;
    }
  }
  return extractNormalizedFreeText(value);
}

function summarizePatchChanges(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([filePath, detail]) => {
      const kind = detail && typeof detail === 'object'
        ? extractNormalizedFreeText((detail as { type?: unknown; kind?: unknown }).type ?? (detail as { kind?: unknown }).kind)
        : '';
      return kind ? `${kind}: ${filePath}` : filePath;
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeToolSearchOutput(value: unknown): string {
  if (!Array.isArray(value)) return '';
  let count = 0;
  const names: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const namespaceName = extractNormalizedFreeText((entry as { name?: unknown }).name);
    if (namespaceName) names.push(namespaceName);
    const tools = (entry as { tools?: unknown }).tools;
    if (Array.isArray(tools)) count += tools.length;
  }
  const prefix = count > 0 ? `Found ${count} tools` : '';
  const suffix = names.length > 0 ? names.slice(0, 5).join(', ') : '';
  return [prefix, suffix].filter(Boolean).join(': ');
}

function getDynamicToolCallId(payload: { call_id?: unknown; callId?: unknown }): string {
  return extractNormalizedFreeText(payload.call_id ?? payload.callId);
}

function getImageGenerationToolId(payload: { call_id?: unknown; callId?: unknown; id?: unknown }): string {
  return extractNormalizedFreeText(payload.call_id ?? payload.callId ?? payload.id);
}

function limitDesktopToolContent(value: string, maxChars = 1000): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...`;
}

function summarizeImageGenerationOutput(payload: { saved_path?: unknown; revised_prompt?: unknown; status?: unknown; error?: unknown }): string {
  const savedPath = extractNormalizedFreeText(payload.saved_path);
  const prompt = extractNormalizedStructuredText(payload.revised_prompt);
  const error = extractNormalizedStructuredText(payload.error);
  const status = extractNormalizedFreeText(payload.status);
  const parts: string[] = [];
  if (savedPath) parts.push(`Saved: ${savedPath}`);
  if (prompt) parts.push(`Prompt: ${limitDesktopToolContent(prompt)}`);
  if (error) parts.push(`Error: ${limitDesktopToolContent(error)}`);
  if (parts.length === 0 && status) parts.push(`Status: ${status}`);
  return parts.join('\n\n');
}

function formatDesktopToolName(namespaceValue: unknown, nameValue: unknown): string {
  const name = extractNormalizedFreeText(nameValue);
  if (!name) return '';
  const namespace = extractNormalizedFreeText(namespaceValue);
  if (!namespace) return name;
  if (name.startsWith(namespace)) return name;
  return namespace.endsWith('__') || namespace.endsWith('/') || namespace.endsWith('.')
    ? `${namespace}${name}`
    : `${namespace}__${name}`;
}

function createDesktopEventSignature(rawLine: string): string {
  return crypto.createHash('sha1').update(rawLine).digest('hex');
}

interface CompleteUtf8LineRange {
  content: string;
  nextOffset: number;
}

function readCompleteUtf8LineRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
): CompleteUtf8LineRange {
  const safeStart = Math.max(0, startOffset);
  const safeEnd = Math.max(safeStart, endOffset);
  const bytesToRead = safeEnd - safeStart;
  if (bytesToRead <= 0) return { content: '', nextOffset: safeStart };

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, bytesToRead - totalRead, safeStart + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    const readBuffer = buffer.subarray(0, totalRead);
    const lastNewlineIndex = readBuffer.lastIndexOf(0x0a);
    if (lastNewlineIndex < 0) {
      return { content: '', nextOffset: safeStart };
    }
    const consumedBytes = lastNewlineIndex + 1;
    return {
      content: readBuffer.subarray(0, consumedBytes).toString('utf-8'),
      nextOffset: safeStart + consumedBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function isSessionEventLine(line: SessionMessageLine | SessionEventLine | TurnContextLine): line is SessionEventLine {
  return line.type === 'event_msg';
}

function isSessionMessageLine(line: SessionMessageLine | SessionEventLine | TurnContextLine): line is SessionMessageLine {
  return line.type === 'response_item';
}

function isTurnContextLine(line: SessionMessageLine | SessionEventLine | TurnContextLine): line is TurnContextLine {
  return line.type === 'turn_context';
}

const IGNORED_EVENT_MSG_TYPES = new Set([
  'context_compacted',
  'thread_settings_applied',
  'thread_goal_updated',
  'thread_name_updated',
  'thread_rolled_back',
  'token_count',
]);

const IGNORED_RESPONSE_ITEM_TYPES = new Set([
  'image_generation_call',
  'web_search_call',
]);

const IGNORED_TOP_LEVEL_TYPES = new Set([
  'compacted',
  'session_meta',
  'turn_context',
  'world_state',
]);

const TERMINAL_COMPLETION_EVENT_TYPES = new Set([
  'task_complete',
  'turn.completed',
  'turn_completed',
]);

function isTerminalCompletionEventType(value: unknown): boolean {
  return typeof value === 'string' && TERMINAL_COMPLETION_EVENT_TYPES.has(value.trim());
}

function getEventTurnId(payload: SessionEventLine['payload']): string {
  return payload?.turn_id || payload?.turnId || '';
}

function extractTerminalCompletionText(payload: SessionEventLine['payload']): string {
  if (!payload) return '';
  for (const value of [
    payload.last_agent_message,
    payload.message,
    payload.text,
    payload.final_response,
    payload.response,
  ]) {
    const text = extractNormalizedStructuredText(value);
    if (text) return text;
  }
  return '';
}

export function isSyntheticDesktopUserContext(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith('<environment_context>')
    && normalized.endsWith('</environment_context>');
}

function isIgnoredMirrorLineKind(line: SessionMessageLine | SessionEventLine | TurnContextLine): boolean {
  if (isSessionEventLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return IGNORED_EVENT_MSG_TYPES.has(payloadType);
  }
  if (isSessionMessageLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return IGNORED_RESPONSE_ITEM_TYPES.has(payloadType);
  }
  const topLevelType = typeof line.type === 'string' ? line.type.trim() : '';
  return IGNORED_TOP_LEVEL_TYPES.has(topLevelType);
}

function describeUnhandledMirrorLineKind(
  line: SessionMessageLine | SessionEventLine | TurnContextLine,
): string | null {
  if (isIgnoredMirrorLineKind(line)) return null;
  if (isSessionEventLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return `event_msg:${payloadType || '<unknown>'}`;
  }
  if (isSessionMessageLine(line)) {
    const payloadType = typeof line.payload?.type === 'string' ? line.payload.type.trim() : '';
    return `response_item:${payloadType || '<unknown>'}`;
  }
  const topLevelType = typeof line.type === 'string' ? line.type.trim() : '';
  return `top_level:${topLevelType || '<unknown>'}`;
}

export function listDesktopSessions(limit?: number): DesktopSessionSummary[] {
  const root = getCodexSessionsRoot();
  if (!fs.existsSync(root)) return [];
  const archivedThreadIds = loadArchivedThreadIds();
  const threadIndexEntries = loadThreadIndexEntries(archivedThreadIds);
  const savedWorkspaceRoots = loadSavedWorkspaceRoots();
  const visibleThreads = loadVisibleDesktopThreads(limit);
  const visibleThreadIds = visibleThreads?.map((thread) => thread.id) || null;
  const visibleThreadSet = visibleThreadIds ? new Set(visibleThreadIds) : null;
  const visibleThreadUpdatedAt = new Map(visibleThreads?.map((thread) => [thread.id, thread.updatedAtMs]) || []);
  const oldestVisibleUpdatedAtMs = visibleThreads && visibleThreads.length > 0
    ? Math.min(...visibleThreads.map((thread) => thread.updatedAtMs || Number.MAX_SAFE_INTEGER))
    : 0;

  const files: string[] = [];
  walkSessionFiles(root, files);

  const allSessions = new Map<string, DesktopSessionSummary>();
  for (const filePath of files) {
    const session = parseDesktopSession(filePath, threadIndexEntries, archivedThreadIds);
    if (!session) continue;
    if (!isWithinSavedWorkspaceRoots(session.cwd, savedWorkspaceRoots)) continue;
    allSessions.set(session.threadId, session);
  }

  const sessions = Array.from(allSessions.values());

  if (visibleThreadSet && visibleThreadIds) {
    const mergedThreadIds = new Set<string>(visibleThreadIds);
    if (oldestVisibleUpdatedAtMs > 0) {
      for (const session of sessions) {
        if (visibleThreadSet.has(session.threadId)) continue;
        const candidateUpdatedAtMs = parseUpdatedAtValue(threadIndexEntries.get(session.threadId)?.updatedAt || session.lastEventAt);
        if (candidateUpdatedAtMs > oldestVisibleUpdatedAtMs) {
          mergedThreadIds.add(session.threadId);
        }
      }
    }

    return sessions
      .filter((session) => mergedThreadIds.has(session.threadId))
      .sort((left, right) => {
        const rightUpdatedAtMs = visibleThreadUpdatedAt.get(right.threadId)
          || parseUpdatedAtValue(threadIndexEntries.get(right.threadId)?.updatedAt || right.lastEventAt);
        const leftUpdatedAtMs = visibleThreadUpdatedAt.get(left.threadId)
          || parseUpdatedAtValue(threadIndexEntries.get(left.threadId)?.updatedAt || left.lastEventAt);
        return rightUpdatedAtMs - leftUpdatedAtMs;
      })
      .slice(0, typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined);
  }

  return sessions
    .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))
    .slice(0, typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : undefined);
}

const DESKTOP_SESSION_LOOKUP_CACHE_TTL_MS = 1_000;
let desktopSessionLookupCache: {
  expiresAt: number;
  sessions: Map<string, DesktopSessionSummary>;
} | null = null;

export function getDesktopSessionByThreadId(threadId: string): DesktopSessionSummary | null {
  const timestamp = Date.now();
  if (!desktopSessionLookupCache || desktopSessionLookupCache.expiresAt <= timestamp) {
    desktopSessionLookupCache = {
      expiresAt: timestamp + DESKTOP_SESSION_LOOKUP_CACHE_TTL_MS,
      sessions: new Map(listDesktopSessions().map((session) => [session.threadId, session])),
    };
  }
  return desktopSessionLookupCache.sessions.get(threadId) || null;
}

export function isArchivedDesktopThread(threadId: string): boolean {
  return loadArchivedThreadIds().has(threadId);
}

function extractDesktopMessageText(line: SessionMessageLine): string {
  const parts = line.payload?.content
    ?.map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean) || [];
  const text = parts.join('\n').trim();
  if (!text) return '';
  if (line.payload?.phase === 'commentary') {
    return `[commentary]\n${text}`;
  }
  return text;
}

function pushDesktopSessionEvent(
  events: DesktopSessionEvent[],
  parsed: SessionMessageLine | SessionEventLine,
  rawLine: string,
): void {
  if (isSessionEventLine(parsed) && parsed.payload?.type === 'user_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return;
    events.push({
      signature: createDesktopEventSignature(rawLine),
      role: 'user',
      content: text,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && parsed.payload?.type === 'agent_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return;
    const role = parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant';
    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === role && lastEvent.content === text) return;
    events.push({
      signature: createDesktopEventSignature(rawLine),
      role,
      content: text,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionEventLine(parsed) && isTerminalCompletionEventType(parsed.payload?.type)) {
    const text = extractTerminalCompletionText(parsed.payload);
    if (!text) return;

    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === 'assistant' && lastEvent.content === text) {
      return;
    }

    events.push({
      signature: createDesktopEventSignature(rawLine),
      role: 'assistant',
      content: text,
      timestamp: parsed.timestamp || '',
    });
    return;
  }

  if (isSessionMessageLine(parsed) && parsed.payload?.type === 'message' && parsed.payload.role === 'assistant') {
    const text = extractDesktopMessageText(parsed);
    if (!text) return;
    const role = parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant';
    const content = parsed.payload.phase === 'commentary' ? text.replace(/^\[commentary\]\n/, '') : text;
    const lastEvent = events[events.length - 1];
    if (lastEvent?.role === role && lastEvent.content === content) return;
    events.push({
      signature: createDesktopEventSignature(rawLine),
      role,
      content,
      timestamp: parsed.timestamp || '',
    });
  }
}

function pushDesktopMirrorRecord(
  records: DesktopMirrorRecord[],
  parsed: SessionMessageLine | SessionEventLine | TurnContextLine,
  rawLine: string,
  activeTurnId: string | null,
  activeSpecialCallIds: Set<string>,
): boolean {
  if (isSessionEventLine(parsed)) {
    return pushDesktopMirrorEventRecord(records, parsed, rawLine, activeTurnId);
  }
  if (isSessionMessageLine(parsed)) {
    return pushDesktopMirrorResponseRecord(records, parsed, rawLine, activeTurnId, activeSpecialCallIds);
  }
  return false;
}

function pushDesktopMirrorEventRecord(
  records: DesktopMirrorRecord[],
  parsed: SessionEventLine,
  rawLine: string,
  activeTurnId: string | null,
): boolean {
  const signature = createDesktopEventSignature(rawLine);
  const timestamp = parsed.timestamp || '';

  if (parsed.payload?.type === 'task_started') {
    records.push({
      signature,
      type: 'task_started',
      content: '',
      timestamp,
      turnId: getEventTurnId(parsed.payload),
    });
    return true;
  }

  if (parsed.payload?.type === 'turn_aborted') {
    records.push({
      signature,
      type: 'task_aborted',
      content: extractNormalizedStructuredText(parsed.payload.reason),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (isIgnoredMirrorLineKind(parsed)) {
    return true;
  }

  if (parsed.payload?.type === 'agent_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text) return true;
    records.push({
      signature,
      type: 'message',
      role: parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'agent_reasoning') {
    const text = extractNormalizedStructuredText(parsed.payload.text);
    if (!text) return true;
    records.push({
      signature,
      type: 'reasoning',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'web_search_end') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    records.push({
      signature,
      type: 'tool_finished',
      content: extractNormalizedStructuredText(parsed.payload.query),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      toolName: 'Web Search',
    });
    return true;
  }

  if (parsed.payload?.type === 'mcp_tool_call_end') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    const server = extractNormalizedFreeText(parsed.payload.invocation?.server);
    const tool = extractNormalizedFreeText(parsed.payload.invocation?.tool);
    const toolName = server && tool ? `mcp__${server}__${tool}` : 'mcp_tool_call';
    records.push({
      signature,
      type: 'tool_finished',
      content: '',
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      toolName,
      isError: false,
    });
    return true;
  }

  if (parsed.payload?.type === 'exec_command_end') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    const exitCode = typeof parsed.payload.exit_code === 'number' ? parsed.payload.exit_code : null;
    const status = extractNormalizedFreeText(parsed.payload.status).toLowerCase();
    records.push({
      signature,
      type: 'tool_finished',
      content: extractToolOutputText(
        parsed.payload.aggregated_output
          ?? parsed.payload.formatted_output
          ?? parsed.payload.stdout
          ?? parsed.payload.stderr
          ?? parsed.payload.command,
      ),
      timestamp,
      ...(parsed.payload.turn_id || activeTurnId ? { turnId: parsed.payload.turn_id || activeTurnId || undefined } : {}),
      toolId,
      toolName: 'Bash',
      isError: status === 'failed' || (exitCode != null && exitCode !== 0),
    });
    return true;
  }

  if (parsed.payload?.type === 'patch_apply_end') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    const status = extractNormalizedFreeText(parsed.payload.status).toLowerCase();
    records.push({
      signature,
      type: 'tool_finished',
      content: summarizePatchChanges(parsed.payload.changes)
        || extractToolOutputText(parsed.payload.stdout ?? parsed.payload.stderr),
      timestamp,
      ...(parsed.payload.turn_id || activeTurnId ? { turnId: parsed.payload.turn_id || activeTurnId || undefined } : {}),
      toolId,
      toolName: 'apply_patch',
      isError: parsed.payload.success === false || status === 'failed',
    });
    return true;
  }

  if (parsed.payload?.type === 'image_generation_end') {
    const toolId = getImageGenerationToolId(parsed.payload) || signature;
    const status = extractNormalizedFreeText(parsed.payload.status).toLowerCase();
    records.push({
      signature,
      type: 'tool_finished',
      content: summarizeImageGenerationOutput(parsed.payload),
      timestamp,
      ...(parsed.payload.turn_id || activeTurnId ? { turnId: parsed.payload.turn_id || activeTurnId || undefined } : {}),
      toolId,
      toolName: 'image_generation',
      isError: Boolean(parsed.payload.error) || status === 'failed',
    });
    return true;
  }

  if (parsed.payload?.type === 'dynamic_tool_call_request') {
    const toolId = getDynamicToolCallId(parsed.payload) || signature;
    const toolName = extractNormalizedFreeText(parsed.payload.tool) || 'tool';
    records.push({
      signature,
      type: 'tool_started',
      content: '',
      timestamp,
      ...(parsed.payload.turnId || activeTurnId ? { turnId: parsed.payload.turnId || activeTurnId || undefined } : {}),
      toolId,
      toolName,
    });
    return true;
  }

  if (parsed.payload?.type === 'dynamic_tool_call_response') {
    const toolId = getDynamicToolCallId(parsed.payload) || signature;
    const toolName = extractNormalizedFreeText(parsed.payload.tool) || 'tool';
    records.push({
      signature,
      type: 'tool_finished',
      content: extractToolOutputText(parsed.payload.content_items ?? parsed.payload.error),
      timestamp,
      ...(parsed.payload.turn_id || activeTurnId ? { turnId: parsed.payload.turn_id || activeTurnId || undefined } : {}),
      toolId,
      toolName,
      isError: parsed.payload.success === false,
    });
    return true;
  }

  if (parsed.payload?.type === 'user_message') {
    const text = extractNormalizedStructuredText(parsed.payload.message);
    if (!text || isSyntheticDesktopUserContext(text)) return true;
    records.push({
      signature,
      type: 'message',
      role: 'user',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (isTerminalCompletionEventType(parsed.payload?.type)) {
    records.push({
      signature,
      type: 'task_complete',
      role: 'assistant',
      content: extractTerminalCompletionText(parsed.payload),
      timestamp,
      turnId: getEventTurnId(parsed.payload),
    });
    return true;
  }

  return false;
}

function pushDesktopMirrorResponseRecord(
  records: DesktopMirrorRecord[],
  parsed: SessionMessageLine,
  rawLine: string,
  activeTurnId: string | null,
  activeSpecialCallIds: Set<string>,
): boolean {
  const signature = createDesktopEventSignature(rawLine);
  const timestamp = parsed.timestamp || '';

  if (isIgnoredMirrorLineKind(parsed)) {
    return true;
  }

  if (parsed.payload?.type === 'reasoning') {
    const text = extractReasoningSummary(parsed.payload);
    if (!text) return true;
    records.push({
      signature,
      type: 'reasoning',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'message' && parsed.payload.role === 'assistant') {
    const text = extractDesktopMessageText(parsed);
    if (!text) return true;
    records.push({
      signature,
      type: 'message',
      role: parsed.payload.phase === 'commentary' ? 'commentary' : 'assistant',
      content: parsed.payload.phase === 'commentary' ? text.replace(/^\[commentary\]\n/, '') : text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'message' && parsed.payload.role === 'user') {
    const text = extractDesktopMessageText(parsed);
    if (!text || isSyntheticDesktopUserContext(text)) return true;
    const previous = records.at(-1);
    if (
      previous?.type === 'message'
      && previous.role === 'user'
      && previous.content === text
      && previous.turnId === (activeTurnId || undefined)
    ) {
      return true;
    }
    records.push({
      signature,
      type: 'message',
      role: 'user',
      content: text,
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    return true;
  }

  if (parsed.payload?.type === 'message') {
    // Desktop may persist internal/system message roles that are not user-visible.
    return true;
  }

  if (parsed.payload?.type === 'tool_search_call') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    records.push({
      signature,
      type: 'tool_started',
      content: '',
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      toolName: 'tool_search',
    });
    return true;
  }

  if (parsed.payload?.type === 'tool_search_output') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    const status = extractNormalizedFreeText(parsed.payload.status).toLowerCase();
    records.push({
      signature,
      type: 'tool_finished',
      content: summarizeToolSearchOutput(parsed.payload.tools),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      toolName: 'tool_search',
      isError: status === 'failed',
    });
    return true;
  }

  if (parsed.payload?.type === 'function_call') {
    const toolName = formatDesktopToolName(parsed.payload.namespace, parsed.payload.name);
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (!toolName) return true;
    if (toolName === 'update_plan') {
      const tasks = parseUpdatePlanTasks(parsed.payload.arguments);
      activeSpecialCallIds.add(toolId);
      records.push({
        signature,
        type: 'plan_update',
        content: '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        tasks,
      });
      return true;
    }
    records.push({
      signature,
      type: 'tool_started',
      content: '',
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      toolName,
    });
    return true;
  }

  if (parsed.payload?.type === 'custom_tool_call') {
    const toolName = formatDesktopToolName(parsed.payload.namespace, parsed.payload.name);
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (!toolName) return true;
    if (toolName === 'update_plan') {
      const tasks = parseUpdatePlanTasks(typeof parsed.payload.input === 'string' ? parsed.payload.input : undefined);
      activeSpecialCallIds.add(toolId);
      records.push({
        signature,
        type: 'plan_update',
        content: '',
        timestamp,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        tasks,
      });
      return true;
    }
    records.push({
      signature,
      type: 'tool_started',
      content: '',
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      toolName,
    });
    return true;
  }

  if (parsed.payload?.type === 'function_call_output') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (activeSpecialCallIds.has(toolId)) {
      activeSpecialCallIds.delete(toolId);
      return true;
    }
    records.push({
      signature,
      type: 'tool_finished',
      content: extractToolOutputText(parsed.payload.output),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      isError: parsed.payload.is_error === true,
    });
    return true;
  }

  if (parsed.payload?.type === 'custom_tool_call_output') {
    const toolId = extractNormalizedFreeText(parsed.payload.call_id) || signature;
    if (activeSpecialCallIds.has(toolId)) {
      activeSpecialCallIds.delete(toolId);
      return true;
    }
    records.push({
      signature,
      type: 'tool_finished',
      content: extractToolOutputText(parsed.payload.output),
      timestamp,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      toolId,
      isError: parsed.payload.is_error === true,
    });
    return true;
  }

  return false;
}

function parseDesktopSessionEventText(
  content: string,
  leadingText = '',
  flushTrailingText = false,
): DesktopSessionEventDelta {
  const combined = `${leadingText}${content}`;
  if (!combined) {
    return {
      events: [],
      nextOffset: 0,
      trailingText: '',
    };
  }

  const hasTrailingNewline = combined.endsWith('\n') || combined.endsWith('\r');
  const rawLines = combined.split(/\r?\n/);
  let trailingText = hasTrailingNewline ? '' : (rawLines.pop() || '');
  if (flushTrailingText && trailingText) {
    rawLines.push(trailingText);
    trailingText = '';
  }
  const events: DesktopSessionEvent[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: SessionMessageLine | SessionEventLine;
    try {
      parsed = JSON.parse(trimmed) as SessionMessageLine | SessionEventLine;
    } catch {
      continue;
    }

    pushDesktopSessionEvent(events, parsed, trimmed);
  }

  return {
    events,
    nextOffset: 0,
    trailingText,
  };
}

function parseDesktopMirrorRecordText(
  content: string,
  leadingText = '',
  flushTrailingText = false,
  initialTurnId: string | null = null,
  initialSpecialCallIds: Iterable<string> = [],
): DesktopMirrorRecordDelta {
  const combined = `${leadingText}${content}`;
  if (!combined) {
    return {
      records: [],
      nextOffset: 0,
      trailingText: '',
      nextTurnId: initialTurnId,
      nextSpecialCallIds: [],
      unknownKinds: [],
    };
  }

  const hasTrailingNewline = combined.endsWith('\n') || combined.endsWith('\r');
  const rawLines = combined.split(/\r?\n/);
  let trailingText = hasTrailingNewline ? '' : (rawLines.pop() || '');
  if (flushTrailingText && trailingText) {
    rawLines.push(trailingText);
    trailingText = '';
  }
  const records: DesktopMirrorRecord[] = [];
  let activeTurnId = initialTurnId;
  const activeSpecialCallIds = new Set(initialSpecialCallIds);
  const unknownKinds = new Set<string>();

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: SessionMessageLine | SessionEventLine | TurnContextLine;
    try {
      parsed = JSON.parse(trimmed) as SessionMessageLine | SessionEventLine | TurnContextLine;
    } catch {
      continue;
    }

    if (isTurnContextLine(parsed)) {
      activeTurnId = parsed.payload?.turn_id || activeTurnId;
      continue;
    }

    if (isSessionEventLine(parsed) && parsed.payload?.type === 'task_started') {
      const eventPayload = parsed.payload as SessionEventLine['payload'];
      activeTurnId = getEventTurnId(eventPayload) || activeTurnId;
    }

    const handled = pushDesktopMirrorRecord(records, parsed, trimmed, activeTurnId, activeSpecialCallIds);
    if (!handled) {
      const unknownKind = describeUnhandledMirrorLineKind(parsed);
      if (unknownKind) unknownKinds.add(unknownKind);
    }

    if (
      isSessionEventLine(parsed)
      && (isTerminalCompletionEventType(parsed.payload?.type) || parsed.payload?.type === 'turn_aborted')
    ) {
      const eventPayload = parsed.payload as SessionEventLine['payload'];
      const completedTurnId = getEventTurnId(eventPayload) || activeTurnId;
      if (!completedTurnId || completedTurnId === activeTurnId) {
        activeTurnId = null;
      }
      activeSpecialCallIds.clear();
    }
  }

  return {
    records,
    nextOffset: 0,
    trailingText,
    nextTurnId: activeTurnId,
    nextSpecialCallIds: Array.from(activeSpecialCallIds),
    unknownKinds: Array.from(unknownKinds),
  };
}

export function readDesktopSessionMessages(threadId: string, limit = 8): BridgeMessage[] {
  const messages = readDesktopSessionEventStream(threadId).map((event) => ({
    role: event.role === 'commentary' ? 'assistant' : event.role,
    content: event.role === 'commentary'
      ? `[commentary]\n${event.content}`
      : event.content,
  }));

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
  return messages.slice(-safeLimit);
}

export function readDesktopSessionEventStreamByFilePath(filePath: string): DesktopSessionEvent[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseDesktopSessionEventText(content, '', true).events;
}

export function readDesktopSessionEventDeltaByFilePath(
  filePath: string,
  startOffset: number,
  endOffset: number,
  trailingText = '',
): DesktopSessionEventDelta {
  let range: CompleteUtf8LineRange;
  try {
    range = readCompleteUtf8LineRange(filePath, startOffset, endOffset);
  } catch {
    return {
      events: [],
      nextOffset: startOffset,
      trailingText,
    };
  }

  const parsed = parseDesktopSessionEventText(range.content, trailingText);
  return {
    events: parsed.events,
    nextOffset: range.nextOffset,
    trailingText: parsed.trailingText,
  };
}

export function readDesktopSessionMirrorRecordStreamByFilePath(filePath: string): DesktopMirrorRecord[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseDesktopMirrorRecordText(content, '', true, null, []).records;
}

export function readDesktopSessionMirrorRecordDeltaByFilePath(
  filePath: string,
  startOffset: number,
  endOffset: number,
  trailingText = '',
  currentTurnId: string | null = null,
  currentSpecialCallIds: Iterable<string> = [],
): DesktopMirrorRecordDelta {
  let range: CompleteUtf8LineRange;
  try {
    range = readCompleteUtf8LineRange(filePath, startOffset, endOffset);
  } catch {
    return {
      records: [],
      nextOffset: startOffset,
      trailingText,
      nextTurnId: currentTurnId,
      nextSpecialCallIds: Array.from(currentSpecialCallIds),
      unknownKinds: [],
    };
  }

  const parsed = parseDesktopMirrorRecordText(
    range.content,
    trailingText,
    false,
    currentTurnId,
    currentSpecialCallIds,
  );
  return {
    records: parsed.records,
    nextOffset: range.nextOffset,
    trailingText: parsed.trailingText,
    nextTurnId: parsed.nextTurnId,
    nextSpecialCallIds: parsed.nextSpecialCallIds,
    unknownKinds: parsed.unknownKinds,
  };
}

export function readDesktopSessionEventStream(threadId: string): DesktopSessionEvent[] {
  const session = getDesktopSessionByThreadId(threadId);
  if (!session) return [];
  return readDesktopSessionEventStreamByFilePath(session.filePath);
}
