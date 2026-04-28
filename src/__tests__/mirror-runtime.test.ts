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
  flushTimedOutMirrorTurn,
  hasPendingMirrorWork,
} from '../lib/bridge/mirror-turns.js';

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
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, 600_000, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, 600_000, Date.now()),
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
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, 600_000, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, 600_000, Date.now()),
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
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, 600_000, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, 600_000, Date.now()),
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
      consumeMirrorRecords: (subscription, records) => consumeMirrorRecords(subscription, records),
      flushTimedOutMirrorTurn: (subscription) => flushTimedOutMirrorTurn(subscription, 600_000, Date.now()),
      hasPendingMirrorWork: (subscription) => hasPendingMirrorWork(subscription),
      consumeBufferedMirrorTurns: (subscription) => consumeBufferedMirrorTurns(subscription, 600_000, Date.now()),
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
});
