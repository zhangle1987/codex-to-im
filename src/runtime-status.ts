import fs from 'node:fs';

import { atomicWriteFileSync } from './atomic-file.js';

export interface RuntimeStatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  adapters?: unknown[];
  lastExitReason?: string;
}

export interface RuntimeStatusWriteOptions {
  expectedRunId?: string;
  allowRunIdTakeover?: boolean;
}

export function writeRuntimeStatus(
  filePath: string,
  info: RuntimeStatusInfo,
  options: RuntimeStatusWriteOptions = {},
): boolean {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // First write or an invalid stale status file.
  }

  const existingRunId = typeof existing.runId === 'string' ? existing.runId : '';
  if (
    options.expectedRunId
    && existingRunId
    && existingRunId !== options.expectedRunId
    && options.allowRunIdTakeover !== true
  ) {
    return false;
  }

  const merged = { ...existing, ...info };
  atomicWriteFileSync(filePath, JSON.stringify(merged, null, 2));
  return true;
}
