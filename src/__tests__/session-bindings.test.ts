import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
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
  });

  it('rejects binding the same session to a different chat', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('shared', 'test-model', undefined, '/tmp/shared');

    const first = bindStoreToSession(store, 'feishu', 'oc_a', session.id);
    assert.ok(first);

    assert.throws(
      () => bindStoreToSession(store, 'feishu', 'oc_b', session.id),
      /一个会话只能绑定一个聊天/,
    );
  });

  it('rejects binding the same desktop thread across channels', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('desktop', 'test-model', undefined, '/tmp/shared');
    store.updateSdkSessionId(session.id, 'thread-1');

    const first = bindStoreToSdkSession(store, 'feishu', 'oc_a', 'thread-1', {
      workingDirectory: '/tmp/shared',
      displayName: 'Desktop Thread',
    });
    assert.ok(first);

    assert.throws(
      () => bindStoreToSdkSession(store, 'weixin', 'wx_a', 'thread-1', {
        workingDirectory: '/tmp/shared',
        displayName: 'Desktop Thread',
      }),
      /一个会话只能绑定一个聊天/,
    );
  });
});
