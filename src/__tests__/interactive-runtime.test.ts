import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { createInteractiveRuntime } from '../lib/bridge/interactive-runtime.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

function initTestBridgeContext(store: JsonFileStore): void {
  initBridgeContext({
    store,
    llm: {
      streamChat() {
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      },
    },
    permissions: {
      resolvePendingPermission: () => false,
    },
    lifecycle: {},
  });
}

describe('interactive-runtime', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('tracks queued session state around the per-session lock boundary', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Queue', 'test-model', undefined, 'D:\\workspace\\runtime-queue', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      idleReminderMs: 600_000,
    }, {
      getStore: () => store,
      nowIso: () => '2026-04-13T00:00:00.000Z',
    });

    runtime.registerInteractiveTask({
      id: 'task-1',
      abortController: new AbortController(),
      adapter: { channelType: 'feishu' } as never,
      address: { channelType: 'feishu', chatId: 'chat-1' },
      requestMessageId: 'msg-1',
      streamKey: 'stream-1',
      sessionId: session.id,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now(),
      idleReminderSent: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    let releaseFirstLock: (() => void) | undefined;
    const first = runtime.processWithSessionLock(session.id, async () => {
      await new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
    });
    const second = runtime.processWithSessionLock(session.id, async () => {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = store.getSession(session.id);
    assert.equal(queued?.runtime_status, 'queued');
    assert.equal(queued?.queued_count, 1);

    assert.ok(releaseFirstLock);
    releaseFirstLock();
    await Promise.all([first, second]);

    const running = store.getSession(session.id);
    assert.equal(running?.runtime_status, 'running');
    assert.equal(running?.queued_count || 0, 0);

    runtime.releaseInteractiveTask(session.id, 'task-1');

    const idle = store.getSession(session.id);
    assert.equal(idle?.runtime_status, 'idle');
    assert.equal(idle?.queued_count || 0, 0);
  });

  it('skips the legacy idle reminder for feishu streaming tasks that expose persistent status updates', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Idle', 'test-model', undefined, 'D:\\workspace\\runtime-idle', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      idleReminderMs: 600_000,
    }, {
      getStore: () => store,
      nowIso: () => '2026-04-13T00:00:00.000Z',
    });

    const sent: string[] = [];
    runtime.registerInteractiveTask({
      id: 'task-feishu-heartbeat',
      abortController: new AbortController(),
      adapter: {
        channelType: 'feishu',
        provider: 'feishu',
        onStreamStatus() {},
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: 'msg-idle' };
        },
      } as never,
      address: { channelType: 'feishu', chatId: 'chat-idle' },
      requestMessageId: 'msg-idle',
      streamKey: 'stream-idle',
      sessionId: session.id,
      hasStreamingCards: true,
      structuredStreamUiActive: true,
      lastActivityAt: Date.now() - (10 * 60 * 1000) - 1,
      idleReminderSent: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await runtime.reconcileIdleInteractiveTasks();

    assert.deepEqual(sent, []);
    assert.equal(state.activeTasks.get(session.id)?.idleReminderSent, false);
  });

  it('keeps the legacy idle reminder until the structured stream UI is actually active', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Idle Pending', 'test-model', undefined, 'D:\\workspace\\runtime-idle-pending', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      idleReminderMs: 600_000,
    }, {
      getStore: () => store,
      nowIso: () => '2026-04-13T00:00:00.000Z',
    });

    const sent: string[] = [];
    runtime.registerInteractiveTask({
      id: 'task-feishu-pending',
      abortController: new AbortController(),
      adapter: {
        channelType: 'feishu',
        provider: 'feishu',
        onStreamStatus() {},
        send: async (message: { text: string }) => {
          sent.push(message.text);
          return { ok: true, messageId: 'msg-idle-pending' };
        },
      } as never,
      address: { channelType: 'feishu', chatId: 'chat-idle-pending' },
      requestMessageId: 'msg-idle-pending',
      streamKey: 'stream-idle-pending',
      sessionId: session.id,
      hasStreamingCards: true,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now() - (10 * 60 * 1000) - 1,
      idleReminderSent: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await runtime.reconcileIdleInteractiveTasks();

    assert.equal(sent.length, 1);
    assert.match(sent[0] || '', /超过 10 分钟没有新的执行输出/);
    assert.equal(state.activeTasks.get(session.id)?.idleReminderSent, true);
  });
});
