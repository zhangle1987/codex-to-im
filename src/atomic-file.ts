import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export interface RenameRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  renameSync?: (source: string, destination: string) => void;
  sleepSync?: (delayMs: number) => void;
}

function defaultSleepSync(delayMs: number): void {
  Atomics.wait(WAIT_ARRAY, 0, 0, Math.max(1, delayMs));
}

function isRetryableRenameError(error: unknown): boolean {
  return RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException)?.code || '');
}

export function renameFileWithRetrySync(
  source: string,
  destination: string,
  options: RenameRetryOptions = {},
): void {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 15);
  const renameSync = options.renameSync ?? fs.renameSync;
  const sleepSync = options.sleepSync ?? defaultSleepSync;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      sleepSync(Math.min(250, baseDelayMs * (2 ** attempt)));
    }
  }
}

export function atomicWriteFileSync(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    renameFileWithRetrySync(tmpPath, filePath);
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
  }
}
