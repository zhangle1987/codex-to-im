import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeMessage } from './lib/bridge/host.js';

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

interface SessionMetaLine {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    timestamp?: string;
    cwd?: string;
    originator?: string;
    cli_version?: string;
    source?: string;
  };
}

interface SessionMessageLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    phase?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

interface SessionEventLine {
  type?: string;
  payload?: {
    type?: string;
    message?: string;
  };
}

interface SessionIndexLine {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024;
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

function extractThreadIdFromRolloutName(name: string): string | null {
  const match = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
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
  const originator = meta?.originator?.toLowerCase() || '';
  const source = meta?.source?.toLowerCase() || '';
  return originator.includes('desktop') || source === 'vscode' || source === 'desktop';
}

function loadThreadNameIndex(archivedThreadIds: Set<string>): Map<string, string> {
  const indexPath = getSessionIndexPath();
  if (!fs.existsSync(indexPath)) return new Map();

  let content = '';
  try {
    content = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return new Map();
  }

  const titles = new Map<string, { title: string; updatedAt: string }>();
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

  return new Map(Array.from(titles.entries()).map(([threadId, entry]) => [threadId, entry.title]));
}

function parseDesktopSession(
  filePath: string,
  threadNames: Map<string, string>,
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
  const lastEventAt = stat.mtime.toISOString();
  const firstSeenAt = parsed.payload.timestamp || parsed.timestamp || stat.birthtime.toISOString();
  const threadId = parsed.payload.id;
  const title = threadNames.get(threadId);
  if (!title) return null;

  return {
    threadId,
    filePath,
    cwd,
    originator: parsed.payload.originator || 'Codex Desktop',
    source: parsed.payload.source || undefined,
    cliVersion: parsed.payload.cli_version || undefined,
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

function isSessionEventLine(line: SessionMessageLine | SessionEventLine): line is SessionEventLine {
  return line.type === 'event_msg';
}

function isSessionMessageLine(line: SessionMessageLine | SessionEventLine): line is SessionMessageLine {
  return line.type === 'response_item';
}

export function listDesktopSessions(limit = 12): DesktopSessionSummary[] {
  const root = getCodexSessionsRoot();
  if (!fs.existsSync(root)) return [];
  const archivedThreadIds = loadArchivedThreadIds();
  const threadNames = loadThreadNameIndex(archivedThreadIds);
  if (threadNames.size === 0) return [];

  const files: string[] = [];
  walkSessionFiles(root, files);

  const sessions: DesktopSessionSummary[] = [];
  for (const filePath of files) {
    const session = parseDesktopSession(filePath, threadNames, archivedThreadIds);
    if (session) sessions.push(session);
  }

  return sessions
    .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))
    .slice(0, Math.max(1, limit));
}

export function getDesktopSessionByThreadId(threadId: string): DesktopSessionSummary | null {
  const sessions = listDesktopSessions(200);
  return sessions.find((session) => session.threadId === threadId) || null;
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

export function readDesktopSessionMessages(threadId: string, limit = 8): BridgeMessage[] {
  const session = getDesktopSessionByThreadId(threadId);
  if (!session) return [];

  let content = '';
  try {
    content = fs.readFileSync(session.filePath, 'utf-8');
  } catch {
    return [];
  }

  const messages: BridgeMessage[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: SessionMessageLine | SessionEventLine;
    try {
      parsed = JSON.parse(line) as SessionMessageLine | SessionEventLine;
    } catch {
      continue;
    }

    if (isSessionEventLine(parsed) && parsed.payload?.type === 'user_message') {
      const text = normalizeFreeText(parsed.payload.message || '');
      if (!text) continue;
      messages.push({
        role: 'user',
        content: text,
      });
      continue;
    }

    if (isSessionMessageLine(parsed) && parsed.payload?.type === 'message' && parsed.payload.role === 'assistant') {
      const text = extractDesktopMessageText(parsed);
      if (!text) continue;
      messages.push({
        role: parsed.payload.role,
        content: text,
      });
    }
  }

  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
  return messages.slice(-safeLimit);
}
