import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAdapterRuntime } from '../lib/bridge/bridge-adapter-runtime.js';

describe('bridge-adapter-runtime', () => {
  it('routes regular messages through the session lock but keeps slash commands inline', async () => {
    const state = {
      adapters: new Map(),
      adapterMeta: new Map(),
      invalidAdapters: new Map(),
      loopAborts: new Map(),
      running: true,
    };
    const handled: string[] = [];
    const locked: string[] = [];

    const runtime = createAdapterRuntime(() => state, {
      getStore: () => ({ getSetting: () => 'true' }),
      notifyAdapterSetChanged: () => {},
      handleMessage: async (_adapter, msg) => {
        handled.push(msg.text);
      },
      processWithSessionLock: async (sessionId, fn) => {
        locked.push(sessionId);
        await fn();
      },
      isNumericPermissionShortcut: () => false,
      resolveSessionIdForMessage: (msg) => `session:${msg.address.chatId}`,
    });

    let runningRegular = true;
    let regularConsumed = false;
    const regularAdapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => runningRegular || !regularConsumed,
      consumeOne: async () => {
        if (regularConsumed) return null;
        regularConsumed = true;
        runningRegular = false;
        return {
          messageId: 'msg-regular',
          address: { channelType: 'feishu-default', chatId: 'chat-regular' },
          text: 'hello',
          timestamp: Date.now(),
        };
      },
    };

    runtime.runAdapterLoop(regularAdapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(handled, ['hello']);
    assert.deepEqual(locked, ['session:chat-regular']);

    handled.length = 0;
    locked.length = 0;

    let runningCommand = true;
    let commandConsumed = false;
    const commandAdapter = {
      channelType: 'feishu-default',
      provider: 'feishu',
      isRunning: () => runningCommand || !commandConsumed,
      consumeOne: async () => {
        if (commandConsumed) return null;
        commandConsumed = true;
        runningCommand = false;
        return {
          messageId: 'msg-command',
          address: { channelType: 'feishu-default', chatId: 'chat-command' },
          text: '/status',
          timestamp: Date.now(),
        };
      },
    };

    runtime.runAdapterLoop(commandAdapter as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(handled, ['/status']);
    assert.deepEqual(locked, []);
  });
});
