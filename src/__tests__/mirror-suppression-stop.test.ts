import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterSuppressedMirrorRecords,
  ignoreMirrorTurn,
  type MirrorSuppressionConfig,
  type MirrorSuppressionStore,
} from '../lib/bridge/mirror-suppression.js';

describe('mirror suppression for an IM-stopped handoff turn', () => {
  it('drops the remaining turn records and releases the ignore marker on task_aborted', () => {
    const store: MirrorSuppressionStore = {
      suppressions: new Map(),
      ignoredTurnIds: new Map(),
    };
    const config: MirrorSuppressionConfig = {
      suppressionWindowMs: 4_000,
      promptMatchGraceMs: 120_000,
    };
    const now = 1_000;
    ignoreMirrorTurn(store, 'session-stop', config, 'turn-stop', now);

    const filtered = filterSuppressedMirrorRecords(store, 'session-stop', [{
      signature: 'partial-stop',
      type: 'message',
      role: 'assistant',
      content: 'partial output after stop',
      timestamp: '2026-07-22T02:40:00.000Z',
      turnId: 'turn-stop',
    }, {
      signature: 'terminal-stop',
      type: 'task_aborted',
      content: '',
      timestamp: '2026-07-22T02:40:01.000Z',
      turnId: 'turn-stop',
    }], config, now + 1);

    assert.deepEqual(filtered, []);
    const later = {
      signature: 'later-stop',
      type: 'message' as const,
      role: 'assistant' as const,
      content: 'later unrelated replay',
      timestamp: '2026-07-22T02:41:00.000Z',
      turnId: 'turn-stop',
    };
    assert.deepEqual(
      filterSuppressedMirrorRecords(store, 'session-stop', [later], config, now + 2),
      [later],
    );
  });
});
