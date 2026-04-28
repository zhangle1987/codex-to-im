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

  it('heals stale terminal runtime state back to idle when no active task remains', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Heal', 'test-model', undefined, 'D:\\workspace\\runtime-heal', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:00:00.000Z',
    });

    store.updateSession(session.id, {
      runtime_status: 'running',
      queued_count: 2,
      health_status: 'completed',
      health_reason: '任务已完成。',
      last_runtime_update_at: '2026-04-20T15:00:00.000Z',
    });

    await runtime.reconcileTerminalSessionRuntimeState();

    const healed = store.getSession(session.id);
    assert.equal(healed?.runtime_status, 'idle');
    assert.equal(healed?.queued_count || 0, 0);
    assert.equal(healed?.last_runtime_update_at, '2026-04-20T16:00:00.000Z');
  });

  it('does not finalize an active task from terminal health alone', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestBridgeContext(store);
    const session = store.createSession('Runtime Heal Active', 'test-model', undefined, 'D:\\workspace\\runtime-heal-active', 'code');
    const state = {
      activeTasks: new Map(),
      queuedCounts: new Map(),
      sessionLocks: new Map(),
    };
    const runtime = createInteractiveRuntime(() => state, {
      getStore: () => store,
      nowIso: () => '2026-04-20T16:05:00.000Z',
    });
    let finalized: Array<{ outcome: string; detail?: string }> = [];

    runtime.registerInteractiveTask({
      id: 'task-heal-active',
      abortController: new AbortController(),
      adapter: { channelType: 'feishu', provider: 'feishu' } as never,
      address: { channelType: 'feishu', chatId: 'chat-heal-active' },
      requestMessageId: 'msg-heal-active',
      streamKey: 'stream-heal-active',
      sessionId: session.id,
      hasStreamingCards: false,
      structuredStreamUiActive: false,
      lastActivityAt: Date.now(),
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
      finalizeFromExternalTerminal: async (outcome, detail) => {
        finalized.push({ outcome, detail });
        runtime.releaseInteractiveTask(session.id, 'task-heal-active');
        return true;
      },
    });

    store.updateSession(session.id, {
      health_status: 'completed',
      health_reason: '检测到桌面线程已完成当前任务。',
      last_runtime_update_at: '2026-04-20T15:05:00.000Z',
    });

    await runtime.reconcileTerminalSessionRuntimeState();

    const running = store.getSession(session.id);
    assert.deepEqual(finalized, []);
    assert.equal(running?.runtime_status, 'running');
    assert.equal(state.activeTasks.has(session.id), true);
  });
});
