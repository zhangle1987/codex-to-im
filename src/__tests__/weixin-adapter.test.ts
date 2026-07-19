import './test-setup.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { BridgeStore } from '../lib/bridge/host.js';
import { CTI_HOME } from '../config.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { WeixinAdapter } from '../adapters/weixin-adapter.js';
import { MessageItemType } from '../adapters/weixin/weixin-types.js';
import { upsertWeixinAccount } from '../weixin-store.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const ACCOUNTS_PATH = path.join(DATA_DIR, 'weixin-accounts.json');
const TOKENS_PATH = path.join(DATA_DIR, 'weixin-context-tokens.json');

function createMockStore(settings: Record<string, string> = {}) {
  const auditLogs: Array<{ summary: string }> = [];
  const offsets = new Map<string, string>();
  const dedup = new Set<string>();
  return {
    auditLogs,
    offsets,
    dedup,
    getSetting: (key: string) => settings[key] ?? null,
    insertAuditLog: (entry: { summary: string }) => { auditLogs.push(entry); },
    getChannelOffset: (key: string) => offsets.get(key) ?? '0',
    setChannelOffset: (key: string, value: string) => { offsets.set(key, value); },
    checkDedup: (key: string) => dedup.has(key),
    insertDedup: (key: string) => { dedup.add(key); },
  };
}

function setupContext(store: ReturnType<typeof createMockStore>) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

describe('weixin-adapter voice handling', () => {
  beforeEach(() => {
    setupContext(createMockStore({ bridge_weixin_media_enabled: 'false' }));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.rmSync(ACCOUNTS_PATH, { force: true });
    fs.rmSync(TOKENS_PATH, { force: true });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('uses WeChat speech-to-text directly for voice messages', async () => {
    const adapter = new WeixinAdapter();

    await (adapter as any).processMessage('acct-1', {
      message_id: 'voice-text-msg',
      from_user_id: 'wx-user-1',
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: '这是微信自带的语音转文字' },
        },
      ],
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '这是微信自带的语音转文字');
    assert.equal(inbound?.attachments, undefined);
  });

  it('surfaces a clear error when voice transcription is unavailable', async () => {
    const adapter = new WeixinAdapter();

    await (adapter as any).processMessage('acct-1', {
      message_id: 'voice-no-text-msg',
      from_user_id: 'wx-user-2',
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: {},
        },
      ],
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '');
    assert.deepEqual(inbound?.attachments, undefined);
    assert.equal(
      (inbound?.raw as { userVisibleError?: string } | undefined)?.userVisibleError,
      'WeChat did not provide speech-to-text for this voice message. Please enable WeChat voice transcription and send it again.',
    );
  });

  it('treats a configured but missing linked account as invalid config', () => {
    const adapter = new WeixinAdapter({
      id: 'weixin--test',
      provider: 'weixin',
      alias: 'Test Weixin',
      enabled: true,
      config: {
        accountId: 'missing-account',
      },
    } as any);

    assert.equal(adapter.validateConfig(), 'Linked WeChat account missing-account not found');
  });

  it('requires explicit account selection when multiple linked accounts exist', () => {
    upsertWeixinAccount({
      accountId: 'wx-bot-a',
      token: 'token-a',
      enabled: true,
    });
    upsertWeixinAccount({
      accountId: 'wx-bot-b',
      token: 'token-b',
      enabled: true,
    });

    const adapter = new WeixinAdapter({
      id: 'weixin--test',
      provider: 'weixin',
      alias: 'Test Weixin',
      enabled: true,
      config: {},
    } as any);

    assert.equal(
      adapter.validateConfig(),
      'Multiple linked WeChat accounts detected. Please select a WeChat account for this channel.',
    );
  });

  it('commits deferred cursors in batch order even when messages finish out of order', async () => {
    const store = createMockStore();
    setupContext(store);
    const adapter = new WeixinAdapter();
    (adapter as any).seenMessageIds.set('acct-1', new Set());

    const firstBatch = (adapter as any).createPendingCursorBatch('acct-1', 'weixin:acct-1', 'cursor-1');
    await (adapter as any).processMessage('acct-1', {
      message_id: 'ordered-1',
      from_user_id: 'wx-user-1',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'first' } }],
    }, firstBatch);
    (adapter as any).pendingCursors.get(firstBatch).sealed = true;
    (adapter as any).maybeCommitPendingCursors('acct-1');

    const secondBatch = (adapter as any).createPendingCursorBatch('acct-1', 'weixin:acct-1', 'cursor-2');
    await (adapter as any).processMessage('acct-1', {
      message_id: 'ordered-2',
      from_user_id: 'wx-user-1',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'second' } }],
    }, secondBatch);
    (adapter as any).pendingCursors.get(secondBatch).sealed = true;
    (adapter as any).maybeCommitPendingCursors('acct-1');

    const first = await adapter.consumeOne();
    const second = await adapter.consumeOne();
    assert.ok(first && second);

    adapter.acknowledgeUpdate(secondBatch, second.messageId);
    assert.equal(store.getChannelOffset('weixin:acct-1'), '0');

    adapter.acknowledgeUpdate(firstBatch, first.messageId);
    assert.equal(store.getChannelOffset('weixin:acct-1'), 'cursor-2');
  });

  it('rolls back a rejected batch and allows its message to be replayed', async () => {
    const store = createMockStore();
    setupContext(store);
    const adapter = new WeixinAdapter();
    (adapter as any).seenMessageIds.set('acct-1', new Set());

    const message = {
      message_id: 'retry-message',
      from_user_id: 'wx-user-1',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'retry me' } }],
    };
    const failedBatch = (adapter as any).createPendingCursorBatch('acct-1', 'weixin:acct-1', 'cursor-failed');
    await (adapter as any).processMessage('acct-1', message, failedBatch);
    (adapter as any).pendingCursors.get(failedBatch).sealed = true;
    const firstAttempt = await adapter.consumeOne();
    assert.ok(firstAttempt);

    adapter.rejectUpdate(failedBatch, firstAttempt.messageId);
    assert.equal(store.getChannelOffset('weixin:acct-1'), '0');
    assert.equal((adapter as any).pendingCursors.size, 0);

    const retryBatch = (adapter as any).createPendingCursorBatch('acct-1', 'weixin:acct-1', 'cursor-retry');
    await (adapter as any).processMessage('acct-1', message, retryBatch);
    const retried = await adapter.consumeOne();
    assert.equal(retried?.messageId, 'retry-message');
  });
});
