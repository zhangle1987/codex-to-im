import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routeDesktopRecords } from '../lib/bridge/turns/desktop-terminal-router.js';
import type { DesktopMirrorRecord } from '../desktop-sessions.js';
import type { TurnCoordinator } from '../lib/bridge/turns/turn-coordinator.js';

function record(
  signature: string,
  type: DesktopMirrorRecord['type'],
  content: string,
  turnId = 'desktop-turn-1',
): DesktopMirrorRecord {
  return {
    signature,
    type,
    content,
    timestamp: '2026-04-27T00:00:00.000Z',
    turnId,
  };
}

describe('desktop-terminal-router', () => {
  it('claims terminal records and removes the claimed turn from mirror delivery', async () => {
    const claims: string[] = [];
    const coordinator: Pick<TurnCoordinator, 'claimDesktopTerminal'> = {
      claimDesktopTerminal: async (terminal) => {
        claims.push(`${terminal.desktopThreadId}:${terminal.text}`);
        return { claimed: true };
      },
    };
    const records = [
      record('message-1', 'message', 'partial'),
      record('terminal-1', 'task_complete', 'final'),
      record('other-1', 'message', 'other turn', 'other-turn'),
    ];

    const result = await routeDesktopRecords('session-1', 'desktop-thread-1', records, coordinator);

    assert.equal(result.terminalClaimed, true);
    assert.equal(result.claimedTurnId, 'desktop-turn-1');
    assert.equal(result.claimedAt, '2026-04-27T00:00:00.000Z');
    assert.deepEqual(result.claimed.map((item) => item.signature), ['message-1', 'terminal-1']);
    assert.deepEqual(result.unclaimed.map((item) => item.signature), ['other-1']);
    assert.deepEqual(claims, ['desktop-thread-1:final']);
  });

  it('leaves records unclaimed when no active IM turn accepts the terminal', async () => {
    const coordinator: Pick<TurnCoordinator, 'claimDesktopTerminal'> = {
      claimDesktopTerminal: async () => ({ claimed: false }),
    };
    const records = [
      record('message-1', 'message', 'partial'),
      record('terminal-1', 'task_aborted', 'stopped'),
    ];

    const result = await routeDesktopRecords('session-1', 'desktop-thread-1', records, coordinator);

    assert.equal(result.terminalClaimed, false);
    assert.equal(result.claimedTurnId, null);
    assert.equal(result.claimedAt, null);
    assert.deepEqual(result.claimed, []);
    assert.deepEqual(result.unclaimed, records);
  });
});
