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
    assert.equal(_testOnly.resolveCommandAlias('/t', 'all'), '/threads');
    assert.equal(_testOnly.resolveCommandAlias('/t', 'n 10'), '/threads');
    assert.equal(_testOnly.resolveCommandAlias('/t', '1'), '/thread');
  });

  it('caps desktop thread list requests at 200 items', () => {
    assert.deepEqual(_testOnly.parseDesktopThreadListArgs(''), { showAll: false, limit: 10 });
    assert.deepEqual(_testOnly.parseDesktopThreadListArgs('all'), { showAll: true, limit: 200 });
    assert.deepEqual(_testOnly.parseDesktopThreadListArgs('n 100'), { showAll: false, limit: 100 });
    assert.deepEqual(_testOnly.parseDesktopThreadListArgs('n 500'), { showAll: false, limit: 200 });
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

  it('surfaces binding conflict errors to the user', () => {
    const message = _testOnly.toUserVisibleBindingError(
      new Error('该会话已绑定到飞书聊天 oc_xxx。一个会话只能绑定一个聊天。'),
      '切换失败。',
    );
    assert.equal(message, '该会话已绑定到飞书聊天 oc_xxx。一个会话只能绑定一个聊天。');
  });

  it('falls back to the default binding error message for unknown failures', () => {
    const message = _testOnly.toUserVisibleBindingError('boom', '切换失败。');
    assert.equal(message, '切换失败。');
  });

  it('formats chat labels with display names when available', () => {
    const label = _testOnly.formatBindingChatLabel({
      channelType: 'feishu',
      chatId: 'oc_xxx',
      chatDisplayName: '张乐',
    } as never);
    assert.equal(label, '飞书 聊天 张乐');
  });

  it('maps unexpected /history failures to a user-visible hint', () => {
    const message = _testOnly.toUserVisibleCommandError('/history', new Error('boom'));
    assert.equal(message, '整理历史失败，请稍后重试；也可以发送 /history raw 查看原始记录。');
  });

  it('falls back to a generic user-visible error for other commands', () => {
    const message = _testOnly.toUserVisibleCommandError('/model', new Error('boom'));
    assert.equal(message, '/model 执行失败，请稍后重试。');
  });

  it('suppresses an IM-triggered mirror turn until task_complete', () => {
    const sessionId = 'session-suppress-turn';
    _testOnly.beginMirrorSuppression(sessionId, '整理一下readme ，主要以功能说明为主，不需要把修改的内容都写进去。');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'message',
        role: 'user',
        content: '整理一下readme ，主要以功能说明为主，不需要把修改的内容都写进去。',
        signature: 'sig-user',
        timestamp: '2026-03-26T06:25:26.708Z',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'README 已经整理成以功能说明为主的版本了。',
        signature: 'sig-assistant',
        timestamp: '2026-03-26T06:25:40.000Z',
      },
      {
        type: 'task_complete',
        role: 'assistant',
        content: 'README 已经整理成以功能说明为主的版本了。',
        signature: 'sig-complete',
        timestamp: '2026-03-26T06:33:19.604Z',
      },
    ] as never);

    assert.deepEqual(filtered, []);
  });

  it('releases mirror suppression after task_complete', () => {
    const sessionId = 'session-suppress-release';
    _testOnly.beginMirrorSuppression(sessionId, 'hello');
    _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        type: 'message',
        role: 'user',
        content: 'hello',
        signature: 'sig-user',
        timestamp: '2026-03-26T06:25:26.708Z',
      },
      {
        type: 'task_complete',
        role: 'assistant',
        content: 'done',
        signature: 'sig-complete',
        timestamp: '2026-03-26T06:33:19.604Z',
      },
    ] as never);

    const laterRecord = {
      type: 'message',
      role: 'user',
      content: '桌面后续新消息',
      signature: 'sig-later',
      timestamp: '2026-03-26T06:40:00.000Z',
    };
    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [laterRecord] as never);
    assert.deepEqual(filtered, [laterRecord]);
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
    const rendered = _testOnly.formatMirrorMessage('Current Thread', 'Desktop prompt', 'Desktop answer');

    assert.equal(rendered, '<Current Thread>\n\n我: Desktop prompt\n\ncodex: Desktop answer');
  });

  it('returns an empty mirror message when there is no text', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', '', '');

    assert.equal(rendered, '');
  });

  it('formats markdown mirror headers with a combined user and codex layout', () => {
    const rendered = _testOnly.formatMirrorMessage(
      'Current Thread',
      'Desktop prompt',
      '- item 1\n- item 2',
      true,
    );

    assert.equal(rendered, '**&lt;Current Thread&gt;**\n\n**我:** Desktop prompt\n\n**codex:**\n- item 1\n- item 2');
  });

  it('buffers desktop user mirror text into the active turn instead of finalizing immediately', () => {
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

    assert.deepEqual(finalized, []);
    assert.deepEqual(subscription.pendingTurn, {
      turnId: null,
      startedAt: '2026-03-25T08:00:00.000Z',
      lastActivityAt: '2026-03-25T08:00:00.000Z',
      userText: 'desktop prompt',
      lastAssistantText: null,
      lastCommentaryText: null,
      streamedText: '',
      streamStarted: false,
      toolCalls: new Map(),
    });
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
        signature: 'user',
        type: 'message',
        role: 'user',
        content: 'desktop prompt',
        timestamp: '2026-03-25T08:00:00.500Z',
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
        userText: 'desktop prompt',
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
        userText: null,
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

    const finalized = _testOnly.consumeBufferedMirrorTurns(
      subscription as any,
      Date.parse('2026-03-25T08:00:30.000Z'),
    );

    assert.deepEqual(finalized, []);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.deepEqual(subscription.pendingTurn, {
      turnId: null,
      startedAt: '2026-03-25T08:00:00.000Z',
      lastActivityAt: '2026-03-25T08:00:00.000Z',
      userText: 'desktop prompt',
      lastAssistantText: null,
      lastCommentaryText: null,
      streamedText: '',
      streamStarted: false,
      toolCalls: new Map(),
    });
  });

  it('checks buffered pending turns for timeout even when no new file data arrived', () => {
    const subscription = {
      threadId: 'thread-1',
      bufferedRecords: [],
      pendingTurn: {
        turnId: 'turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        userText: null,
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
        userText: null,
        text: 'stale answer',
        signature: 'timeout:thread-1:turn-1',
        timestamp: '2026-03-25T08:00:00.000Z',
        status: 'interrupted',
      },
    ]);
    assert.deepEqual(subscription.bufferedRecords, []);
    assert.equal(subscription.pendingTurn, null);
  });

  it('suppresses all mirror records from an IM-originated turn until task_complete', () => {
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
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'desktop-commentary',
        type: 'message',
        role: 'commentary',
        content: '桌面旧任务还在继续思考',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'desktop-turn',
      },
      {
        signature: 'desktop-complete',
        type: 'task_complete',
        role: 'assistant',
        content: '桌面旧任务完成',
        timestamp: '2026-03-25T08:00:03.500Z',
        turnId: 'desktop-turn',
      },
      {
        signature: 'assistant-self-final',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的最终回复',
        timestamp: '2026-03-25T08:00:03.800Z',
        turnId: 'turn-1',
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
        signature: 'desktop-commentary',
        type: 'message',
        role: 'commentary',
        content: '桌面旧任务还在继续思考',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'desktop-turn',
      },
      {
        signature: 'desktop-complete',
        type: 'task_complete',
        role: 'assistant',
        content: '桌面旧任务完成',
        timestamp: '2026-03-25T08:00:03.500Z',
        turnId: 'desktop-turn',
      },
    ]);
  });

  it('releases later desktop mirror records after the IM-originated turn completes', () => {
    const sessionId = 'session-self-echo-next-batch';
    _testOnly.beginMirrorSuppression(sessionId, '来自 IM 的问题');

    const suppressed = _testOnly.filterSuppressedMirrorRecords(sessionId, [
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
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '来自 IM 的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
        turnId: 'turn-1',
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

    const released = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'user-desktop',
        type: 'message',
        role: 'user',
        content: '来自桌面的新消息',
        timestamp: '2026-03-25T08:00:05.000Z',
      },
      {
        signature: 'assistant-desktop',
        type: 'message',
        role: 'assistant',
        content: '来自桌面的回复',
        timestamp: '2026-03-25T08:00:05.500Z',
      },
    ]);

    assert.deepEqual(suppressed, []);
    assert.deepEqual(released, [
      {
        signature: 'user-desktop',
        type: 'message',
        role: 'user',
        content: '来自桌面的新消息',
        timestamp: '2026-03-25T08:00:05.000Z',
      },
      {
        signature: 'assistant-desktop',
        type: 'message',
        role: 'assistant',
        content: '来自桌面的回复',
        timestamp: '2026-03-25T08:00:05.500Z',
      },
    ]);
  });

  it('normalizes unicode punctuation when suppressing IM-originated mirror prompts', () => {
    const sessionId = 'session-unicode-punctuation';
    _testOnly.beginMirrorSuppression(sessionId, '整理一下readme ,主要以功能说明为主,不需要把修改的内容都写进去。');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'user-self',
        type: 'message',
        role: 'user',
        content: '整理一下readme ，主要以功能说明为主，不需要把修改的内容都写进去。',
        timestamp: '2026-03-25T08:00:01.000Z',
      },
      {
        signature: 'assistant-self',
        type: 'message',
        role: 'assistant',
        content: '这是 IM 自己那轮的回复',
        timestamp: '2026-03-25T08:00:02.000Z',
      },
      {
        signature: 'complete',
        type: 'task_complete',
        role: 'assistant',
        content: '这是 IM 自己那轮的回复',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(filtered, []);
  });

  it('supports multiple queued IM suppressions without leaking a delayed earlier completion', () => {
    const sessionId = 'session-queued-suppressions';
    _testOnly.beginMirrorSuppression(sessionId, '第一条 IM 消息');
    _testOnly.beginMirrorSuppression(sessionId, '第二条 IM 消息');

    const filtered = _testOnly.filterSuppressedMirrorRecords(sessionId, [
      {
        signature: 'start-1',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'user-1',
        type: 'message',
        role: 'user',
        content: '第一条 IM 消息',
        timestamp: '2026-03-25T08:00:01.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'assistant-1',
        type: 'message',
        role: 'assistant',
        content: '第一条回复',
        timestamp: '2026-03-25T08:00:02.000Z',
        turnId: 'turn-1',
      },
      {
        signature: 'start-2',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:03.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'user-2',
        type: 'message',
        role: 'user',
        content: '第二条 IM 消息',
        timestamp: '2026-03-25T08:00:04.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'assistant-2',
        type: 'message',
        role: 'assistant',
        content: '第二条回复',
        timestamp: '2026-03-25T08:00:05.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'complete-2',
        type: 'task_complete',
        role: 'assistant',
        content: '第二条回复',
        timestamp: '2026-03-25T08:00:06.000Z',
        turnId: 'turn-2',
      },
      {
        signature: 'complete-1',
        type: 'task_complete',
        role: 'assistant',
        content: '第一条回复',
        timestamp: '2026-03-25T08:00:07.000Z',
        turnId: 'turn-1',
      },
    ]);

    assert.deepEqual(filtered, []);
  });

  it('flushes a buffered mirror turn after the idle timeout', () => {
    const subscription = {
      threadId: 'thread-1',
      pendingTurn: {
        turnId: 'turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        userText: null,
        lastAssistantText: 'stale answer',
      },
    } as { pendingTurn: unknown; threadId: string };

    const flushed = _testOnly.flushTimedOutMirrorTurn(
      subscription as any,
      Date.parse('2026-03-25T08:20:01.000Z'),
    );

    assert.deepEqual(flushed, {
      userText: null,
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
