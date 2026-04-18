import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FeishuAdapter } from '../lib/bridge/adapters/feishu-adapter.js';

describe('feishu-adapter structured streaming regions', () => {
  it('creates the streaming card with dedicated content, tools, and status elements', async () => {
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
    assert.equal(elements.length, 3);
    assert.equal(elements[0]?.element_id, 'streaming_content');
    assert.equal(elements[1]?.element_id, 'streaming_tools');
    assert.equal(elements[1]?.content, '');
    assert.equal(elements[2]?.element_id, 'streaming_status');
    assert.equal(elements[2]?.content, '已运行 0s');
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
    adapter.onStreamStatus('chat-1', '已运行 10s，最近 10s 无新输出', 'stream-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(elementUpdates.some((update) =>
      update.path?.element_id === 'streaming_status'
      && update.data?.content === '已运行 10s，最近 10s 无新输出'));
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
    state.pendingStatusText = '已运行 10s，最近 10s 无新输出';

    await (adapter as any).flushCardUpdate('stream-1');

    assert.deepEqual(
      elementUpdates.map((update) => update.path?.element_id),
      ['streaming_tools', 'streaming_status'],
    );
    assert.equal(state.renderedToolsText, '');
    assert.equal(state.renderedStatusText, '已运行 10s，最近 10s 无新输出');
  });
});
