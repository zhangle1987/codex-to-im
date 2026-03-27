import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildToolProgressMarkdown } from '../lib/bridge/markdown/feishu.js';

describe('buildToolProgressMarkdown', () => {
  it('groups repeated tools by name and keeps running state visible', () => {
    const rendered = buildToolProgressMarkdown([
      { id: '1', name: 'shell_command', status: 'complete' },
      { id: '2', name: 'shell_command', status: 'complete' },
      { id: '3', name: 'shell_command', status: 'running' },
      { id: '4', name: 'apply_patch', status: 'error' },
      { id: '5', name: 'apply_patch', status: 'complete' },
      { id: '6', name: 'update_plan', status: 'complete' },
    ]);

    assert.match(rendered, /🔄 `shell_command` ×3（运行中 1 \/ 完成 2）/);
    assert.match(rendered, /❌ `apply_patch` ×2（异常 1 \/ 完成 1）/);
    assert.match(rendered, /✅ `update_plan`/);
  });
});
