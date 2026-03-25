import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { _testOnly } from '../lib/bridge/bridge-manager.js';
import * as router from '../lib/bridge/channel-router.js';
import type { LifecycleHooks, LLMProvider, PermissionGateway, StreamChatParams } from '../lib/bridge/host.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', 'D:\\work\\default'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

const noopLlm: LLMProvider = {
  streamChat(_params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

const noopPermissions: PermissionGateway = {
  resolvePendingPermission: () => false,
};

const noopLifecycle: LifecycleHooks = {};

describe('bridge-manager resolveNewWorkingDirectory', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('resolves a relative project name inside the configured workspace root', () => {
    const settings = makeSettings();
    settings.set('bridge_default_workspace_root', 'D:\\workspace');
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });

    const resolved = _testOnly.resolveNewWorkingDirectory('proj1');
    assert.deepEqual(resolved, {
      ok: true,
      workDir: path.resolve('D:\\workspace', 'proj1'),
    });
  });

  it('rejects relative paths that escape the configured workspace root', () => {
    const settings = makeSettings();
    settings.set('bridge_default_workspace_root', 'D:\\workspace');
    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });

    const resolved = _testOnly.resolveNewWorkingDirectory('..\\evil');
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.message, /不能使用 \.\.|越界/);
    }
  });

  it('falls back to ~/cx2im when no workspace root is configured', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });

    const resolved = _testOnly.resolveNewWorkingDirectory('proj1');
    assert.deepEqual(resolved, {
      ok: true,
      workDir: path.resolve(os.homedir(), 'cx2im', 'proj1'),
    });
  });
});

describe('bridge-manager resolveCommandAlias', () => {
  it('maps root slash to status', () => {
    assert.equal(_testOnly.resolveCommandAlias('/', ''), '/status');
  });

  it('maps short desktop thread alias based on args', () => {
    assert.equal(_testOnly.resolveCommandAlias('/t', ''), '/threads');
    assert.equal(_testOnly.resolveCommandAlias('/t', '1'), '/thread');
  });

  it('maps short session and history aliases', () => {
    assert.equal(_testOnly.resolveCommandAlias('/s', ''), '/sessions');
    assert.equal(_testOnly.resolveCommandAlias('/s', '2'), '/use');
    assert.equal(_testOnly.resolveCommandAlias('/his', ''), '/history');
    assert.equal(_testOnly.resolveCommandAlias('/his', 'raw'), '/history');
  });

  it('maps mode, reasoning, new, and help aliases', () => {
    assert.equal(_testOnly.resolveCommandAlias('/m', ''), '/mode');
    assert.equal(_testOnly.resolveCommandAlias('/r', 'high'), '/reasoning');
    assert.equal(_testOnly.resolveCommandAlias('/n', 'proj1'), '/new');
    assert.equal(_testOnly.resolveCommandAlias('/h', ''), '/help');
  });

  it('maps numeric reasoning aliases to supported effort levels', () => {
    assert.equal(_testOnly.normalizeReasoningEffort('0'), 'minimal');
    assert.equal(_testOnly.normalizeReasoningEffort('1'), 'low');
    assert.equal(_testOnly.normalizeReasoningEffort('2'), 'medium');
    assert.equal(_testOnly.normalizeReasoningEffort('3'), 'high');
    assert.equal(_testOnly.normalizeReasoningEffort('4'), 'xhigh');
    assert.equal(_testOnly.normalizeReasoningEffort('5'), 'xhigh');
    assert.equal(_testOnly.normalizeReasoningEffort('xhigh'), 'xhigh');
    assert.equal(_testOnly.normalizeReasoningEffort('9'), null);
  });
});

describe('bridge-manager status formatting', () => {
  it('formats runtime states with queued counts', () => {
    assert.equal(_testOnly.formatRuntimeStatus({ id: 's-1', working_directory: '', model: '', runtime_status: 'idle' }), '空闲');
    assert.equal(_testOnly.formatRuntimeStatus({ id: 's-1', working_directory: '', model: '', runtime_status: 'running' }), '运行中');
    assert.equal(
      _testOnly.formatRuntimeStatus({ id: 's-1', working_directory: '', model: '', runtime_status: 'queued', queued_count: 2 }),
      '排队中（2）',
    );
  });

  it('formats mirror state summaries', () => {
    assert.equal(_testOnly.formatMirrorStatus({ id: 's-1', working_directory: '', model: '', mirror_status: 'inactive' }), '未监听');
    assert.equal(
      _testOnly.formatMirrorStatus({ id: 's-1', working_directory: '', model: '', mirror_status: 'stale' }),
      '待恢复（暂时没定位到桌面 thread 文件）',
    );
    assert.equal(
      _testOnly.formatMirrorStatus({
        id: 's-1',
        working_directory: '',
        model: '',
        mirror_status: 'watching',
        mirror_last_event_at: '2026-03-25T08:00:00.000Z',
      }),
      '监听中 · 最近同步 2026-03-25T08:00:00.000Z',
    );
  });

  it('formats mirror event batches for IM delivery', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', [
      {
        signature: '1',
        role: 'user',
        content: 'Desktop question',
        timestamp: '2026-03-25T08:00:00.000Z',
      },
      {
        signature: '2',
        role: 'assistant',
        content: 'Desktop answer',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
    ]);

    assert.equal(rendered, 'Current Thread 回复:\nDesktop answer');
  });

  it('omits desktop user mirror text when there is no codex output', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', [
      {
        signature: '1',
        role: 'user',
        content: 'Desktop question',
        timestamp: '2026-03-25T08:00:00.000Z',
      },
    ]);

    assert.equal(rendered, '');
  });
});

describe('channel-router defaults', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('creates regular sessions in code mode by default', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });

    const binding = router.resolve({
      channelType: 'feishu',
      chatId: 'chat-default-mode',
    });
    const session = store.getSession(binding.codepilotSessionId);

    assert.equal(binding.mode, 'code');
    assert.equal(session?.preferred_mode, 'code');
  });
});
