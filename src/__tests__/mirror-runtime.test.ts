import './test-setup.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../lib/bridge/context.js';
import { createMirrorRuntime } from '../lib/bridge/mirror-runtime.js';
import {
  consumeBufferedMirrorTurns,
  consumeMirrorRecords,
  createMirrorTurnState,
  flushTimedOutMirrorTurn,
  hasPendingMirrorWork,
} from '../lib/bridge/mirror-turns.js';
import { routeDesktopRecords } from '../lib/bridge/turns/desktop-terminal-router.js';

const MIRROR_TEST_BUFFER_TIMEOUT_MS = 10 * 60_000;
const MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS = 30 * 60_000;

const noopLlm = {
  streamChat() {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

const noopPermissions = {
  resolvePendingPermission: () => false,
};

describe('mirror-runtime pending deliveries', () => {
  let runtime: ReturnType<typeof createMirrorRuntime> | null = null;

  afterEach(() => {
    runtime?.clearMirrorSubscriptions();
    runtime = null;
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  it('retries queued finalized turns even when the mirror file has no new bytes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'thread-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      sdk_session_id: 'thread-1',
      desktop_thread_id: 'thread-1',
      thread_origin: 'desktop',
      mirror_last_event_at: null,
    };
    const store = {
      listChannelBindings: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSdkSessionId: () => {},
    };
    initBridgeContext({
      store: store as never,
      llm: noopLlm as never,
      permissions: noopPermissions as never,
      lifecycle: {},
    });

    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveryCalls: string[][] = [];
    let failedOnce = false;

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      streamOrphanTimeoutMs: MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      getDesktopSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      recordOrphanedMirrorTurn: () => {},
      isThreadProcessDefinitelyGone: async () => false,
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveryCalls.push(turns.map((turn) => turn.signature));
        if (!failedOnce) {
          failedOnce = true;
          return { deliveredCount: 0, error: new Error('send failed') };
        }
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-21T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final answer' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'final answer',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterFailure = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterFailure);
    assert.equal(subscriptionAfterFailure?.pendingDeliveries.length, 1);
    assert.equal(deliveryCalls.length, 1);

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterRetry = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterRetry);
    assert.equal(subscriptionAfterRetry?.pendingDeliveries.length, 0);
    assert.equal(deliveryCalls.length, 2);
    assert.deepEqual(deliveryCalls[1], deliveryCalls[0]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('delivers a finalized turn once on the normal success path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'thread-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      sdk_session_id: 'thread-1',
      desktop_thread_id: 'thread-1',
      thread_origin: 'desktop',
      mirror_last_event_at: null,
    };
    const store = {
      listChannelBindings: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSdkSessionId: () => {},
    };
    initBridgeContext({
      store: store as never,
      llm: noopLlm as never,
      permissions: noopPermissions as never,
      lifecycle: {},
    });

    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveryCalls: string[][] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      streamOrphanTimeoutMs: MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      getDesktopSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      recordOrphanedMirrorTurn: () => {},
      isThreadProcessDefinitelyGone: async () => false,
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveryCalls.push(turns.map((turn) => turn.signature));
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-21T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final answer' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'final answer',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterSuccess = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterSuccess);
    assert.equal(subscriptionAfterSuccess?.pendingDeliveries.length, 0);
    assert.equal(deliveryCalls.length, 1);
    assert.equal(deliveryCalls[0]?.length, 1);

    await runtime.reconcileMirrorSubscriptions();

    const subscriptionAfterReplay = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscriptionAfterReplay);
    assert.equal(subscriptionAfterReplay?.pendingDeliveries.length, 0);
    assert.equal(deliveryCalls.length, 1);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('discards buffered mirror state when an IM turn claims the desktop terminal', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'thread-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      sdk_session_id: 'thread-1',
      desktop_thread_id: 'thread-1',
      thread_origin: 'desktop',
      mirror_last_event_at: null,
    };
    const store = {
      listChannelBindings: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSdkSessionId: () => {},
    };
    initBridgeContext({
      store: store as never,
      llm: noopLlm as never,
      permissions: noopPermissions as never,
      lifecycle: {},
    });

    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map([['session-1', {}]]),
    };
    let stoppedStreams = 0;
    let deliveredTurns = 0;

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      streamOrphanTimeoutMs: MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS,
    }, {
      nowIso: () => '2026-07-20T04:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      getDesktopSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1' ? { id: threadId, filePath } as never : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      recordOrphanedMirrorTurn: () => {},
      isThreadProcessDefinitelyGone: async () => false,
      routeDesktopRecords: (sessionId, threadId, records) => routeDesktopRecords(
        sessionId,
        threadId,
        records,
        { claimDesktopTerminal: async () => ({ claimed: true }) },
      ),
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => { stoppedStreams += 1; },
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveredTurns += turns.length;
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-07-20T04:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'im-turn' },
      }),
      JSON.stringify({
        timestamp: '2026-07-20T04:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'working' }],
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    const subscription = state.mirrorSubscriptions.get('binding-1');
    assert.ok(subscription);
    assert.equal(subscription.bufferedRecords.length, 2);
    const pendingTurn = createMirrorTurnState('session-1', '2026-07-20T04:00:01.000Z', 'im-turn');
    pendingTurn.streamStarted = true;
    pendingTurn.userText = '好的，开始吧';
    subscription.pendingTurn = pendingTurn;
    subscription.pendingDeliveries.push({
      streamKey: pendingTurn.streamKey,
      userText: '好的，开始吧',
      text: 'duplicate',
      signature: 'duplicate-terminal',
      timestamp: '2026-07-20T04:00:02.500Z',
      status: 'completed',
    });
    state.activeTasks.clear();

    fs.appendFileSync(filePath, JSON.stringify({
      timestamp: '2026-07-20T04:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'im-turn',
        last_agent_message: 'final answer',
      },
    }) + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    assert.equal(subscription.bufferedRecords.length, 0);
    assert.equal(subscription.pendingTurn, null);
    assert.equal(subscription.pendingDeliveries.length, 0);
    assert.equal(subscription.lastDeliveredAt, '2026-07-20T04:00:03.000Z');
    assert.equal(stoppedStreams, 1);
    assert.equal(deliveredTurns, 0);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('delivers surviving mirror records after suppression filtering without treating suppression as a global block', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'thread-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      sdk_session_id: 'thread-1',
      desktop_thread_id: 'thread-1',
      thread_origin: 'desktop',
      mirror_last_event_at: null,
    };
    const store = {
      listChannelBindings: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSdkSessionId: () => {},
    };
    initBridgeContext({
      store: store as never,
      llm: noopLlm as never,
      permissions: noopPermissions as never,
      lifecycle: {},
    });

    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveryCalls: string[][] = [];
    const filteredSignatures: string[] = [];

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      streamOrphanTimeoutMs: MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      getDesktopSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => {
        filteredSignatures.push(...records.map((record) => record.signature));
        return records.filter((record) => record.turnId !== 'echo-turn');
      },
      observeSessionHealthRecords: () => {},
      recordOrphanedMirrorTurn: () => {},
      isThreadProcessDefinitelyGone: async () => false,
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (_subscription, turns) => {
        deliveryCalls.push(turns.map((turn) => turn.signature));
        return { deliveredCount: turns.length };
      },
    });

    await runtime.reconcileMirrorSubscriptions();

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-04-21T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'echo-turn',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'echo-turn',
          last_agent_message: 'echo answer',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'desktop-turn',
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-21T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'desktop-turn',
          last_agent_message: 'desktop answer',
        },
      }),
    ].join('\n') + '\n', 'utf-8');

    await runtime.reconcileMirrorSubscriptions();

    assert.equal(filteredSignatures.length > 0, true);
    assert.equal(deliveryCalls.length, 1);
    assert.equal(deliveryCalls[0]?.length, 1);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('logs each unknown desktop mirror event kind at most once per subscription', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-1',
      channelType: 'feishu-default',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'thread-1',
      active: true,
    }];
    const session = {
      id: 'session-1',
      sdk_session_id: 'thread-1',
      desktop_thread_id: 'thread-1',
      thread_origin: 'desktop',
      mirror_last_event_at: null,
    };
    const store = {
      listChannelBindings: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSdkSessionId: () => {},
    };
    initBridgeContext({
      store: store as never,
      llm: noopLlm as never,
      permissions: noopPermissions as never,
      lifecycle: {},
    });

    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };

    runtime = createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      streamOrphanTimeoutMs: MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS,
    }, {
      nowIso: () => '2026-04-21T10:00:00.000Z',
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      getDesktopSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-1'
          ? {
              id: threadId,
              filePath,
            } as never
          : null
      ),
      syncMirrorSessionStateSafe: () => {},
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      recordOrphanedMirrorTurn: () => {},
      isThreadProcessDefinitelyGone: async () => false,
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, MIRROR_TEST_BUFFER_TIMEOUT_MS, Date.now()),
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async () => ({ deliveredCount: 0 }),
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await runtime.reconcileMirrorSubscriptions();

      fs.appendFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-04-21T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'approval_request',
          },
        }),
      ].join('\n') + '\n', 'utf-8');

      await runtime.reconcileMirrorSubscriptions();

      fs.appendFileSync(filePath, [
        JSON.stringify({
          timestamp: '2026-04-21T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'approval_request',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-21T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'approval_request_started',
          },
        }),
      ].join('\n') + '\n', 'utf-8');

      await runtime.reconcileMirrorSubscriptions();
    } finally {
      console.warn = originalWarn;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    const approvalRequestWarnings = warnings.filter((line) => line.includes('response_item:approval_request'));
    const approvalStartedWarnings = warnings.filter((line) => line.includes('event_msg:approval_request_started'));
    assert.equal(approvalRequestWarnings.length, 1);
    assert.equal(approvalStartedWarnings.length, 1);
  });

  it('finalizes a stale streamed turn only after Codex processes definitely disappear and does not replay it', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mirror-runtime-'));
    const filePath = path.join(tempRoot, 'rollout.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const bindings = [{
      id: 'binding-orphan',
      channelType: 'feishu-default',
      chatId: 'chat-orphan',
      codepilotSessionId: 'session-orphan',
      sdkSessionId: 'thread-orphan',
      active: true,
    }];
    const session: {
      id: string;
      sdk_session_id: string;
      desktop_thread_id: string;
      thread_origin: 'desktop';
      runtime_status: 'idle';
      mirror_last_event_at: string | null;
    } = {
      id: 'session-orphan',
      sdk_session_id: 'thread-orphan',
      desktop_thread_id: 'thread-orphan',
      thread_origin: 'desktop',
      runtime_status: 'idle',
      mirror_last_event_at: null,
    };
    const store = {
      listChannelBindings: () => bindings,
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      updateSdkSessionId: () => {},
    };
    initBridgeContext({
      store: store as never,
      llm: noopLlm as never,
      permissions: noopPermissions as never,
      lifecycle: {},
    });

    const state = {
      running: true,
      adapters: new Map([
        ['feishu-default', { channelType: 'feishu-default', provider: 'feishu', isRunning: () => false }],
      ]),
      mirrorSubscriptions: new Map(),
      mirrorWakeTimer: null,
      mirrorSyncInFlight: false,
      activeTasks: new Map(),
    };
    const deliveries: Array<Array<{
      signature: string;
      status: string;
      timestamp: string;
      timedOut?: boolean;
    }>> = [];
    const orphanReasons: string[] = [];
    let processDefinitelyGone = false;
    let probeCount = 0;
    let nowMs = Date.parse('2026-07-20T14:30:00.000Z');
    const originalDateNow = Date.now;
    Date.now = () => nowMs;

    const createRuntime = () => createMirrorRuntime(() => state as never, {
      watchDebounceMs: 0,
      danglingThreadRetryLimit: 3,
      failureSuspendThreshold: 3,
      failureSuspendMs: 60_000,
      streamOrphanTimeoutMs: MIRROR_TEST_STREAM_ORPHAN_TIMEOUT_MS,
    }, {
      nowIso: () => new Date(nowMs).toISOString(),
      describeUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
      getDesktopSessionByThreadIdSafe: (threadId) => (
        threadId === 'thread-orphan' ? { id: threadId, filePath } as never : null
      ),
      syncMirrorSessionStateSafe: () => {
        const subscription = state.mirrorSubscriptions.get('binding-orphan');
        if (subscription?.lastDeliveredAt) {
          session.mirror_last_event_at = subscription.lastDeliveredAt;
        }
      },
      filterSuppressedMirrorRecords: (_sessionId, records) => records,
      observeSessionHealthRecords: () => {},
      recordOrphanedMirrorTurn: (_sessionId, detail) => {
        orphanReasons.push(detail);
      },
      isThreadProcessDefinitelyGone: async () => {
        probeCount += 1;
        return processDefinitelyGone;
      },
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => (
        subscription.pendingTurn?.streamStarted
          ? null
          : flushTimedOutMirrorTurn(
              subscription,
              MIRROR_TEST_BUFFER_TIMEOUT_MS,
              Date.now(),
            )
      ),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => {
        const turns = consumeBufferedMirrorTurns(
          subscription,
          Number.POSITIVE_INFINITY,
          Date.now(),
        );
        if (subscription.pendingTurn) {
          subscription.pendingTurn.streamStarted = true;
        }
        return turns;
      },
      stopMirrorStreaming: () => {},
      deliverMirrorTurns: async (subscription, turns) => {
        deliveries.push(turns.map((turn) => ({ ...turn })));
        const lastTurn = turns.at(-1);
        if (lastTurn) subscription.lastDeliveredAt = lastTurn.timestamp;
        return { deliveredCount: turns.length };
      },
    });

    try {
      runtime = createRuntime();
      await runtime.reconcileMirrorSubscriptions();
      const initializedSubscription = state.mirrorSubscriptions.get('binding-orphan');
      initializedSubscription?.watcher?.close();
      if (initializedSubscription) {
        initializedSubscription.watcher = null;
      }

      const taskStartedAt = '2026-07-20T13:40:00.000Z';
      const lastActivityAt = '2026-07-20T13:49:00.000Z';
      fs.appendFileSync(filePath, [
        JSON.stringify({
          timestamp: taskStartedAt,
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-orphan' },
        }),
        JSON.stringify({
          timestamp: lastActivityAt,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial response' }],
          },
        }),
      ].join('\n') + '\n', 'utf-8');
      const staleFileTime = new Date(lastActivityAt);
      fs.utimesSync(filePath, staleFileTime, staleFileTime);

      await runtime.reconcileMirrorSubscriptions();

      const liveSubscription = state.mirrorSubscriptions.get('binding-orphan');
      assert.ok(liveSubscription?.pendingTurn?.streamStarted);
      assert.equal(probeCount, 1);
      assert.equal(deliveries.length, 0);
      assert.equal(orphanReasons.length, 0);

      processDefinitelyGone = true;
      nowMs += 61_000;
      await runtime.reconcileMirrorSubscriptions();

      assert.equal(probeCount, 2);
      assert.equal(liveSubscription?.pendingTurn, null);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.[0]?.status, 'interrupted');
      assert.equal(deliveries[0]?.[0]?.timedOut, true);
      assert.match(deliveries[0]?.[0]?.signature || '', /^timeout:/);
      assert.equal(orphanReasons.length, 1);
      assert.match(orphanReasons[0] || '', /未找到对应进程/);
      assert.equal(session.mirror_last_event_at, lastActivityAt);

      await runtime.reconcileMirrorSubscriptions();
      assert.equal(deliveries.length, 1);

      runtime.clearMirrorSubscriptions();
      runtime = createRuntime();
      await runtime.reconcileMirrorSubscriptions();
      assert.equal(deliveries.length, 1);
    } finally {
      Date.now = originalDateNow;
      runtime?.clearMirrorSubscriptions();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
