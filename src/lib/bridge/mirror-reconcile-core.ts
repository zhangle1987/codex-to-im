import fs from 'node:fs';

import {
  advanceDesktopMirrorCursor,
  filterDuplicateAssistantEvents,
  type DesktopMirrorCursor,
} from '../../desktop-session-mirror.js';
import { readDesktopSessionMirrorRecordDeltaByFilePath } from '../../desktop-sessions.js';
import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import {
  resetMirrorReadState,
  type DesktopMirrorSubscription,
  type MirrorFileSnapshot,
} from './mirror-subscription-state.js';

const DEFAULT_MAX_MIRROR_READ_BYTES = 64 * 1024 * 1024;

export interface ReadMirrorDeliverableRecordsOptions {
  maxReadBytes?: number;
}

export function statMirrorFile(filePath: string): MirrorFileSnapshot | null {
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

export function refreshMirrorSubscriptionSource(
  subscription: DesktopMirrorSubscription,
  filePath: string | null,
  reconciledAt: string,
): boolean {
  const filePathChanged = subscription.filePath !== filePath;
  subscription.filePath = filePath;
  subscription.status = filePath ? 'watching' : 'stale';
  if (filePathChanged) {
    subscription.dirty = true;
    resetMirrorReadState(subscription);
  }
  subscription.lastReconciledAt = reconciledAt;
  return filePathChanged;
}

export function markMirrorSnapshotMissing(subscription: DesktopMirrorSubscription): void {
  subscription.status = 'stale';
  subscription.dirty = true;
  resetMirrorReadState(subscription);
}

export function isMirrorSnapshotUnchanged(
  subscription: DesktopMirrorSubscription,
  snapshot: MirrorFileSnapshot,
): boolean {
  return !subscription.dirty
    && subscription.fileIdentity === snapshot.identity
    && subscription.fileOffset === snapshot.size
    && !subscription.trailingText
    && subscription.fileSize === snapshot.size
    && subscription.fileMtimeMs === snapshot.mtimeMs;
}

function findLastCompleteLineOffset(filePath: string, fileSize: number): number {
  if (fileSize <= 0) return 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunkSize = 64 * 1024;
    let end = fileSize;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.alloc(end - start);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      const newlineIndex = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newlineIndex >= 0) return start + newlineIndex + 1;
      end = start;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function beginMirrorRecovery(subscription: DesktopMirrorSubscription): void {
  subscription.recoveryState = {
    baselineCursor: { ...subscription.cursor },
    scannedCursor: { initialized: true, lastEventCount: 0 },
    boundaryFound: false,
    dedupePending: true,
    scannedRecordCount: 0,
  };
  subscription.trailingText = '';
  subscription.fileOffset = 0;
  subscription.activeMirrorTurnId = null;
  subscription.activeSpecialCallIds.clear();
}

function findCursorTimestampBoundary(
  cursor: DesktopMirrorCursor,
  records: DesktopMirrorRecord[],
): number {
  if (!cursor.lastEventTimestamp) return -1;
  return records.findIndex((record) => (
    Boolean(record.timestamp) && record.timestamp > cursor.lastEventTimestamp!
  ));
}

function selectRecoveredRecords(
  subscription: DesktopMirrorSubscription,
  records: DesktopMirrorRecord[],
): DesktopMirrorRecord[] {
  const recovery = subscription.recoveryState;
  if (!recovery || records.length === 0) return [];
  if (recovery.boundaryFound) return records;

  const baseline = recovery.baselineCursor;
  if (baseline.lastEventSignature) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index]?.signature !== baseline.lastEventSignature) continue;
      recovery.boundaryFound = true;
      return records.slice(index + 1);
    }
  }

  const timestampBoundary = findCursorTimestampBoundary(baseline, records);
  if (timestampBoundary >= 0) {
    recovery.boundaryFound = true;
    return records.slice(timestampBoundary);
  }

  if (baseline.lastEventSignature || baseline.lastEventTimestamp) return [];
  if (baseline.lastEventCount > recovery.scannedRecordCount) {
    const boundary = baseline.lastEventCount - recovery.scannedRecordCount;
    if (boundary >= records.length) return [];
    recovery.boundaryFound = true;
    return records.slice(boundary);
  }

  recovery.boundaryFound = true;
  return records;
}

function filterFirstRecoveredAssistantDuplicates(
  subscription: DesktopMirrorSubscription,
  records: DesktopMirrorRecord[],
): DesktopMirrorRecord[] {
  const recovery = subscription.recoveryState;
  if (!recovery?.dedupePending || records.length === 0) return records;
  const filtered = filterDuplicateAssistantEvents(recovery.baselineCursor, records);
  if (filtered.length > 0) {
    recovery.dedupePending = false;
  }
  return filtered;
}

export function readMirrorDeliverableRecords(
  subscription: DesktopMirrorSubscription,
  snapshot: MirrorFileSnapshot,
  options: ReadMirrorDeliverableRecordsOptions = {},
) {
  let deliverableRecords: DesktopMirrorRecord[] = [];
  let unknownKinds: string[] = [];
  const previousOffset = subscription.fileOffset;
  const configuredMaxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_MIRROR_READ_BYTES;
  const maxReadBytes = Number.isFinite(configuredMaxReadBytes) && configuredMaxReadBytes > 0
    ? Math.max(1, Math.floor(configuredMaxReadBytes))
    : DEFAULT_MAX_MIRROR_READ_BYTES;

  const sourceChanged = (subscription.fileIdentity !== null && subscription.fileIdentity !== snapshot.identity)
    || (subscription.fileSize !== null && snapshot.size < subscription.fileOffset)
    || (
      subscription.fileSize !== null
      && snapshot.size === subscription.fileOffset
      && subscription.fileMtimeMs !== null
      && snapshot.mtimeMs !== subscription.fileMtimeMs
    );
  const requiresFullRecover = Boolean(subscription.recoveryState)
    || !subscription.cursor.initialized
    || subscription.fileOffset === 0
    || sourceChanged;

  if (requiresFullRecover && !subscription.cursor.initialized && !subscription.lastDeliveredAt) {
    subscription.cursor = { initialized: true, lastEventCount: 0 };
    subscription.recoveryState = null;
    subscription.trailingText = '';
    subscription.fileOffset = findLastCompleteLineOffset(subscription.filePath!, snapshot.size);
    subscription.activeMirrorTurnId = null;
    subscription.activeSpecialCallIds.clear();
    subscription.fileSize = snapshot.size;
    subscription.fileMtimeMs = snapshot.mtimeMs;
    subscription.fileIdentity = snapshot.identity;
    subscription.dirty = false;
    return { records: [], unknownKinds: [], hasMoreData: false };
  }

  if (requiresFullRecover) {
    if (!subscription.recoveryState || sourceChanged) {
      beginMirrorRecovery(subscription);
    }
    const recovery = subscription.recoveryState!;
    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(
      subscription.filePath!,
      subscription.fileOffset,
      snapshot.size,
      subscription.trailingText,
      subscription.activeMirrorTurnId,
      subscription.activeSpecialCallIds,
      { maxBytes: maxReadBytes },
    );
    deliverableRecords = filterFirstRecoveredAssistantDuplicates(
      subscription,
      selectRecoveredRecords(subscription, delta.records),
    );
    recovery.scannedCursor = advanceDesktopMirrorCursor(recovery.scannedCursor, delta.records);
    recovery.scannedRecordCount += delta.records.length;
    subscription.trailingText = delta.trailingText;
    subscription.fileOffset = delta.nextOffset;
    subscription.activeMirrorTurnId = delta.nextTurnId;
    subscription.activeSpecialCallIds = new Set(delta.nextSpecialCallIds);
    unknownKinds = delta.unknownKinds;

    if (subscription.fileOffset >= snapshot.size && !subscription.trailingText) {
      subscription.cursor = recovery.scannedCursor;
      subscription.recoveryState = null;
    }
  } else if (snapshot.size > subscription.fileOffset || subscription.trailingText) {
    const previousCursor = subscription.cursor;
    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(
      subscription.filePath!,
      subscription.fileOffset,
      snapshot.size,
      subscription.trailingText,
      subscription.activeMirrorTurnId,
      subscription.activeSpecialCallIds,
      { maxBytes: maxReadBytes },
    );
    deliverableRecords = filterDuplicateAssistantEvents(previousCursor, delta.records);
    subscription.cursor = advanceDesktopMirrorCursor(subscription.cursor, delta.records);
    subscription.trailingText = delta.trailingText;
    subscription.fileOffset = delta.nextOffset;
    subscription.activeMirrorTurnId = delta.nextTurnId;
    subscription.activeSpecialCallIds = new Set(delta.nextSpecialCallIds);
    unknownKinds = delta.unknownKinds;
  }

  subscription.fileSize = snapshot.size;
  subscription.fileMtimeMs = snapshot.mtimeMs;
  subscription.fileIdentity = snapshot.identity;
  subscription.dirty = false;

  return {
    records: deliverableRecords,
    unknownKinds,
    hasMoreData: subscription.fileOffset > previousOffset
      && subscription.fileOffset < snapshot.size,
  };
}
