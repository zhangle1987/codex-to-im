import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinalCardJson,
  buildTaskProgressMarkdown,
  buildToolProgressMarkdown,
} from '../lib/bridge/markdown/feishu.js';

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

  it('normalizes terminal tool state so final cards do not show running tools', () => {
    const rendered = buildToolProgressMarkdown([
      { id: '1', name: 'shell_command', status: 'running' },
      { id: '2', name: 'apply_patch', status: 'running' },
    ], { terminalStatus: 'completed' });

    assert.doesNotMatch(rendered, /运行中/);
    assert.match(rendered, /✅ `shell_command`/);
    assert.match(rendered, /✅ `apply_patch`/);
  });
});

describe('buildTaskProgressMarkdown', () => {
  it('keeps waiting state visible while streaming but not after terminal completion', () => {
    const tasks = [
      { text: '读取日志', status: 'completed' as const },
      { text: '分析原因', status: 'in_progress' as const },
      { text: '补测试', status: 'pending' as const },
    ];

    const streaming = buildTaskProgressMarkdown(tasks);
    const terminal = buildTaskProgressMarkdown(tasks, { terminalStatus: 'completed' });

    assert.match(streaming, /分析原因（执行中）/);
    assert.match(streaming, /补测试（等待中）/);
    assert.doesNotMatch(terminal, /执行中|等待中/);
    assert.match(terminal, /分析原因（已结束）/);
    assert.match(terminal, /补测试（已结束）/);
  });
});

describe('buildFinalCardJson', () => {
  it('renders terminal task and tool states without active waiting labels', () => {
    const cardJson = buildFinalCardJson(
      '最终回复',
      [
        { text: '读取日志', status: 'completed' },
        { text: '补测试', status: 'pending' },
      ],
      [
        { id: 'tool-1', name: 'shell_command', status: 'running' },
      ],
      { status: '✅ Completed', elapsed: '1m 0s' },
      'completed',
    );

    assert.doesNotMatch(cardJson, /等待中|运行中/);
    assert.match(cardJson, /补测试（已结束）/);
    assert.match(cardJson, /`shell_command`/);
  });
});
