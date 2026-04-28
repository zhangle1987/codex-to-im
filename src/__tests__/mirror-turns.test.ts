import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueuePendingMirrorDeliveries,
  hasPendingMirrorWork,
  removePendingMirrorDeliveries,
  selectPendingMirrorDeliveries,
  consumeMirrorRecords,
} from '../lib/bridge/mirror-turns.js';

describe('mirror-turns pending delivery queue', () => {
  it('deduplicates queued turns by signature and removes only delivered turns', () => {
    const completed = {
      streamKey: 'mirror:session-1:turn-1',
      userText: 'prompt',
      text: 'answer',
      signature: 'complete-1',
      timestamp: '2026-04-21T10:00:00.000Z',
      status: 'completed' as const,
    };
    const timedOut = {
      streamKey: 'mirror:session-1:turn-2',
      userText: null,
      text: 'stale answer',
      signature: 'timeout:thread-1:turn-2',
      timestamp: '2026-04-21T10:01:00.000Z',
      status: 'interrupted' as const,
      timedOut: true,
    };
    const subscription = {
      pendingDeliveries: [],
    };

    enqueuePendingMirrorDeliveries(subscription, [completed, timedOut, completed]);
    assert.deepEqual(subscription.pendingDeliveries, [completed, timedOut]);

    removePendingMirrorDeliveries(subscription, [timedOut]);
    assert.deepEqual(subscription.pendingDeliveries, [completed]);
  });

  it('treats queued pending deliveries as pending mirror work', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      bufferedRecords: [],
      pendingTurn: null,
      pendingDeliveries: [
        {
          streamKey: 'mirror:session-1:turn-1',
          userText: null,
          text: 'answer',
          signature: 'complete-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          status: 'completed' as const,
        },
      ],
    };

    assert.equal(hasPendingMirrorWork(subscription), true);
  });

  it('only selects timeout turns while mirror delivery is blocked', () => {
    const subscription = {
      pendingDeliveries: [
        {
          streamKey: 'mirror:session-1:turn-1',
          userText: 'prompt',
          text: 'answer',
          signature: 'complete-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          status: 'completed' as const,
        },
        {
          streamKey: 'mirror:session-1:turn-2',
          userText: null,
          text: 'stale answer',
          signature: 'timeout:thread-1:turn-2',
          timestamp: '2026-04-21T10:01:00.000Z',
          status: 'interrupted' as const,
          timedOut: true,
        },
      ],
    };

    assert.deepEqual(
      selectPendingMirrorDeliveries(subscription, false).map((turn) => turn.signature),
      ['complete-1', 'timeout:thread-1:turn-2'],
    );
    assert.deepEqual(
      selectPendingMirrorDeliveries(subscription, true).map((turn) => turn.signature),
      ['timeout:thread-1:turn-2'],
    );
  });

  it('updates status note and task items through mirror progress hooks', () => {
    const statusNotes: Array<string | null> = [];
    const taskSnapshots: Array<Array<{ text: string; status: string }>> = [];
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-21T10:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'reason-1',
        type: 'reasoning',
        content: '先检查镜像流状态',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'plan-1',
        type: 'plan_update',
        content: '',
        timestamp: '2026-04-21T10:00:02.000Z',
        turnId: 'turn-1',
        tasks: [
          { text: '检查镜像流状态', status: 'completed' },
          { text: '补交界处测试', status: 'in_progress' },
        ],
      },
    ], {
      onStatusProgress: (_subscription, turnState) => {
        statusNotes.push(turnState.statusNote);
      },
      onTaskProgress: (_subscription, turnState) => {
        taskSnapshots.push(turnState.taskItems.map((task) => ({ ...task })));
      },
    });

    assert.deepEqual(statusNotes, ['先检查镜像流状态']);
    assert.deepEqual(taskSnapshots, [[
      { text: '检查镜像流状态', status: 'completed' },
      { text: '补交界处测试', status: 'in_progress' },
    ]]);
    assert.equal(subscription.pendingTurn?.statusNote, '先检查镜像流状态');
    assert.deepEqual(subscription.pendingTurn?.taskItems, [
      { text: '检查镜像流状态', status: 'completed' },
      { text: '补交界处测试', status: 'in_progress' },
    ]);
    assert.equal(subscription.pendingTurn?.lastActivityAt, '2026-04-21T10:00:02.000Z');
    assert.equal(subscription.pendingTurn?.lastContentResponseAt, null);
    assert.equal(subscription.pendingTurn?.lastResponseAt, null);
  });

  it('does not reset content response time for tool progress', () => {
    const subscription = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: null,
    } as any;

    consumeMirrorRecords(subscription, [
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: '正文输出',
        timestamp: '2026-04-21T10:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'tool-1',
        type: 'tool_started',
        content: '',
        timestamp: '2026-04-21T10:03:00.000Z',
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'shell_command',
      },
    ]);

    assert.equal(subscription.pendingTurn?.lastActivityAt, '2026-04-21T10:03:00.000Z');
    assert.equal(subscription.pendingTurn?.lastContentResponseAt, '2026-04-21T10:00:01.000Z');
    assert.equal(subscription.pendingTurn?.lastResponseAt, '2026-04-21T10:00:01.000Z');
  });
});
