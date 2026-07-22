import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMirrorSubscription } from '../lib/bridge/mirror-subscription-state.js';
import {
  isMirrorSnapshotUnchanged,
  markMirrorSnapshotMissing,
  readMirrorDeliverableRecords,
  refreshMirrorSubscriptionSource,
  statMirrorFile,
} from '../lib/bridge/mirror-reconcile-core.js';

describe('mirror-reconcile-core', () => {
  it('starts a new mirror subscription at the current complete line without replaying history', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-reconcile-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-04-13T12:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'historical answer' },
    })}\n`, 'utf8');
    const subscription = createMirrorSubscription({
      bindingId: 'binding-new',
      sessionId: 'session-new',
      channelType: 'feishu-default',
      chatId: 'chat-new',
      threadId: 'thread-new',
      filePath,
      lastDeliveredAt: null,
    });
    const snapshot = statMirrorFile(filePath);
    assert.ok(snapshot);

    const result = readMirrorDeliverableRecords(subscription, snapshot);

    assert.deepEqual(result.records, []);
    assert.equal(subscription.cursor.initialized, true);
    assert.equal(subscription.fileOffset, snapshot.size);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('replays records newer than the persisted mirror delivery timestamp after restart', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-reconcile-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'already delivered' },
      }),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'recover after restart' },
      }),
    ].join('\n') + '\n', 'utf8');
    const subscription = createMirrorSubscription({
      bindingId: 'binding-restart',
      sessionId: 'session-restart',
      channelType: 'feishu-default',
      chatId: 'chat-restart',
      threadId: 'thread-restart',
      filePath,
      lastDeliveredAt: '2026-04-13T12:00:01.000Z',
    });
    const snapshot = statMirrorFile(filePath);
    assert.ok(snapshot);

    const result = readMirrorDeliverableRecords(subscription, snapshot);

    assert.deepEqual(result.records.map((record) => record.content), ['recover after restart']);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('recovers a rollout across bounded reads without replaying records before the persisted cursor', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-reconcile-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    const lines = Array.from({ length: 12 }, (_, index) => JSON.stringify({
      timestamp: `2026-04-13T12:00:${String(index).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: `turn-${index}`,
        last_agent_message: `answer-${index}-${'x'.repeat(80)}`,
      },
    }));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
    const subscription = createMirrorSubscription({
      bindingId: 'binding-bounded-restart',
      sessionId: 'session-bounded-restart',
      channelType: 'feishu-default',
      chatId: 'chat-bounded-restart',
      threadId: 'thread-bounded-restart',
      filePath,
      lastDeliveredAt: '2026-04-13T12:00:07.500Z',
    });
    const snapshot = statMirrorFile(filePath);
    assert.ok(snapshot);

    const recovered: string[] = [];
    let reads = 0;
    do {
      const before = subscription.fileOffset;
      const result = readMirrorDeliverableRecords(subscription, snapshot, { maxReadBytes: 320 });
      recovered.push(...result.records.map((record) => record.content));
      reads += 1;
      assert.ok(subscription.fileOffset > before, 'bounded recovery must advance its file offset');
      assert.equal(result.hasMoreData, subscription.fileOffset < snapshot.size);
      if (subscription.fileOffset < snapshot.size) {
        assert.ok(subscription.recoveryState, 'recovery state must survive between bounded reads');
      }
    } while (subscription.fileOffset < snapshot.size);

    assert.ok(reads > 1);
    assert.deepEqual(
      recovered.map((content) => content.slice(0, 'answer-00'.length)),
      ['answer-8-', 'answer-9-', 'answer-10', 'answer-11'],
    );
    assert.equal(subscription.recoveryState, null);
    assert.equal(subscription.cursor.lastEventTimestamp, '2026-04-13T12:00:11.000Z');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('refreshes the mirror source path and resets read state only when the file changes', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\old.jsonl',
      lastDeliveredAt: null,
    });

    subscription.dirty = false;
    subscription.fileOffset = 42;
    subscription.fileSize = 84;
    subscription.fileOffset = 84;
    subscription.fileMtimeMs = 1000;
    subscription.fileIdentity = 'dev:ino';
    subscription.trailingText = 'partial';
    subscription.activeMirrorTurnId = 'turn-1';
    subscription.activeSpecialCallIds.add('plan-1');
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });

    const changed = refreshMirrorSubscriptionSource(
      subscription,
      'D:\\codex\\new.jsonl',
      '2026-04-13T13:00:00.000Z',
    );

    assert.equal(changed, true);
    assert.equal(subscription.filePath, 'D:\\codex\\new.jsonl');
    assert.equal(subscription.status, 'watching');
    assert.equal(subscription.lastReconciledAt, '2026-04-13T13:00:00.000Z');
    assert.equal(subscription.dirty, true);
    assert.equal(subscription.fileOffset, 0);
    assert.equal(subscription.fileSize, null);
    assert.equal(subscription.fileMtimeMs, null);
    assert.equal(subscription.fileIdentity, null);
    assert.equal(subscription.trailingText, '');
    assert.equal(subscription.activeMirrorTurnId, null);
    assert.deepEqual(subscription.activeSpecialCallIds, new Set());
    assert.deepEqual(subscription.bufferedRecords, []);
  });

  it('marks a missing snapshot as stale and clears incremental read state', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\old.jsonl',
      lastDeliveredAt: null,
    });

    subscription.dirty = false;
    subscription.fileOffset = 42;
    subscription.fileSize = 84;
    subscription.fileMtimeMs = 1000;
    subscription.fileIdentity = 'dev:ino';
    subscription.trailingText = 'partial';
    subscription.activeMirrorTurnId = 'turn-1';
    subscription.activeSpecialCallIds.add('plan-1');
    subscription.bufferedRecords.push({
      signature: 'sig-1',
      type: 'message',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-04-13T12:00:01.000Z',
    });

    markMirrorSnapshotMissing(subscription);

    assert.equal(subscription.status, 'stale');
    assert.equal(subscription.dirty, true);
    assert.equal(subscription.fileOffset, 0);
    assert.equal(subscription.fileSize, null);
    assert.equal(subscription.fileMtimeMs, null);
    assert.equal(subscription.fileIdentity, null);
    assert.equal(subscription.trailingText, '');
    assert.equal(subscription.activeMirrorTurnId, null);
    assert.deepEqual(subscription.activeSpecialCallIds, new Set());
    assert.deepEqual(subscription.bufferedRecords, []);
  });

  it('detects unchanged snapshots from the tracked mirror file identity and size', () => {
    const subscription = createMirrorSubscription({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      threadId: 'thread-1',
      filePath: 'D:\\codex\\session.jsonl',
      lastDeliveredAt: null,
    });

    subscription.dirty = false;
    subscription.fileSize = 84;
    subscription.fileOffset = 84;
    subscription.fileMtimeMs = 1000;
    subscription.fileIdentity = 'dev:ino';

    assert.equal(
      isMirrorSnapshotUnchanged(subscription, {
        size: 84,
        mtimeMs: 1000,
        identity: 'dev:ino',
      }),
      true,
    );
    assert.equal(
      isMirrorSnapshotUnchanged(subscription, {
        size: 85,
        mtimeMs: 1000,
        identity: 'dev:ino',
      }),
      false,
    );

    subscription.fileOffset = 80;
    assert.equal(
      isMirrorSnapshotUnchanged(subscription, {
        size: 84,
        mtimeMs: 1000,
        identity: 'dev:ino',
      }),
      false,
    );
  });
});
