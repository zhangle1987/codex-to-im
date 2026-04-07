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
  return {
    auditLogs,
    getSetting: (key: string) => settings[key] ?? null,
    insertAuditLog: (entry: { summary: string }) => { auditLogs.push(entry); },
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
});
