import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDesktopHandoffControl,
  type DesktopHandoffTaskRegistration,
} from '../lib/bridge/desktop-handoff-control.js';
import type { BridgeSession } from '../lib/bridge/host.js';
import type { ManagedCodexExecProcessIdentity } from '../lib/bridge/managed-codex-process.js';

const registration: DesktopHandoffTaskRegistration = {
  sessionId: 'session-handoff',
  taskId: 'task-handoff',
  threadId: '019f267c-77ed-7453-94ba-456ce2677ee1',
  turnId: 'turn-handoff',
};

const processIdentity: ManagedCodexExecProcessIdentity = {
  threadId: registration.threadId,
  pid: 1200,
  parentPid: 4321,
  createdAt: '2026-07-22T02:41:18.440405+08:00',
};

function createStore() {
  const session: BridgeSession = {
    id: registration.sessionId,
    working_directory: 'D:\\workspace',
    model: 'test-model',
    updated_at: '2026-07-22T00:00:00.000Z',
  };
  const touchOptions: Array<{ touch?: boolean } | undefined> = [];
  return {
    session,
    touchOptions,
    store: {
      getSession(sessionId: string) {
        return sessionId === session.id ? session : null;
      },
      updateSession(
        sessionId: string,
        updates: Partial<BridgeSession>,
        options?: { touch?: boolean },
      ) {
        if (sessionId !== session.id) return;
        Object.assign(session, updates);
        touchOptions.push(options);
      },
    },
  };
}

describe('desktop handoff control', () => {
  it('captures and persists a verified bridge-owned process without touching session recency', async () => {
    const fixture = createStore();
    const control = createDesktopHandoffControl({
      getStore: () => fixture.store,
      ownerPid: 4321,
      nowIso: () => '2026-07-22T02:42:00.000Z',
      captureProcess: async () => processIdentity,
    });

    assert.equal(await control.prepareTask(registration), true);
    assert.equal(fixture.session.desktop_handoff_task_id, registration.taskId);
    assert.equal(fixture.session.desktop_handoff_turn_id, registration.turnId);
    assert.equal(fixture.session.desktop_handoff_process_pid, processIdentity.pid);
    assert.equal(control.hasTask(registration.sessionId), false);
    assert.equal(control.activateTask(registration.sessionId, registration.taskId), true);
    assert.equal(control.hasTask(registration.sessionId), true);
    assert.ok(fixture.touchOptions.every((options) => options?.touch === false));
  });

  it('stops the captured process and clears the persisted control record', async () => {
    const fixture = createStore();
    const stopped: ManagedCodexExecProcessIdentity[] = [];
    const control = createDesktopHandoffControl({
      getStore: () => fixture.store,
      ownerPid: 4321,
      captureProcess: async () => processIdentity,
    });

    await control.prepareTask(registration);
    control.activateTask(registration.sessionId, registration.taskId);
    const recoveredControl = createDesktopHandoffControl({
      getStore: () => fixture.store,
      ownerPid: 9999,
      captureProcess: async () => {
        throw new Error('persisted identity should be reused');
      },
      stopProcess: async (identity) => {
        stopped.push(identity);
        return { status: 'stopped' };
      },
    });
    const result = await recoveredControl.stopTask(registration.sessionId);

    assert.equal(result.status, 'stopped');
    assert.deepEqual(stopped, [processIdentity]);
    assert.equal(recoveredControl.hasTask(registration.sessionId), false);
    assert.equal(fixture.session.desktop_handoff_process_pid, undefined);
  });

  it('clears the control record when mirror observes the matching terminal turn', async () => {
    const fixture = createStore();
    const control = createDesktopHandoffControl({
      getStore: () => fixture.store,
      ownerPid: 4321,
      captureProcess: async () => processIdentity,
    });

    await control.prepareTask(registration);
    control.observeRecords(registration.sessionId, registration.threadId, [{
      signature: 'terminal-handoff',
      type: 'task_aborted',
      content: '',
      timestamp: '2026-07-22T02:43:00.000Z',
      turnId: registration.turnId,
    }]);

    assert.equal(control.hasTask(registration.sessionId), false);
  });

  it('keeps the task recoverable when safe process ownership cannot be verified', async () => {
    const fixture = createStore();
    const control = createDesktopHandoffControl({
      getStore: () => fixture.store,
      ownerPid: 4321,
      captureProcess: async () => null,
    });

    assert.equal(await control.prepareTask(registration), false);
    control.activateTask(registration.sessionId, registration.taskId);
    const result = await control.stopTask(registration.sessionId);

    assert.equal(result.status, 'unavailable');
    assert.equal(control.hasTask(registration.sessionId), true);
  });
});
