import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnCoordinator } from '../lib/bridge/turns/turn-coordinator.js';
import type { ActiveBridgeTurn, BridgeTurnTerminalRecord } from '../lib/bridge/turns/turn-types.js';

function activeTurn(overrides: Partial<ActiveBridgeTurn> = {}): ActiveBridgeTurn {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    kind: 'im_desktop_reuse',
    origin: 'im',
    progressSource: 'sdk_stream',
    finalSource: 'desktop_task_complete',
    codexThreadId: 'desktop-thread-1',
    desktopThreadId: 'desktop-thread-1',
    startedAt: 1000,
    ...overrides,
  };
}

function terminal(overrides: Partial<BridgeTurnTerminalRecord> = {}): BridgeTurnTerminalRecord {
  return {
    sessionId: 'session-1',
    desktopThreadId: 'desktop-thread-1',
    turnId: 'desktop-turn-1',
    text: 'final answer',
    outcome: 'completed',
    timestamp: '2026-04-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('turn-coordinator', () => {
  it('claims a desktop terminal for the active IM desktop reuse turn', async () => {
    const finalized: string[] = [];
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async (turn, record) => {
        finalized.push(`${turn.id}:${record.text}`);
        return true;
      },
    });
    coordinator.registerInteractiveTurn(activeTurn());
    coordinator.associateDesktopTurn('session-1', 'desktop-turn-1');

    const result = await coordinator.claimDesktopTerminal(terminal());

    assert.equal(result.claimed, true);
    assert.equal(result.turn?.id, 'turn-1');
    assert.deepEqual(finalized, ['turn-1:final answer']);
  });

  it('does not claim terminals for pure IM SDK turns', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => {
        throw new Error('should not finalize');
      },
    });
    coordinator.registerInteractiveTurn(activeTurn({
      kind: 'im_sdk',
      desktopThreadId: undefined,
      finalSource: 'sdk_result',
    }));

    const result = await coordinator.claimDesktopTerminal(terminal());

    assert.equal(result.claimed, false);
  });

  it('does not claim a terminal before the Desktop turn is associated', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => true,
    });
    coordinator.registerInteractiveTurn(activeTurn());

    const result = await coordinator.claimDesktopTerminal(terminal());

    assert.equal(result.claimed, false);
  });

  it('does not claim terminals from another desktop thread', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => true,
    });
    coordinator.registerInteractiveTurn(activeTurn());
    coordinator.associateDesktopTurn('session-1', 'desktop-turn-1');

    const result = await coordinator.claimDesktopTerminal(terminal({
      desktopThreadId: 'other-thread',
    }));

    assert.equal(result.claimed, false);
  });

  it('only claims the desktop terminal associated with the active IM turn', async () => {
    const coordinator = createTurnCoordinator({
      finalizeTerminalTurn: async () => true,
    });
    coordinator.registerInteractiveTurn(activeTurn());
    assert.equal(coordinator.associateDesktopTurn('session-1', 'desktop-turn-expected'), true);

    const stale = await coordinator.claimDesktopTerminal(terminal({ turnId: 'desktop-turn-stale' }));
    const expected = await coordinator.claimDesktopTerminal(terminal({ turnId: 'desktop-turn-expected' }));

    assert.equal(stale.claimed, false);
    assert.equal(expected.claimed, true);
  });
});
