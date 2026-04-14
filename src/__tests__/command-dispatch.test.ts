import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { handleBridgeCommand } from '../lib/bridge/command-dispatch.js';
import * as router from '../lib/bridge/channel-router.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

const noopLlm = {
  streamChat(): ReadableStream<string> {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  },
};

function initTestContext(): JsonFileStore {
  const store = new JsonFileStore(makeSettings());
  initBridgeContext({
    store,
    llm: noopLlm,
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
  return store;
}

describe('command-dispatch', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('switches /thread 0 into the hidden draft session and forces ask mode', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-1' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-draft' } as const;

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/thread 0',
        messageId: 'incoming-1',
      } as any,
      '/thread 0',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );
    const binding = store.getChannelBinding(address.channelType, address.chatId);
    assert.ok(binding);
    assert.equal(binding?.mode, 'ask');
    const session = binding ? store.getSession(binding.codepilotSessionId) : null;
    assert.equal(session?.session_type, 'draft');
    assert.match(sent[0] || '', /已切换到临时草稿线程/);
  });

  it('renders /history from bridge-cached messages when no desktop thread is bound', async () => {
    const store = initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-2' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-history', displayName: 'History Chat' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\history');
    store.addMessage(binding.codepilotSessionId, 'user', '第一条用户消息');
    store.addMessage(binding.codepilotSessionId, 'assistant', '第一条助手回复');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '/history',
        messageId: 'incoming-2',
      } as any,
      '/history',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async () => null,
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const response = sent[0] || '';
    assert.match(response, /最近对话（raw）/);
    assert.match(response, /Bridge 缓存/);
    assert.match(response, /第一条用户消息/);
    assert.match(response, /第一条助手回复/);
  });

  it('renders // health diagnostics for the current session', async () => {
    initTestContext();
    const sent: string[] = [];
    const adapter: any = {
      channelType: 'feishu',
      send: async (message: { text: string }) => {
        sent.push(message.text);
        return { ok: true, messageId: 'reply-3' };
      },
    };
    const address = { channelType: 'feishu', chatId: 'chat-health' } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\health');

    await handleBridgeCommand(
      adapter,
      {
        address,
        text: '//',
        messageId: 'incoming-3',
      } as any,
      '//',
      {
        getActiveTask: () => undefined,
        diagnoseSessionHealth: async (sessionId) => ({
          sessionId,
          runtimeStatus: 'running',
          healthStatus: 'slow_observed',
          healthReason: '最近 10 到 30 分钟内没有新进展，先标记为待观察。',
          lastProgressAt: '2026-04-13T12:00:00.000Z',
          lastProgressType: 'tool_running',
          activeToolName: 'shell_command',
          activeToolStartedAt: '2026-04-13T11:50:00.000Z',
          lastToolFinishedAt: null,
          sdkSessionId: null,
          processProbe: null,
        }),
        diagnoseAllActiveSessions: async () => [],
      },
    );

    const response = sent[0] || '';
    assert.match(response, /当前会话健康检查/);
    assert.match(response, new RegExp(binding.codepilotSessionId));
    assert.match(response, /长时运行，待观察/);
    assert.match(response, /shell_command/);
  });
});
