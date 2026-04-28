import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStreamRuntimeStatus,
  createStreamState,
  formatRuntimeDuration,
  recordStreamActivity,
  recordStreamContentResponse,
  shouldShowStreamLastContentResponseAge,
  updateStreamStatusNote,
} from '../lib/bridge/turns/stream-state.js';

describe('stream-state', () => {
  it('formats durations without zero middle units and accumulates hours', () => {
    assert.equal(formatRuntimeDuration(10_000), '10秒');
    assert.equal(formatRuntimeDuration(70_000), '1分10秒');
    assert.equal(formatRuntimeDuration(60_000), '1分');
    assert.equal(formatRuntimeDuration(3_600_000), '1小时');
    assert.equal(formatRuntimeDuration(3_610_000), '1小时10秒');
    assert.equal(formatRuntimeDuration(3_720_000), '1小时2分');
    assert.equal(formatRuntimeDuration(3_730_000), '1小时2分10秒');
  });

  it('tracks content response time separately from activity time', () => {
    const state = createStreamState(0);
    recordStreamContentResponse(state, 1_000);
    recordStreamActivity(state, 180_000);
    updateStreamStatusNote(state, '正在执行工具', 190_000);

    assert.equal(state.lastActivityAtMs, 190_000);
    assert.equal(state.lastContentResponseAtMs, 1_000);
    assert.equal(
      buildStreamRuntimeStatus(state, 191_000, { includeLastContentResponseAge: true }),
      '当前步骤：正在执行工具\n已运行 3分11秒，上次响应距今 3分10秒',
    );
  });

  it('uses turn start as fallback when no content response exists', () => {
    const state = createStreamState(0);

    assert.equal(
      shouldShowStreamLastContentResponseAge(state, 179_000, {
        idleStartMs: 180_000,
        heartbeatMs: 10_000,
      }),
      false,
    );
    assert.equal(
      shouldShowStreamLastContentResponseAge(state, 180_000, {
        idleStartMs: 180_000,
        heartbeatMs: 10_000,
      }),
      true,
    );
    assert.equal(
      buildStreamRuntimeStatus(state, 180_000, { includeLastContentResponseAge: true }),
      '已运行 3分，上次响应距今 3分',
    );
  });
});
