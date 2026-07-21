import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { sseEvent } from '../sse-utils.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import * as router from '../lib/bridge/channel-router.js';
import {
  buildConversationPromptText,
  buildLocalAttachmentPromptSupplement,
  processMessage,
  validateInboundAttachmentSizes,
} from '../lib/bridge/conversation-engine.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

describe('conversation attachment validation', () => {
  it('enforces decoded per-file and aggregate limits', () => {
    const makeFile = (name: string, bytes: number) => ({
      id: name,
      name,
      type: 'application/octet-stream',
      size: bytes,
      data: Buffer.alloc(bytes).toString('base64'),
    });

    assert.equal(validateInboundAttachmentSizes([makeFile('ok.bin', 4)], 4, 8), null);
    assert.match(
      validateInboundAttachmentSizes([makeFile('large.bin', 5)], 4, 8) || '',
      /too large/,
    );
    assert.match(
      validateInboundAttachmentSizes([makeFile('a.bin', 4), makeFile('b.bin', 4)], 8, 7) || '',
      /too large in total/,
    );
  });
});

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

function streamFromSseEvents(events: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
}

function streamFromSseEventsThenError(events: string[], error: Error): ReadableStream<string> {
  let index = 0;
  return new ReadableStream<string>({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(events[index]);
        index += 1;
        return;
      }
      controller.error(error);
    },
  });
}

describe('processMessage desktop busy retry', () => {
  it('retries a desktop-backed session busy error without duplicating the user message', async () => {
    const oldRetryDelays = process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS;
    process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS = '0,0';
    fs.rmSync(DATA_DIR, { recursive: true, force: true });

    try {
      let streamCalls = 0;
      const sdkSessionIds: Array<string | undefined> = [];
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: {
          streamChat(params) {
            streamCalls += 1;
            sdkSessionIds.push(params.sdkSessionId);
            if (streamCalls === 1) {
              return streamFromSseEvents([
                sseEvent('error', 'Session is busy processing another request'),
              ]);
            }
            return streamFromSseEvents([
              sseEvent('text', '最终回复'),
              sseEvent('result', {
                session_id: 'desktop-thread-1',
                usage: { input_tokens: 1, output_tokens: 2 },
              }),
            ]);
          },
        },
        permissions: {
          resolvePendingPermission: () => false,
        },
        lifecycle: {},
      });

      const address = {
        channelType: 'feishu-default',
        channelProvider: 'feishu',
        chatId: 'chat-desktop-busy-retry',
        userId: 'user-desktop-busy-retry',
      } as const;
      const initialBinding = router.createBinding(address, 'D:\\workspace\\desktop-busy-retry');
      store.updateSession(initialBinding.codepilotSessionId, {
        sdk_session_id: 'desktop-thread-1',
        codex_thread_id: 'desktop-thread-1',
        desktop_thread_id: 'desktop-thread-1',
        thread_origin: 'desktop',
      });
      router.updateBinding(initialBinding.id, { sdkSessionId: 'desktop-thread-1' });
      const binding = router.resolve(address);
      const statusNotes: string[] = [];

      const result = await processMessage(
        binding,
        'hello desktop',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (note) => {
          if (note) statusNotes.push(note);
        },
      );

      assert.equal(streamCalls, 2);
      assert.deepEqual(sdkSessionIds, ['desktop-thread-1', 'desktop-thread-1']);
      assert.equal(result.hasError, false);
      assert.equal(result.responseText, '最终回复');
      assert.match(statusNotes[0] || '', /重试（1\/2）/);

      const { messages } = store.getMessages(binding.codepilotSessionId);
      assert.equal(messages.filter((message) => message.role === 'user').length, 1);
      assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
    } finally {
      if (oldRetryDelays === undefined) {
        delete process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS;
      } else {
        process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS = oldRetryDelays;
      }
    }
  });

  it('does not retry a non-desktop session busy error', async () => {
    const oldRetryDelays = process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS;
    process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS = '0,0';
    fs.rmSync(DATA_DIR, { recursive: true, force: true });

    try {
      let streamCalls = 0;
      const store = new JsonFileStore(makeSettings());
      initBridgeContext({
        store,
        llm: {
          streamChat() {
            streamCalls += 1;
            return streamFromSseEvents([
              sseEvent('error', 'Session is busy processing another request'),
            ]);
          },
        },
        permissions: {
          resolvePendingPermission: () => false,
        },
        lifecycle: {},
      });

      const address = {
        channelType: 'feishu-default',
        channelProvider: 'feishu',
        chatId: 'chat-sdk-busy-no-retry',
        userId: 'user-sdk-busy-no-retry',
      } as const;
      const binding = router.createBinding(address, 'D:\\workspace\\sdk-busy-no-retry');

      const result = await processMessage(binding, 'hello sdk');

      assert.equal(streamCalls, 1);
      assert.equal(result.hasError, true);
      assert.equal(result.errorCode, 'session_busy');
      assert.equal(result.errorMessage, 'Session is busy processing another request');

      const { messages } = store.getMessages(binding.codepilotSessionId);
      assert.equal(messages.filter((message) => message.role === 'user').length, 1);
      assert.equal(messages.filter((message) => message.role === 'assistant').length, 0);
    } finally {
      if (oldRetryDelays === undefined) {
        delete process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS;
      } else {
        process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS = oldRetryDelays;
      }
    }
  });
});

describe('processMessage stream recovery', () => {
  it('preserves the structured Desktop transport loss code from provider status', async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          return streamFromSseEvents([
            sseEvent('status', { error_code: 'desktop_transport_lost' }),
            sseEvent('error', 'Codex 会话恢复失败，上一轮执行进程未正常退出。'),
          ]);
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });
    const binding = router.createBinding({
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-transport-code',
      userId: 'user-transport-code',
    }, 'D:\\workspace\\transport-code');

    const result = await processMessage(binding, 'hello');

    assert.equal(result.hasError, true);
    assert.equal(result.errorCode, 'desktop_transport_lost');
  });

  it('returns and persists partial text and outbound attachments when the stream fails', async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          return streamFromSseEventsThenError([
            sseEvent(
              'text',
              '部分回复\n<cti-send>{"type":"file","path":"D:\\\\workspace\\\\report.pdf"}</cti-send>',
            ),
          ], new Error('stream disconnected'));
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-stream-recovery',
      userId: 'user-stream-recovery',
    } as const;
    const binding = router.createBinding(address, 'D:\\workspace\\stream-recovery');

    const result = await processMessage(binding, 'run a long task');

    assert.equal(result.hasError, true);
    assert.equal(result.errorMessage, 'stream disconnected');
    assert.equal(result.responseText, '部分回复');
    assert.deepEqual(result.outboundAttachments, [{
      kind: 'file',
      path: 'D:\\workspace\\report.pdf',
      caption: undefined,
      name: undefined,
    }]);

    const { messages } = store.getMessages(binding.codepilotSessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.content, '部分回复');
    assert.doesNotMatch(assistant?.content || '', /cti-send/);
  });
});

describe('buildLocalAttachmentPromptSupplement', () => {
  it('returns an empty string when only images are present', () => {
    const result = buildLocalAttachmentPromptSupplement([
      {
        id: 'img-1',
        name: 'screenshot.png',
        type: 'image/png',
        size: 2048,
        filePath: 'D:\\work\\.codepilot-uploads\\screenshot.png',
      },
    ]);

    assert.equal(result, '');
  });

  it('includes local file paths for non-image attachments', () => {
    const result = buildLocalAttachmentPromptSupplement([
      {
        id: 'pdf-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 40960,
        filePath: 'D:\\work\\.codepilot-uploads\\report.pdf',
      },
      {
        id: 'video-1',
        name: 'demo.mp4',
        type: 'video/mp4',
        size: 5 * 1024 * 1024,
        filePath: 'D:\\work\\.codepilot-uploads\\demo.mp4',
      },
    ]);

    assert.match(result, /Attached local files:/);
    assert.match(result, /report\.pdf/);
    assert.match(result, /application\/pdf/);
    assert.match(result, /D:\\work\\\.codepilot-uploads\\report\.pdf/);
    assert.match(result, /demo\.mp4/);
    assert.match(result, /video\/mp4/);
    assert.match(result, /extract frames or audio only when needed/i);
  });

  it('builds the effective conversation prompt including non-image attachment guidance', () => {
    const result = buildConversationPromptText('请帮我总结附件', [
      {
        id: 'pdf-1',
        name: 'report.pdf',
        type: 'application/pdf',
        size: 40960,
        filePath: 'D:\\work\\.codepilot-uploads\\report.pdf',
      },
    ]);

    assert.match(result, /^请帮我总结附件\n\nAttached local files:/);
    assert.match(result, /report\.pdf/);
    assert.match(result, /D:\\work\\\.codepilot-uploads\\report\.pdf/);
  });
});
