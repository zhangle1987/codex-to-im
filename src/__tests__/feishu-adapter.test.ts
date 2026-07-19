import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FeishuAdapter,
  validateFeishuAttachmentPath,
} from '../lib/bridge/adapters/feishu-adapter.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('feishu-adapter attachments', () => {
  it('rejects missing, non-file, and oversized attachment paths before upload', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-attachment-'));
    const filePath = path.join(tempDir, 'artifact.bin');
    try {
      fs.writeFileSync(filePath, Buffer.alloc(4));
      assert.equal(validateFeishuAttachmentPath(filePath, 4), null);
      assert.match(validateFeishuAttachmentPath(filePath, 3) || '', /too large/);
      assert.match(validateFeishuAttachmentPath(tempDir, 10) || '', /not a regular file/);
      assert.match(validateFeishuAttachmentPath(path.join(tempDir, 'missing'), 10) || '', /not found/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('feishu-adapter structured streaming regions', () => {
  it('does not add typing reactions while starting or ending a stream', async () => {
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const reactionDeleteCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).lastIncomingMessageId.set('chat-1', 'incoming-1');
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return { data: { reaction_id: `reaction-${reactionCreateCalls.length}` } };
          },
          delete: async (payload: Record<string, any>) => {
            reactionDeleteCalls.push(payload);
            return {};
          },
        },
      },
    };

    adapter.onMessageStart('chat-1', 'stream-1');
    adapter.onMessageStart('chat-1', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    adapter.onMessageEnd('chat-1', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(reactionCreateCalls.length, 0);
    assert.equal(reactionDeleteCalls.length, 0);
  });

  it('adds a completed reaction to the finalized streaming card message', async () => {
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardTerminalReactionDelayMs = 0;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');

    assert.equal(finalized, true);
    assert.deepEqual(reactionCreateCalls, [{
      path: { message_id: 'card-message-1' },
      data: { reaction_type: { emoji_type: 'DONE' } },
    }]);
  });

  it('adds an error reaction to the finalized streaming card message on failure', async () => {
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardTerminalReactionDelayMs = 0;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const finalized = await adapter.onStreamEnd('chat-1', 'error', '执行失败', 'stream-1');

    assert.equal(finalized, true);
    assert.deepEqual(reactionCreateCalls, [{
      path: { message_id: 'card-message-1' },
      data: { reaction_type: { emoji_type: 'ERROR' } },
    }]);
  });

  it('retains card state and retries a transient terminal update failure', async () => {
    let settingsCalls = 0;
    let updateCalls = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardFinalizeRetryDelaysMs = [0];
    (adapter as any).cardTerminalReactionDelayMs = 0;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => {
              settingsCalls += 1;
              if (settingsCalls === 1) throw new Error('temporary CardKit failure');
              return {};
            },
            update: async () => {
              updateCalls += 1;
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const firstResult = await adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');

    assert.equal(firstResult, false);
    assert.equal((adapter as any).activeCards.has('stream-1'), true);
    adapter.onMessageEnd('chat-1', 'stream-1');
    assert.equal((adapter as any).activeCards.has('stream-1'), true);

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(settingsCalls, 2);
    assert.equal(updateCalls, 1);
    assert.equal((adapter as any).activeCards.has('stream-1'), false);
    assert.equal((adapter as any).pendingCardFinalizations.has('stream-1'), false);
  });

  it('best-effort finalizes active cards before stopping the Feishu client', async () => {
    const cardUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).running = true;
    (adapter as any).cardTerminalReactionDelayMs = 0;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdates.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    await adapter.stop();

    assert.equal(cardUpdates.length, 1);
    assert.equal((adapter as any).activeCards.size, 0);
    assert.equal((adapter as any).pendingCardFinalizations.size, 0);
    const finalCardJson = String(cardUpdates[0]?.data?.card?.data || '');
    assert.match(finalCardJson, /Interrupted/);
  });

  it('waits briefly after final card update before adding a terminal reaction', async () => {
    const calls: string[] = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardTerminalReactionDelayMs = 20;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => {
              calls.push('card.settings');
              return {};
            },
            update: async () => {
              calls.push('card.update');
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async () => {
            calls.push('reaction');
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const finalized = adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, ['card.settings', 'card.update']);
    assert.equal(await finalized, true);
    assert.deepEqual(calls, ['card.settings', 'card.update', 'reaction']);
  });

  it('creates the streaming card with dedicated content, tasks, tools, and status elements', async () => {
    const createdCards: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async ({ data }: { data: { data: string } }) => {
              const parsed = JSON.parse(data.data);
              createdCards.push(parsed);
              return { data: { card_id: 'card-1' } };
            },
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const created = await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    assert.equal(created, true);

    const elements = createdCards[0]?.body?.elements || [];
    assert.equal(elements.length, 4);
    assert.equal(elements[0]?.element_id, 'streaming_content');
    assert.equal(elements[1]?.element_id, 'streaming_tasks');
    assert.equal(elements[1]?.content, '');
    assert.equal(elements[2]?.element_id, 'streaming_tools');
    assert.equal(elements[2]?.content, '');
    assert.equal(elements[3]?.element_id, 'streaming_status');
    assert.equal(elements[3]?.content, '处理中');
  });

  it('updates the dedicated status element without mutating the main content area', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamStatus('chat-1', '已运行 10秒，上次响应距今 10秒', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_status'
      && update.data?.content === '已运行 10秒，上次响应距今 10秒'));
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_content'
      && update.path?.element_id !== 'streaming_tools'));
  });

  it('periodically refreshes the whole streaming card without sending a new message', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const replyCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardFullRefreshIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async (payload: Record<string, any>) => {
            replyCalls.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.lastFullRefreshAttemptAt = Date.now() - 10;

    adapter.onStreamStatus('chat-1', '已运行 5分，上次响应距今 2分', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(replyCalls.length, 1);
    assert.equal(cardUpdateCalls.length, 1);
    assert.equal(elementUpdates.length, 0);

    const body = JSON.parse(cardUpdateCalls[0]?.data?.card?.data || '{}');
    const elements = body.body?.elements || [];
    assert.equal(body.config?.streaming_mode, true);
    assert.equal(elements[3]?.element_id, 'streaming_status');
    assert.equal(elements[3]?.content, '已运行 5分，上次响应距今 2分');
    assert.equal(state.renderedStatusText, '已运行 5分，上次响应距今 2分');
  });

  it('falls back to element updates when periodic whole-card refresh fails', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardFullRefreshIntervalMs = 1;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              throw new Error('whole-card refresh failed');
            },
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.lastFullRefreshAttemptAt = Date.now() - 10;

    adapter.onStreamStatus('chat-1', '已运行 5分，上次响应距今 2分', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(cardUpdateCalls.length, 1);
    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_status'
      && update.data?.content === '已运行 5分，上次响应距今 2分'));
    assert.equal(state.renderedStatusText, '已运行 5分，上次响应距今 2分');
  });

  it('updates tool calls in the dedicated tools region instead of the main content area', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'shell_command', status: 'running' }], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_tools'
      && String(update.data?.content || '').includes('shell_command')));
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_content'
      && update.path?.element_id !== 'streaming_status'));
  });

  it('updates task progress in the dedicated tasks region instead of the main content area', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onTaskEvent('chat-1', [
      { text: '拆分 bridge manager', status: 'in_progress' },
      { text: '补一期回归测试', status: 'pending' },
    ], 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_tasks'
      && String(update.data?.content || '').includes('拆分 bridge manager')));
    assert.ok(elementUpdates.every((update) =>
      update.path?.element_id !== 'streaming_content'
      && update.path?.element_id !== 'streaming_status'));
  });

  it('continues updating later regions when one element update fails', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              if (payload.path?.element_id === 'streaming_tools') {
                throw new Error('tools failed');
              }
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.toolCalls = [{ id: 'tool-1', name: 'shell_command', status: 'running' }];
    state.pendingStatusText = '已运行 10秒，上次响应距今 10秒';

    await (adapter as any).flushCardUpdate('stream-1');

    assert.deepEqual(
      elementUpdates.map((update) => update.path?.element_id),
      ['streaming_tools', 'streaming_status'],
    );
    assert.equal(state.renderedToolsText, '');
    assert.equal(state.renderedStatusText, '已运行 10秒，上次响应距今 10秒');
  });

  it('releases the flush queue after a timed-out update so later refreshes can continue', async () => {
    const elementUpdates: Array<Record<string, any>> = [];
    const blocked = createDeferred<Record<string, any>>();
    let callCount = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async (payload: Record<string, any>) => {
              elementUpdates.push(payload);
              callCount += 1;
              if (callCount === 1) {
                return blocked.promise;
              }
              return {};
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onStreamText('chat-1', '第一段输出', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    adapter.onStreamStatus('chat-1', '已运行 0分20秒', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const state = (adapter as any).activeCards.get('stream-1');
    assert.equal(Boolean(state.flushInFlight), false);
    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_status'
      && update.data?.content === '已运行 0分20秒'));
    assert.equal(state.lastFlushError, null);
    assert.equal(state.consecutiveFlushFailures, 0);

    blocked.resolve({});
  });

  it('finalizes a streaming card instead of hanging behind a stuck flush', async () => {
    const blocked = createDeferred<Record<string, any>>();
    const cardSettingsCalls: Array<Record<string, any>> = [];
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).cardFinalizeFlushWaitExtraMs = 5;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async (payload: Record<string, any>) => {
              cardSettingsCalls.push(payload);
              return {};
            },
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const state = (adapter as any).activeCards.get('stream-1');
    state.flushInFlight = blocked.promise;
    state.flushQueued = true;

    const finalized = await adapter.onStreamEnd('chat-1', 'interrupted', '用户执行 /stop，已停止当前任务。', 'stream-1');

    assert.equal(finalized, true);
    assert.equal(cardSettingsCalls.length, 1);
    assert.equal(cardUpdateCalls.length, 1);
    assert.equal((adapter as any).activeCards.has('stream-1'), false);

    blocked.resolve({});
  });

  it('renders final cards without waiting tasks or running tools after completion', async () => {
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    adapter.onTaskEvent('chat-1', [
      { text: '读取日志', status: 'completed' },
      { text: '补测试', status: 'pending' },
    ], 'stream-1');
    adapter.onToolEvent('chat-1', [
      { id: 'tool-1', name: 'shell_command', status: 'running' },
    ], 'stream-1');

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '最终回复', 'stream-1');
    const finalCardJson = String(cardUpdateCalls[0]?.data?.card?.data || '');
    const finalCard = JSON.parse(finalCardJson);

    assert.equal(finalized, true);
    assert.equal(finalCard.config?.streaming_mode, false);
    assert.match(finalCard.config?.summary?.content || '', /^已完成/);
    assert.doesNotMatch(finalCardJson, /等待中|运行中/);
    assert.match(finalCardJson, /补测试（已结束）/);
    assert.match(finalCardJson, /`shell_command`/);
  });

  it('keeps long final responses out of the terminal card and lets delivery send the full text', async () => {
    const cardUpdateCalls: Array<Record<string, any>> = [];
    const reactionCreateCalls: Array<Record<string, any>> = [];
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });
    (adapter as any).cardTerminalReactionDelayMs = 0;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card-1' } }),
            settings: async () => ({}),
            update: async (payload: Record<string, any>) => {
              cardUpdateCalls.push(payload);
              return {};
            },
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'card-message-1' } }),
        },
        messageReaction: {
          create: async (payload: Record<string, any>) => {
            reactionCreateCalls.push(payload);
            return {};
          },
        },
      },
    };

    await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    const longText = `${'长回复正文'.repeat(2500)}\nTAIL_MARKER_SHOULD_NOT_BE_IN_CARD`;
    const finalized = await adapter.onStreamEnd('chat-1', 'completed', longText, 'stream-1');
    const finalCard = JSON.parse(String(cardUpdateCalls[0]?.data?.card?.data || '{}'));
    const cardText = String(finalCard.body?.elements?.[0]?.content || '');

    assert.equal(finalized, false);
    assert.equal(finalCard.config?.streaming_mode, false);
    assert.match(finalCard.config?.summary?.content || '', /^已完成/);
    assert.match(cardText, /完整内容将继续以普通消息发送/);
    assert.doesNotMatch(cardText, /TAIL_MARKER_SHOULD_NOT_BE_IN_CARD/);
    assert.ok(cardText.length < longText.length);
    assert.deepEqual(reactionCreateCalls, [{
      path: { message_id: 'card-message-1' },
      data: { reaction_type: { emoji_type: 'DONE' } },
    }]);
  });

  it('releases a timed-out card creation attempt so a later retry can recreate the stream card', async () => {
    const blocked = createDeferred<Record<string, any>>();
    let createCallCount = 0;
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              createCallCount += 1;
              if (createCallCount === 1) {
                return blocked.promise;
              }
              return { data: { card_id: `card-${createCallCount}` } };
            },
            settings: async () => ({}),
            update: async () => ({}),
          },
          cardElement: {
            content: async () => ({}),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'msg-1' } }),
          reply: async () => ({ data: { message_id: 'msg-1' } }),
        },
      },
    };

    const first = await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    assert.equal(first, false);
    assert.equal((adapter as any).cardCreatePromises.size, 0);

    const second = await (adapter as any).createStreamingCard('chat-1', 'reply-1', 'stream-1');
    assert.equal(second, true);
    assert.equal(createCallCount, 2);
    assert.equal((adapter as any).activeCards.has('stream-1'), true);

    blocked.resolve({});
  });

  it('returns an error instead of hanging forever when plain text sending times out', async () => {
    const blocked = createDeferred<Record<string, any>>();
    const adapter = new FeishuAdapter({
      id: 'feishu-default',
      provider: 'feishu',
      enabled: true,
      alias: '飞书',
      config: {
        appId: 'app-id',
        appSecret: 'app-secret',
        streamingEnabled: true,
      },
    });

    (adapter as any).cardRequestTimeoutMs = 5;
    (adapter as any).restClient = {
      im: {
        message: {
          create: async () => blocked.promise,
        },
      },
    };

    const result = await (adapter as any).sendAsPlainText('chat-1', 'hello');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /timeout/i);

    blocked.resolve({});
  });
});
