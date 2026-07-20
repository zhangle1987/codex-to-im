import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renameFileWithRetrySync } from '../atomic-file.js';

describe('renameFileWithRetrySync', () => {
  it('retries transient Windows rename failures with bounded backoff', () => {
    let attempts = 0;
    const delays: number[] = [];

    renameFileWithRetrySync('source.tmp', 'target.json', {
      maxAttempts: 4,
      baseDelayMs: 5,
      renameSync: () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('busy'), { code: 'EPERM' });
        }
      },
      sleepSync: (delayMs) => { delays.push(delayMs); },
    });

    assert.equal(attempts, 3);
    assert.deepEqual(delays, [5, 10]);
  });

  it('does not retry non-transient rename failures', () => {
    let attempts = 0;

    assert.throws(() => renameFileWithRetrySync('source.tmp', 'target.json', {
      maxAttempts: 4,
      renameSync: () => {
        attempts += 1;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      sleepSync: () => { throw new Error('sleep should not run'); },
    }), /missing/);

    assert.equal(attempts, 1);
  });
});
