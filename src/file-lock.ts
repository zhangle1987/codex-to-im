import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 25;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const ACTIVE_LOCKS = new Map<string, number>();

interface FileLockRecord {
  token: string;
  pid: number;
  createdAt: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(WAIT_ARRAY, 0, 0, Math.max(1, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < staleAfterMs) return false;

    let ownerPid = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<FileLockRecord>;
      ownerPid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    } catch {
      // An unreadable old lock can be reclaimed after the stale threshold.
    }
    if (ownerPid && isProcessAlive(ownerPid)) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function withFileLock<T>(
  targetPath: string,
  operation: () => T,
  options?: { timeoutMs?: number; staleAfterMs?: number },
): T {
  const lockPath = `${targetPath}.lock`;
  const activeDepth = ACTIVE_LOCKS.get(lockPath) || 0;
  if (activeDepth > 0) {
    ACTIVE_LOCKS.set(lockPath, activeDepth + 1);
    try {
      return operation();
    } finally {
      const nextDepth = (ACTIVE_LOCKS.get(lockPath) || 1) - 1;
      if (nextDepth > 0) ACTIVE_LOCKS.set(lockPath, nextDepth);
      else ACTIVE_LOCKS.delete(lockPath);
    }
  }

  const timeoutMs = Math.max(0, options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const staleAfterMs = Math.max(timeoutMs, options?.staleAfterMs ?? DEFAULT_STALE_LOCK_MS);
  const deadline = Date.now() + timeoutMs;
  const record: FileLockRecord = {
    token: crypto.randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  };
  let handle: number | null = null;

  while (handle === null) {
    try {
      handle = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify(record), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (removeStaleLock(lockPath, staleAfterMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      sleepSync(Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  try {
    ACTIVE_LOCKS.set(lockPath, 1);
    return operation();
  } finally {
    ACTIVE_LOCKS.delete(lockPath);
    try { fs.closeSync(handle); } catch { /* best effort */ }
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<FileLockRecord>;
      if (current.token === record.token) fs.rmSync(lockPath, { force: true });
    } catch {
      // Another process may already have reclaimed a stale lock.
    }
  }
}

export function withFileLocks<T>(targetPaths: string[], operation: () => T): T {
  const paths = Array.from(new Set(targetPaths)).sort();
  const acquire = (index: number): T => {
    if (index >= paths.length) return operation();
    return withFileLock(paths[index], () => acquire(index + 1));
  };
  return acquire(0);
}
