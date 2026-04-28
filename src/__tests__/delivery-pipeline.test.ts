import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BaseChannelAdapter } from '../lib/bridge/channel-adapter.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import {
  deliverFinalResponse,
  finalizeStreamingUi,
} from '../lib/bridge/turns/delivery-pipeline.js';
import { assembleSdkFinalResponse } from '../lib/bridge/turns/response-assembler.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../lib/bridge/types.js';

class FakeAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';
  readonly streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string; streamKey?: string }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  async send(_message: OutboundMessage): Promise<SendResult> { return { ok: true }; }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  async onStreamEnd(
    _chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    streamKey?: string,
  ): Promise<boolean> {
    this.streamEnds.push({ status, text: responseText, streamKey });
    return true;
  }
}

describe('delivery-pipeline', () => {
  beforeEach(() => {
    initBridgeContext({
      store: {
        getSetting: () => null,
      } as never,
      llm: {} as never,
      permissions: {} as never,
      lifecycle: {},
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  it('skips text after card finalization but still delivers attachments', async () => {
    const adapter = new FakeAdapter();
    const calls: Array<{ text: string; attachmentCount: number }> = [];
    const response = assembleSdkFinalResponse({
      text: '正文',
      attachments: [{ kind: 'image', path: 'D:\\work\\out.png' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverResponse: async (_adapter, _address, text, _sessionId, _replyTo, attachments = []) => {
        calls.push({ text, attachmentCount: attachments.length });
        return { ok: true };
      },
    }, response, { skipText: true });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ text: '', attachmentCount: 1 }]);
  });

  it('uses a custom text delivery path before sending attachments', async () => {
    const adapter = new FakeAdapter();
    const calls: string[] = [];
    const response = assembleSdkFinalResponse({
      text: '镜像正文',
      attachments: [{ kind: 'file', path: 'D:\\work\\report.pdf' }],
    });

    const result = await deliverFinalResponse({
      adapter,
      address: { channelType: 'feishu-default', chatId: 'chat-1' },
      sessionId: 'session-1',
      deliverText: async (text) => {
        calls.push(`text:${text}`);
        return { ok: true };
      },
      deliverResponse: async (_adapter, _address, text, _sessionId, _replyTo, attachments = []) => {
        calls.push(`attachments:${text}:${attachments.length}`);
        return { ok: true };
      },
    }, response);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['text:镜像正文', 'attachments::1']);
  });

  it('finalizes stream feedback through the adapter', async () => {
    const adapter = new FakeAdapter();
    const finalized = await finalizeStreamingUi(
      {
        adapter,
        channelType: 'feishu-default',
        chatId: 'chat-1',
        streamKey: 'stream-1',
      },
      'completed',
      assembleSdkFinalResponse({ text: '最终回复' }),
    );

    assert.equal(finalized, true);
    assert.deepEqual(adapter.streamEnds, [{
      status: 'completed',
      text: '最终回复',
      streamKey: 'stream-1',
    }]);
  });
});
