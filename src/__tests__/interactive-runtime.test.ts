import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { createInteractiveRuntime } from '../lib/bridge/interactive-runtime.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

describe('interactive-runtime', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('tracks queued session state around the per-session lock boundary', async () => {
    const store = new JsonFileStore(makeSettings());
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
});
