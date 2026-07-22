import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isManagedCodexExecProcess,
  stopManagedCodexExecProcess,
  type ManagedCodexExecProcessIdentity,
  type ManagedCodexProcessInspection,
  type ManagedCodexProcessSnapshot,
} from '../lib/bridge/managed-codex-process.js';

const THREAD_ID = '019f267c-77ed-7453-94ba-456ce2677ee1';

function snapshot(overrides: Partial<ManagedCodexProcessSnapshot> = {}): ManagedCodexProcessSnapshot {
  return {
    pid: 1200,
    parentPid: 4321,
    createdAt: '2026-07-22T02:41:18.440405+08:00',
    name: 'codex.exe',
    commandLine: `C:\\codex.exe exec --experimental-json --cd D:\\workspace resume ${THREAD_ID}`,
    ...overrides,
  };
}

function identity(): ManagedCodexExecProcessIdentity {
  return {
    threadId: THREAD_ID,
    pid: 1200,
    parentPid: 4321,
    createdAt: '2026-07-22T02:41:18.440405+08:00',
  };
}

describe('managed Codex exec process identity', () => {
  it('accepts only a direct bridge child running exec resume for the expected thread', () => {
    assert.equal(isManagedCodexExecProcess(snapshot(), identity()), true);
    assert.equal(isManagedCodexExecProcess(snapshot({ parentPid: 9999 }), identity()), false);
    assert.equal(isManagedCodexExecProcess(snapshot({
      commandLine: 'C:\\codex.exe app-server --analytics-default-enabled',
    }), identity()), false);
    assert.equal(isManagedCodexExecProcess(snapshot({
      commandLine: 'C:\\codex.exe exec --experimental-json resume another-thread',
    }), identity()), false);
  });

  it('refuses to terminate a reused or mismatched pid', async () => {
    let terminated = false;
    const result = await stopManagedCodexExecProcess(identity(), {
      inspectProcess: async () => ({
        status: 'found',
        process: snapshot({ createdAt: '2026-07-22T03:00:00.000000+08:00' }),
      }),
      terminateProcessTree: async () => { terminated = true; },
    });

    assert.equal(result.status, 'unsafe');
    assert.equal(terminated, false);
  });

  it('terminates the verified process tree and confirms exit', async () => {
    const inspections: ManagedCodexProcessInspection[] = [
      { status: 'found', process: snapshot() },
      { status: 'not_found' },
    ];
    const terminated: number[] = [];
    const result = await stopManagedCodexExecProcess(identity(), {
      inspectProcess: async () => inspections.shift() || { status: 'not_found' },
      terminateProcessTree: async (pid) => { terminated.push(pid); },
      sleep: async () => {},
    });

    assert.deepEqual(terminated, [1200]);
    assert.deepEqual(result, { status: 'stopped' });
  });
});
