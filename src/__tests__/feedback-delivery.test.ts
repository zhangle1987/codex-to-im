import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { BaseChannelAdapter } from '../lib/bridge/channel-adapter.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { deliverResponse } from '../lib/bridge/feedback-delivery.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../lib/bridge/types.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

class AttachmentFailingAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';
  readonly sent: OutboundMessage[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    if (message.attachments?.length) {
      return { ok: false, error: 'attachment rejected', httpStatus: 400 } as SendResult;
    }
    return { ok: true, messageId: 'notice-message' };
  }
}

describe('feedback delivery', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    initBridgeContext({
      store: new JsonFileStore(new Map()),
      llm: {
        streamChat() {
          return new ReadableStream<string>({ start(controller) { controller.close(); } });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  it('keeps the overall delivery failed after sending an attachment failure notice', async () => {
    const adapter = new AttachmentFailingAdapter();
    const result = await deliverResponse(
      adapter,
      {
        channelType: adapter.channelType,
        channelProvider: adapter.provider,
        chatId: 'chat-attachment-failure',
      },
      '',
      'session-attachment-failure',
      'request-message',
      [{ kind: 'file', path: 'D:\\workspace\\report.pdf' }],
    );

    assert.equal(result.ok, false);
    assert.match(result.error || '', /attachment rejected/);
    assert.equal(adapter.sent.length, 2);
    assert.equal(adapter.sent[0]?.attachments?.[0]?.path, 'D:\\workspace\\report.pdf');
    assert.match(adapter.sent[1]?.text || '', /附件发送失败/);
  });
});
