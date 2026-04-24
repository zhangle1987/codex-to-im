import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FeishuAdapter } from '../lib/bridge/adapters/feishu-adapter.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('feishu-adapter structured streaming regions', () => {
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
