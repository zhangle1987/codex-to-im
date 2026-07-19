import fs from 'node:fs';

import {
  advanceDesktopMirrorCursor,
  filterDuplicateAssistantEvents,
  reconcileDesktopMirrorCursor,
} from '../../desktop-session-mirror.js';
import { readDesktopSessionMirrorRecordDeltaByFilePath } from '../../desktop-sessions.js';
import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import {
  resetMirrorReadState,
  type DesktopMirrorSubscription,
  type MirrorFileSnapshot,
} from './mirror-subscription-state.js';

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

export function readMirrorDeliverableRecords(
  subscription: DesktopMirrorSubscription,
  snapshot: MirrorFileSnapshot,
) {
  let deliverableRecords: DesktopMirrorRecord[] = [];
  let unknownKinds: string[] = [];

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

  if (requiresFullRecover && !subscription.cursor.initialized && !subscription.lastDeliveredAt) {
    subscription.cursor = { initialized: true, lastEventCount: 0 };
    subscription.trailingText = '';
    subscription.fileOffset = findLastCompleteLineOffset(subscription.filePath!, snapshot.size);
    subscription.activeMirrorTurnId = null;
    subscription.activeSpecialCallIds.clear();
    subscription.fileSize = snapshot.size;
    subscription.fileMtimeMs = snapshot.mtimeMs;
    subscription.fileIdentity = snapshot.identity;
    subscription.dirty = false;
    return { records: [], unknownKinds: [] };
  }

  if (requiresFullRecover) {
    const previousCursor = subscription.cursor;
    const fullDelta = readDesktopSessionMirrorRecordDeltaByFilePath(
      subscription.filePath!,
      0,
      snapshot.size,
      '',
      null,
      [],
    );
    const delta = reconcileDesktopMirrorCursor(subscription.cursor, fullDelta.records);
    subscription.cursor = delta.nextCursor;
    deliverableRecords = filterDuplicateAssistantEvents(previousCursor, delta.deliverableRecords);
    subscription.trailingText = fullDelta.trailingText;
    subscription.fileOffset = fullDelta.nextOffset;
    subscription.activeMirrorTurnId = fullDelta.nextTurnId;
    subscription.activeSpecialCallIds = new Set(fullDelta.nextSpecialCallIds);
    unknownKinds = fullDelta.unknownKinds;
  } else if (snapshot.size > subscription.fileOffset || subscription.trailingText) {
    const previousCursor = subscription.cursor;
    const delta = readDesktopSessionMirrorRecordDeltaByFilePath(
      subscription.filePath!,
      subscription.fileOffset,
      snapshot.size,
      subscription.trailingText,
      subscription.activeMirrorTurnId,
      subscription.activeSpecialCallIds,
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
  };
}
