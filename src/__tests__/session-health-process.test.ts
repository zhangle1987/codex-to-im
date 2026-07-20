import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isCodexThreadProcessDefinitelyGone,
  type ThreadProcessProbeResult,
} from '../lib/bridge/session-health-process.js';

function result(
  threadId: string,
  status: ThreadProcessProbeResult['status'],
): ThreadProcessProbeResult {
  return {
    threadId,
    status,
    supported: status !== 'unsupported',
    checkedAt: '2026-07-20T14:30:00.000Z',
  };
}

describe('isCodexThreadProcessDefinitelyGone', () => {
  it('keeps a Desktop thread active while a Codex app-server host still exists', async () => {
    const probes: string[] = [];
    const gone = await isCodexThreadProcessDefinitelyGone('desktop-thread', async (value) => {
      probes.push(value);
      return value === 'desktop-thread'
        ? result(value, 'not_found')
        : result(value, 'alive');
    });

    assert.equal(gone, false);
    assert.deepEqual(probes, ['desktop-thread', 'app-server']);
  });

  it('confirms disappearance only when both the thread and app-server are missing', async () => {
    const gone = await isCodexThreadProcessDefinitelyGone(
      'desktop-thread',
      async (value) => result(value, 'not_found'),
    );

    assert.equal(gone, true);
  });

  it('treats unsupported and probe errors as inconclusive', async () => {
    for (const status of ['unsupported', 'error'] as const) {
      const gone = await isCodexThreadProcessDefinitelyGone(
        'desktop-thread',
        async (value) => result(value, status),
      );
      assert.equal(gone, false);
    }
  });
});
