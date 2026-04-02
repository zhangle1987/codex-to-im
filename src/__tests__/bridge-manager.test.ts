import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { _testOnly, start } from '../lib/bridge/bridge-manager.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../lib/bridge/channel-adapter.js';
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

class InvalidConfigAdapter extends BaseChannelAdapter {
  readonly channelType: string;
  readonly provider: string;

  constructor(instance?: { id?: string; provider?: string; alias?: string }) {
    super();
    this.channelType = instance?.id || 'invalid';
    this.provider = instance?.provider || 'invalid';
    Object.defineProperty(this, 'alias', {
      value: instance?.alias,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return false; }
  async consumeOne() { return null; }
  async send() { return { ok: true, messageId: 'dummy' }; }
  validateConfig(): string | null { return 'invalid config'; }
  isAuthorized(): boolean { return true; }
}

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

  it('renders desktop thread list titles with the actual displayed count', () => {
    const response = _testOnly.buildDesktopThreadsCommandResponse(
      [
        {
          threadId: 'thread-1',
          filePath: 'D:\\codex\\sessions\\1.jsonl',
          cwd: 'D:\\workspace\\project-a',
          originator: 'Codex Desktop',
          firstSeenAt: '2026-03-31T00:00:00.000Z',
          lastEventAt: '2026-03-31T00:00:00.000Z',
          title: 'Project A',
          activeEstimate: false,
        },
        {
          threadId: 'thread-2',
          filePath: 'D:\\codex\\sessions\\2.jsonl',
          cwd: 'D:\\workspace\\project-b',
          originator: 'Codex Desktop',
          firstSeenAt: '2026-03-31T00:00:00.000Z',
          lastEventAt: '2026-03-31T00:00:00.000Z',
          title: 'Project B',
          activeEstimate: false,
        },
      ],
      false,
      false,
      10,
    );
    assert.match(response, /^最近 2 条桌面会话/);
  });

  it('renders all-thread list titles with the actual displayed count', () => {
    const response = _testOnly.buildDesktopThreadsCommandResponse(
      [
        {
          threadId: 'thread-1',
          filePath: 'D:\\codex\\sessions\\1.jsonl',
          cwd: 'D:\\workspace\\project-a',
          originator: 'Codex Desktop',
          firstSeenAt: '2026-03-31T00:00:00.000Z',
          lastEventAt: '2026-03-31T00:00:00.000Z',
          title: 'Project A',
          activeEstimate: false,
        },
      ],
      false,
      true,
      200,
    );
    assert.match(response, /^桌面会话（当前显示 1 条，最多 200 条）/);
  });

  it('maps short session and history aliases', () => {
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

  it('builds distinct stream keys for separate IM turns in the same session', () => {
    const first = _testOnly.buildInteractiveStreamKey('session-1', 'msg-1');
    const second = _testOnly.buildInteractiveStreamKey('session-1', 'msg-2');
    assert.notEqual(first, second);
    assert.equal(first, 'im:session-1:msg-1');
  });

  it('builds stable mirror stream keys from session and turn identity', () => {
    const withTurnId = _testOnly.buildMirrorStreamKey('session-1', 'turn-1', '2026-03-27T10:00:00.000Z');
    const fallback = _testOnly.buildMirrorStreamKey('session-1', null, '2026-03-27T10:00:00.000Z');
    assert.equal(withTurnId, 'mirror:session-1:turn-1');
    assert.equal(fallback, 'mirror:session-1:2026-03-27T10:00:00.000Z');
  });

  it('changes adapter config fingerprint when alias or config changes', () => {
    const base = _testOnly.buildAdapterConfigFingerprint({
      id: 'feishu-main',
      provider: 'feishu',
      alias: '主飞书',
      enabled: true,
      config: {
        appId: 'app-id',
        appSecret: 'secret',
        site: 'feishu',
        allowedUsers: ['u1'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
      },
    });
    const changedAlias = _testOnly.buildAdapterConfigFingerprint({
      id: 'feishu-main',
      provider: 'feishu',
      alias: '备份飞书',
      enabled: true,
      config: {
        appId: 'app-id',
        appSecret: 'secret',
        site: 'feishu',
        allowedUsers: ['u1'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
      },
    });
    const changedConfig = _testOnly.buildAdapterConfigFingerprint({
      id: 'feishu-main',
      provider: 'feishu',
      alias: '主飞书',
      enabled: true,
      config: {
        appId: 'app-id',
        appSecret: 'secret',
        site: 'lark',
        allowedUsers: ['u1'],
        streamingEnabled: true,
        feedbackMarkdownEnabled: true,
      },
    });
    assert.notEqual(base, changedAlias);
    assert.notEqual(base, changedConfig);
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
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
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

    assert.equal(rendered, '**`<Current Thread>`**\n\n**我:** Desktop prompt\n\n**codex:**\n- item 1\n- item 2');
  });

  it('buffers desktop user mirror text into the active turn instead of finalizing immediately', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
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
      streamKey: 'mirror:session-1:2026-03-25T08:00:00.000Z',
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
      sessionId: 'session-1',
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
        streamKey: 'mirror:session-1:turn-1',
        userText: 'desktop prompt',
        text: 'final answer',
        signature: 'complete',
        timestamp: '2026-03-25T08:00:03.000Z',
        status: 'completed',
      },
    ]);
    assert.equal(subscription.pendingTurn, null);
  });

  it('keeps the original mirror stream key when turnId arrives after streaming has started', () => {
    const subscription = {
      pendingTurn: null,
      sessionId: 'session-1',
      threadId: 'thread-1',
    } as { pendingTurn: any; threadId: string };

    _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'user',
        type: 'message',
        role: 'user',
        content: 'desktop prompt',
        timestamp: '2026-03-25T08:00:00.000Z',
      },
    ]);

    assert.equal(subscription.pendingTurn?.streamKey, 'mirror:session-1:2026-03-25T08:00:00.000Z');

    const finalized = _testOnly.consumeMirrorRecords(subscription as any, [
      {
        signature: 'start',
        type: 'task_started',
        content: '',
        timestamp: '2026-03-25T08:00:00.500Z',
        turnId: 'turn-1',
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
        streamKey: 'mirror:session-1:2026-03-25T08:00:00.000Z',
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
      sessionId: 'session-1',
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
      sessionId: 'session-1',
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
        streamKey: 'mirror:session-1:turn-1',
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
      sessionId: 'session-1',
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
      streamKey: 'mirror:session-1:2026-03-25T08:00:00.000Z',
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
      sessionId: 'session-1',
      threadId: 'thread-1',
      bufferedRecords: [],
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
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
      Date.parse('2026-03-25T08:10:01.000Z'),
    );

    assert.deepEqual(finalized, [
      {
        streamKey: 'mirror:session-1:turn-1',
        userText: null,
        text: 'stale answer',
        signature: 'timeout:thread-1:turn-1',
        timestamp: '2026-03-25T08:00:00.000Z',
        status: 'interrupted',
        timedOut: true,
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
      sessionId: 'session-1',
      threadId: 'thread-1',
      pendingTurn: {
        turnId: 'turn-1',
        streamKey: 'mirror:session-1:turn-1',
        startedAt: '2026-03-25T08:00:00.000Z',
        lastActivityAt: '2026-03-25T08:00:00.000Z',
        userText: null,
        lastAssistantText: 'stale answer',
      },
    } as { pendingTurn: unknown; threadId: string };

    const flushed = _testOnly.flushTimedOutMirrorTurn(
      subscription as any,
      Date.parse('2026-03-25T08:10:01.000Z'),
    );

    assert.deepEqual(flushed, {
      streamKey: 'mirror:session-1:turn-1',
      userText: null,
      text: 'stale answer',
      signature: 'timeout:thread-1:turn-1',
      timestamp: '2026-03-25T08:00:00.000Z',
      status: 'interrupted',
      timedOut: true,
    });
    assert.equal(subscription.pendingTurn, null);
  });

  it('appends a timeout notice after the mirror content', () => {
    const rendered = _testOnly.formatMirrorMessage('Current Thread', 'Desktop prompt', 'stale answer', true);
    const withNotice = _testOnly.appendMirrorTimeoutNotice(rendered, true);

    assert.equal(
      withNotice,
      '**`<Current Thread>`**\n\n**我:** Desktop prompt\n\n**codex:** stale answer\n\n> 超时提醒：长时间没有收到新的桌面会话输出，本次流式同步已先结束；如果桌面后续继续产出内容，会重新开始新一轮同步。',
    );
  });
});

describe('bridge-manager stop handling', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('aborts the active IM task only when /stop is received', async () => {
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'msg-stop' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-stop' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\stop');

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const abortController = new AbortController();
    state.activeTasks.set(binding.codepilotSessionId, {
      id: 'task-stop',
      abortController,
      adapter,
      address,
      streamKey: 'stream-stop',
      sessionId: binding.codepilotSessionId,
      hasStreamingCards: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'incoming-stop',
      address,
      text: '/stop',
      timestamp: Date.now(),
    });

    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(sent, ['正在停止当前任务...']);
  });
});

describe('bridge-manager startup runtime cleanup', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('resets persisted running and queued sessions back to idle on startup', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const session = store.createSession('Desktop: stale', '', undefined, 'D:\\workspace\\stale', 'code');
    store.updateSession(session.id, {
      runtime_status: 'running',
      queued_count: 2,
      last_runtime_update_at: '2026-04-01T00:00:00.000Z',
    });

    await start();

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.runtime_status, 'idle');
    assert.equal(refreshed?.queued_count || 0, 0);
  });
});

describe('bridge-manager mirror subscription recovery', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('clears dangling sdk session ids after repeated missing desktop thread lookups', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu-default', chatId: 'chat-dangling' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\dangling');
    store.updateSdkSessionId(binding.codepilotSessionId, 'missing-thread-id');

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => false,
    });

    await _testOnly.reconcileMirrorSubscriptions();
    await _testOnly.reconcileMirrorSubscriptions();

    assert.equal(store.getSession(binding.codepilotSessionId)?.sdk_session_id, 'missing-thread-id');
    assert.equal(store.getChannelBinding(address.channelType, address.chatId)?.sdkSessionId, 'missing-thread-id');

    await _testOnly.reconcileMirrorSubscriptions();

    assert.equal(store.getSession(binding.codepilotSessionId)?.sdk_session_id || '', '');
    assert.equal(store.getChannelBinding(address.channelType, address.chatId)?.sdkSessionId || '', '');
    assert.equal(state.mirrorSubscriptions.size, 0);
  });

  it('does not reject mirror reconcile when mirror session state persistence fails', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu-default', chatId: 'chat-sync-failure' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\sync-failure');
    store.updateSdkSessionId(binding.codepilotSessionId, 'missing-thread-id');

    const originalUpdateSession = store.updateSession.bind(store);
    (store as unknown as { updateSession: typeof store.updateSession }).updateSession = (() => {
      throw {};
    }) as typeof store.updateSession;

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    state.running = true;
    state.adapters.set(address.channelType, {
      channelType: address.channelType,
      provider: 'feishu',
      isRunning: () => false,
    });

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await assert.doesNotReject(_testOnly.reconcileMirrorSubscriptions());
    } finally {
      console.error = originalError;
      (store as unknown as { updateSession: typeof store.updateSession }).updateSession = originalUpdateSession;
    }

    assert.ok(errors.some((line) => line.includes('Failed to sync mirror session state')));
  });
});

describe('bridge-manager invalid adapter logging', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    registerAdapterFactory('invalid-test', (instance) => new InvalidConfigAdapter(instance as any));
    _testOnly.resetStateForTests();
  });

  it('logs unchanged invalid adapter configs only once', async () => {
    const settings = makeSettings();
    settings.set('bridge_channel_instances_json', JSON.stringify([
      {
        id: 'invalid-test-main',
        provider: 'invalid-test',
        alias: 'Invalid Test',
        enabled: true,
        config: {},
      },
    ]));

    const store = new JsonFileStore(settings);
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
      await _testOnly.syncConfiguredAdapters({ startLoops: false });
    } finally {
      console.warn = originalWarn;
    }

    const matching = warnings.filter((line) => line.includes('invalid-test-main adapter not valid'));
    assert.equal(matching.length, 1);
  });
});

describe('bridge-manager idle reminder handling', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('sends a 10-minute idle reminder without aborting the active IM task', async () => {
    const sent: Array<{ text: string; replyToMessageId?: string }> = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string; replyToMessageId?: string }) => {
        sent.push({ text: message.text, replyToMessageId: message.replyToMessageId });
        return { ok: true, messageId: 'msg-reminder' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-reminder' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\reminder');

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const abortController = new AbortController();
    state.activeTasks.set(binding.codepilotSessionId, {
      id: 'task-reminder',
      abortController,
      adapter,
      address,
      requestMessageId: 'incoming-reminder',
      streamKey: 'stream-reminder',
      sessionId: binding.codepilotSessionId,
      hasStreamingCards: false,
      lastActivityAt: Date.now() - (10 * 60 * 1000) - 1,
      idleReminderSent: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await _testOnly.reconcileIdleInteractiveTasks();
    await _testOnly.reconcileIdleInteractiveTasks();

    assert.equal(abortController.signal.aborted, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /超过 10 分钟没有新的执行输出/);
    assert.equal(sent[0].replyToMessageId, 'incoming-reminder');
    assert.equal(state.activeTasks.get(binding.codepilotSessionId)?.id, 'task-reminder');
    assert.equal(state.activeTasks.get(binding.codepilotSessionId)?.idleReminderSent, true);
  });
});

describe('bridge-manager new session handling', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();
  });

  it('keeps the current task running when /new creates another IM session', async () => {
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'msg-new' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-new' } as const;
    const oldWorkDir = path.join(os.tmpdir(), 'cti-old-session');
    const newWorkDir = path.join(os.tmpdir(), 'cti-new-session');
    const binding = router.createBinding(address, oldWorkDir);

    const state = (globalThis as unknown as Record<string, any>).__bridge_manager__;
    const abortController = new AbortController();
    state.activeTasks.set(binding.codepilotSessionId, {
      id: 'task-old',
      abortController,
      adapter,
      address,
      requestMessageId: 'incoming-old',
      streamKey: 'stream-old',
      sessionId: binding.codepilotSessionId,
      hasStreamingCards: false,
      lastActivityAt: Date.now(),
      idleReminderSent: false,
      streamFinalized: false,
      uiEnded: false,
      mirrorSuppressionId: null,
    });

    await _testOnly.handleMessage(adapter, {
      messageId: 'incoming-new',
      address,
      text: `/new ${newWorkDir}`,
      timestamp: Date.now(),
    });

    const updatedBinding = router.resolve(address);
    assert.equal(abortController.signal.aborted, false);
    assert.notEqual(updatedBinding.codepilotSessionId, binding.codepilotSessionId);
    assert.equal(state.activeTasks.get(binding.codepilotSessionId)?.id, 'task-old');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /旧任务在运行，它不会被终止/);
  });

  it('does not write an old task sdk session id back onto the current binding after /new', () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: noopLlm,
      permissions: noopPermissions,
      lifecycle: noopLifecycle,
    });
    _testOnly.resetStateForTests();

    const address = { channelType: 'feishu', chatId: 'chat-new-binding' } as const;
    const oldBinding = router.createBinding(address, path.join(os.tmpdir(), 'cti-old-binding'));
    const oldSessionId = oldBinding.codepilotSessionId;

    const newBinding = router.createBinding(address, path.join(os.tmpdir(), 'cti-new-binding'));
    const newSessionId = newBinding.codepilotSessionId;

    assert.equal(newBinding.id, oldBinding.id);
    assert.notEqual(newSessionId, oldSessionId);

    _testOnly.persistSdkSessionUpdate(oldSessionId, 'thread-old', false);

    const currentBinding = store.getChannelBinding(address.channelType, address.chatId);
    assert.equal(store.getSession(oldSessionId)?.sdk_session_id, 'thread-old');
    assert.equal(store.getSession(newSessionId)?.sdk_session_id || '', '');
    assert.equal(currentBinding?.codepilotSessionId, newSessionId);
    assert.equal(currentBinding?.sdkSessionId || '', '');
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
