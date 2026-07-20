import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeRuntimeStatus } from '../runtime-status.js';

function readStatus(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

describe('writeRuntimeStatus', () => {
  it('rejects stale daemon writes after a newer run has claimed the status file', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-runtime-status-'));
    const filePath = path.join(tempRoot, 'runtime', 'status.json');

    assert.equal(writeRuntimeStatus(filePath, {
      running: true,
      pid: 200,
      runId: 'new-run',
    }, {
      expectedRunId: 'new-run',
      allowRunIdTakeover: true,
    }), true);

    assert.equal(writeRuntimeStatus(filePath, {
      running: false,
      pid: 100,
      runId: 'old-run',
      lastExitReason: 'stale daemon failed',
    }, {
      expectedRunId: 'old-run',
    }), false);

    assert.deepEqual(readStatus(filePath), {
      running: true,
      pid: 200,
      runId: 'new-run',
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('allows the current daemon to update its own status', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-runtime-status-'));
    const filePath = path.join(tempRoot, 'runtime', 'status.json');

    writeRuntimeStatus(filePath, {
      running: true,
      pid: 200,
      runId: 'current-run',
      channels: ['feishu-default'],
    }, {
      expectedRunId: 'current-run',
      allowRunIdTakeover: true,
    });
    assert.equal(writeRuntimeStatus(filePath, {
      running: false,
      lastExitReason: 'signal: SIGTERM',
    }, {
      expectedRunId: 'current-run',
    }), true);

    assert.deepEqual(readStatus(filePath), {
      running: false,
      pid: 200,
      runId: 'current-run',
      channels: ['feishu-default'],
      lastExitReason: 'signal: SIGTERM',
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
