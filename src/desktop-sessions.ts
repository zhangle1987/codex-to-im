import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024;

export function getCodexSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
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

function parseDesktopSession(filePath: string): DesktopSessionSummary | null {
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

  return {
    threadId,
    filePath,
    cwd,
    originator: parsed.payload.originator || 'Codex Desktop',
    source: parsed.payload.source || undefined,
    cliVersion: parsed.payload.cli_version || undefined,
    firstSeenAt,
    lastEventAt,
    title: cwd ? path.basename(cwd) : `Session ${threadId.slice(0, 8)}`,
    activeEstimate: Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS,
  };
}

export function listDesktopSessions(limit = 12): DesktopSessionSummary[] {
  const root = getCodexSessionsRoot();
  if (!fs.existsSync(root)) return [];

  const files: string[] = [];
  walkSessionFiles(root, files);

  const sessions: DesktopSessionSummary[] = [];
  for (const filePath of files) {
    const session = parseDesktopSession(filePath);
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
