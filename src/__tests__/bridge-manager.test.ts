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

  it('reuses the current formal session directory when /new has no args', () => {
    const resolved = _testOnly.resolveNewSessionWorkingDirectory(
      '',
      {
        id: 'binding-1',
        channelType: 'feishu',
        chatId: 'chat-1',
        codepilotSessionId: 'session-1',
        sdkSessionId: '',
        workingDirectory: 'D:\\workspace\\project-a',
        model: 'test-model',
        mode: 'code',
        active: true,
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
      },
      {
        id: 'session-1',
        name: 'Project A',
        working_directory: 'D:\\workspace\\project-a',
        model: 'test-model',
        session_type: 'normal',
      },
    );
    assert.deepEqual(resolved, {
      ok: true,
      workDir: path.resolve('D:\\workspace\\project-a'),
    });
  });

  it('rejects /new without args when the current chat is not bound', () => {
    const resolved = _testOnly.resolveNewSessionWorkingDirectory('', null, null);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.message, /还没有绑定正式会话/);
    }
  });

  it('rejects /new without args from a draft thread', () => {
    const resolved = _testOnly.resolveNewSessionWorkingDirectory(
      '',
      {
        id: 'binding-1',
        channelType: 'feishu',
        chatId: 'chat-1',
        codepilotSessionId: 'session-1',
        sdkSessionId: '',
        workingDirectory: 'D:\\codex-to-im\\runtime\\draft',
        model: 'test-model',
        mode: 'ask',
        active: true,
        createdAt: '2026-03-25T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
      },
      {
        id: 'session-1',
        name: 'Draft:feishu:chat-1',
        working_directory: 'D:\\codex-to-im\\runtime\\draft',
        model: 'test-model',
        session_type: 'draft',
      },
    );
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.message, /不是正式工作会话/);
    }
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
    assert.equal(_testOnly.normalizeReasoningEffort('0'), null);
    assert.equal(_testOnly.normalizeReasoningEffort('1'), 'minimal');
    assert.equal(_testOnly.normalizeReasoningEffort('2'), 'low');
    assert.equal(_testOnly.normalizeReasoningEffort('3'), 'medium');
    assert.equal(_testOnly.normalizeReasoningEffort('4'), 'high');
    assert.equal(_testOnly.normalizeReasoningEffort('5'), 'xhigh');
    assert.equal(_testOnly.normalizeReasoningEffort('xhigh'), 'xhigh');
    assert.equal(_testOnly.normalizeReasoningEffort('9'), null);
  });
});

describe('bridge-manager status formatting', () => {
  beforeEach(() => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
  });

  it('resolves the displayed model from the most specific available source', () => {
    assert.equal(
      _testOnly.resolveDisplayedModel(
        { model: 'binding-model' } as never,
        { id: 's-1', working_directory: '', model: 'session-model' },
        'configured-model',
        'codex-default',
      ),
      'binding-model',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(
        null,
        { id: 's-1', working_directory: '', model: 'session-model' },
        'configured-model',
        'codex-default',
      ),
      'session-model',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(null, { id: 's-1', working_directory: '', model: '' }, 'configured-model', 'codex-default'),
      'configured-model',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(null, { id: 's-1', working_directory: '', model: '' }, null, 'codex-default'),
      'codex-default',
    );
    assert.equal(
      _testOnly.resolveDisplayedModel(null, { id: 's-1', working_directory: '', model: '' }, null, null),
      'default',
    );
  });

  it('marks CLI-only models in the displayed label when metadata is available', () => {
    assert.equal(_testOnly.formatDisplayedModel('gpt-5.3-codex-spark'), 'gpt-5.3-codex-spark（仅 IM / CLI）');
    assert.equal(_testOnly.formatDisplayedModel('gpt-5.4'), 'gpt-5.4');
  });

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
    const rendered = _testOnly.formatMirrorMessage('Current Thread', 'Desktop answer');

    assert.equal(rendered, '<Current Thread> codex:\n\nDesktop answer');
  });

  it('returns an empty mirror message when there is no text', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', '');

    assert.equal(rendered, '');
  });

  it('formats user mirror messages with the 我 header', () => {
    const rendered = _testOnly.formatMirrorMessageForRole('Current Thread', 'Desktop prompt', 'user');

    assert.equal(rendered, '<Current Thread> 我:\n\nDesktop prompt');
  });

  it('formats markdown mirror headers with bold speaker labels', () => {
    const rendered = _testOnly.formatMirrorMessageForRole('Current Thread', '- item 1\n- item 2', 'assistant', true);

    assert.equal(rendered, '**&lt;Current Thread&gt; codex:**\n\n- item 1\n- item 2');
  });

  it('emits desktop user mirror text as a standalone finalized turn', () => {
    const subscription = {
      pendingTurn: null,
      threadId: 'thread-1',
    } as { pendingTurn: unknown; threadId: string };

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'user-1',
        type: 'message',
        role: 'user',
        content: 'desktop prompt',
        timestamp: '2026-03-25T08:00:00.000Z',
      },
    ]);

    assert.deepEqual(finalized, [
      {
        text: 'desktop prompt',
        signature: 'user-1',
        timestamp: '2026-03-25T08:00:00.000Z',
        status: 'completed',
        role: 'user',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('buffers mirror records until task_complete arrives', () => {
    const subscription = {
      pendingTurn: null,
      threadId: 'thread-1',
    } as { pendingTurn: unknown; threadId: string };

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'commentary',
        type: 'message',
        role: 'commentary',
        content: 'thinking',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant',
        type: 'message',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(finalized, [
      {
        text: 'final answer',
        signature: 'complete',
        timestamp: '2026-03-25T08:00:03.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('accumulates streamed mirror text instead of replacing earlier chunks', () => {
    const subscription = {
      pendingTurn: null,
      threadId: 'thread-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'commentary-1',
        type: 'message',
        role: 'commentary',
        content: 'thinking step 1',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: 'partial answer',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: 'final answer',
        timestamp: '2026-03-25T08:00:03.000Z',
      },
    ]);

    assert.equal(
      subscription.pendingTurn?.streamedText,
      'thinking step 1\n\npartial answer\n\nfinal answer',
    );
  });

  it('keeps tool-only mirror turns finalizable so streaming cards can close cleanly', () => {
    const subscription = {
      pendingTurn: null,
      threadId: 'thread-1',
    } as { pendingTurn: unknown; threadId: string };

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'tool-start',
        type: 'tool_started',
        content: '',
        timestamp: '2026-03-25T08:00:01.000Z',
        toolId: 'call-1',
        toolName: 'shell_command',
      },
      {
        signature: 'tool-finish',
        type: 'tool_finished',
        content: 'Exit code: 0',
        timestamp: '2026-03-25T08:00:02.000Z',
        toolId: 'call-1',
        isError: false,
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(finalized, [
      {
        text: '',
        signature: 'complete',
        timestamp: '2026-03-25T08:00:03.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('drains buffered mirror records after a busy window ends', () => {
    const subscription = {
      pendingTurn: null,
      threadId: 'thread-1',
      bufferedRecords: [
        {
          signature: 'user-1',
          type: 'message',
          role: 'user',
          content: 'desktop prompt',
          timestamp: '2026-03-25T08:00:00.000Z',
        },
      ],
    } as { pendingTurn: unknown; threadId: string; bufferedRecords: unknown[] };

    const finalized = _testOnly.consumeBufferedMirrorTurns(subscription as any);

    assert.deepEqual(finalized, [
      {
        text: 'desktop prompt',
        signature: 'user-1',
        timestamp: '2026-03-25T08:00:00.000Z',
        status: 'completed',
        role: 'user',
      },
    ]);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.equal(subscription.pendingTurn, null);
  });

  it('checks buffered pending turns for timeout even when no new file data arrived', () => {
    const subscription = {
      threadId: 'thread-1',
      bufferedRecords: [],
      pendingTurn: {
        turnId: 'turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        lastAssistantText: 'stale answer',
        lastCommentaryText: null,
        streamedText: 'stale answer',
        streamStarted: false,
        toolCalls: new Map(),
      },
    } as { pendingTurn: unknown; threadId: string; bufferedRecords: unknown[] };

    const finalized = _testOnly.consumeBufferedMirrorTurns(
      subscription as any,
      Date.parse('2026-03-25T08:20:01.000Z'),
    );

    assert.deepEqual(finalized, [
      {
        text: 'stale answer',
        signature: 'timeout:thread-1:turn-1',
        timestamp: '2026-03-25T08:00:00.000Z',
        status: 'interrupted',
      },
    ]);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.equal(subscription.pendingTurn, null);
  });

  it('suppresses IM-originated mirror records while preserving later desktop user input', () => {
    const sessionId = 'session-self-echo';
    _testOnly.beginMirrorSuppression(sessionId, '来自 IM 的问题');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'user-self',
        type: 'message',
        role: 'user',
        content: '来自 IM 的问题',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'user-desktop',
        type: 'message',
        role: 'user',
        content: '来自桌面的新消息',
        timestamp: '2026-03-25T08:00:03.000Z',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:04.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(filtered, [
      {
        signature: 'user-desktop',
        type: 'message',
        role: 'user',
        content: '来自桌面的新消息',
        timestamp: '2026-03-25T08:00:03.000Z',
      },
    ]);
  });

  it('flushes a buffered mirror turn after the idle timeout', () => {
    const subscription = {
      threadId: 'thread-1',
      pendingTurn: {
        turnId: 'turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        lastAssistantText: 'stale answer',
      },
    } as { pendingTurn: unknown; threadId: string };

    const flushed = _testOnly.flushTimedOutMirrorTurn(
      subscription as any,
      Date.parse('2026-03-25T08:20:01.000Z'),
    );

    assert.deepEqual(flushed, {
      text: 'stale answer',
      signature: 'timeout:thread-1:turn-1',
      timestamp: '2026-03-25T08:00:00.000Z',
      status: 'interrupted',
    });
    assert.equal(subscription.pendingTurn, null);
  });
});

describe('channel-router defaults', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('binds new chats to the hidden draft thread by default', () => {
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

    assert.equal(binding.mode, 'ask');
    assert.equal(session?.preferred_mode, 'ask');
    assert.equal(session?.hidden, true);
    assert.equal(session?.session_type, 'draft');
    assert.match(session?.name || '', /^Draft:feishu:chat-default-mode$/);
    assert.ok((session?.working_directory || '').startsWith(path.join(CTI_HOME, 'runtime', 'internal-sessions', 'draft')));
  });
});
