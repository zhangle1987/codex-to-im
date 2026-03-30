import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_V2_PATH, CTI_HOME } from '../config.js';
import { bindStoreToSdkSession, bindStoreToSession } from '../session-bindings.js';
import { JsonFileStore } from '../store.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

describe('session-bindings uniqueness', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(CONFIG_V2_PATH, { force: true });
    fs.mkdirSync(path.dirname(CONFIG_V2_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_V2_PATH, JSON.stringify({
      schemaVersion: 2,
      runtime: {
        provider: 'codex',
        defaultMode: 'code',
      },
      channels: [
        {
          id: 'feishu-default',
          alias: '飞书',
          provider: 'feishu',
          enabled: true,
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
          config: {},
        },
        {
          id: 'weixin-default',
          alias: '微信',
          provider: 'weixin',
          enabled: true,
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
          config: {},
        },
      ],
    }, null, 2));
  });

  it('rejects binding the same session to a different chat', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('shared', 'test-model', undefined, '/tmp/shared');

    const first = bindStoreToSession(store, 'feishu-default', 'oc_a', session.id);
    assert.ok(first);
    store.updateChannelBinding(first.id, { chatDisplayName: '张乐' });

    assert.throws(
      () => bindStoreToSession(store, 'feishu-default', 'oc_b', session.id),
      /飞书 聊天 张乐。一个会话只能绑定一个聊天/,
    );
  });

  it('rejects binding the same desktop thread across channels', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('desktop', 'test-model', undefined, '/tmp/shared');
    store.updateSdkSessionId(session.id, 'thread-1');

    const first = bindStoreToSdkSession(store, 'feishu-default', 'oc_a', 'thread-1', {
      workingDirectory: '/tmp/shared',
      displayName: 'Desktop Thread',
    });
    assert.ok(first);

    assert.throws(
      () => bindStoreToSdkSession(store, 'weixin-default', 'wx_a', 'thread-1', {
        workingDirectory: '/tmp/shared',
        displayName: 'Desktop Thread',
      }),
      /一个会话只能绑定一个聊天/,
    );
  });

  it('stores chat display metadata when binding to an existing session', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('shared', 'test-model', undefined, '/tmp/shared');

    const binding = bindStoreToSession(store, 'feishu-default', 'oc_meta', session.id, {
      chatUserId: 'ou_123',
      chatDisplayName: '张乐',
    });
    assert.ok(binding);
    assert.equal(binding.chatUserId, 'ou_123');
    assert.equal(binding.chatDisplayName, '张乐');
  });

  it('stores chat display metadata when binding to a desktop thread', () => {
    const store = new JsonFileStore(makeSettings());

    const binding = bindStoreToSdkSession(store, 'feishu-default', 'oc_meta', 'thread-meta', {
      workingDirectory: '/tmp/shared',
      displayName: 'Desktop Thread',
      chatUserId: 'ou_456',
      chatDisplayName: '张乐',
    });

    assert.equal(binding.chatUserId, 'ou_456');
    assert.equal(binding.chatDisplayName, '张乐');
  });
});
