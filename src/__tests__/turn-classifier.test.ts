import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyInteractiveTurn,
  getCodexThreadId,
  getExplicitDesktopThreadId,
  isDesktopBackedSession,
} from '../lib/bridge/turns/turn-classifier.js';
import type { BridgeSession } from '../lib/bridge/host.js';
import type { ChannelBinding } from '../lib/bridge/types.js';

function binding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    id: 'binding-1',
    channelType: 'feishu-default',
    chatId: 'chat-1',
    codepilotSessionId: 'session-1',
    sdkSessionId: '',
    workingDirectory: '/tmp/project',
    model: 'gpt-test',
    mode: 'code',
    active: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function session(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    id: 'session-1',
    name: 'session',
    working_directory: '/tmp/project',
    model: 'gpt-test',
    ...overrides,
  };
}

describe('turn-classifier', () => {
  it('classifies pure IM SDK sessions even when a codex thread id exists', () => {
    const currentSession = session({
      sdk_session_id: 'codex-thread-1',
      codex_thread_id: 'codex-thread-1',
      thread_origin: 'bridge',
    });
    const result = classifyInteractiveTurn(
      binding({ sdkSessionId: 'codex-thread-1' }),
      currentSession,
      () => true,
    );

    assert.equal(result.kind, 'im_sdk');
    assert.equal(result.reason, 'bridge_thread');
    assert.equal(result.codexThreadId, 'codex-thread-1');
    assert.equal(result.desktopThreadId, undefined);
    assert.equal(result.desktopAvailable, false);
  });

  it('classifies explicit desktop-backed sessions as IM desktop reuse', () => {
    const currentSession = session({
      sdk_session_id: 'desktop-thread-1',
      codex_thread_id: 'desktop-thread-1',
      desktop_thread_id: 'desktop-thread-1',
      thread_origin: 'desktop',
    });
    const result = classifyInteractiveTurn(
      binding({ sdkSessionId: 'desktop-thread-1' }),
      currentSession,
      (threadId) => threadId === 'desktop-thread-1',
    );

    assert.equal(result.kind, 'im_desktop_reuse');
    assert.equal(result.reason, 'desktop_thread');
    assert.equal(result.codexThreadId, 'desktop-thread-1');
    assert.equal(result.desktopThreadId, 'desktop-thread-1');
    assert.equal(result.desktopAvailable, true);
  });

  it('marks missing desktop threads without treating bridge SDK ids as desktop ids', () => {
    const currentSession = session({
      sdk_session_id: 'desktop-missing',
      codex_thread_id: 'desktop-missing',
      desktop_thread_id: 'desktop-missing',
      thread_origin: 'desktop',
    });
    const result = classifyInteractiveTurn(
      binding({ sdkSessionId: 'desktop-missing' }),
      currentSession,
      () => false,
    );

    assert.equal(result.kind, 'im_sdk');
    assert.equal(result.reason, 'desktop_thread_missing');
    assert.equal(result.desktopThreadId, 'desktop-missing');
    assert.equal(result.desktopAvailable, false);
  });

  it('falls back to legacy desktop origin only when explicitly marked desktop', () => {
    const desktopLegacy = session({
      sdk_session_id: 'legacy-desktop-thread',
      thread_origin: 'desktop',
    });
    const bridgeLegacy = session({
      sdk_session_id: 'legacy-bridge-thread',
    });

    assert.equal(getExplicitDesktopThreadId(desktopLegacy), 'legacy-desktop-thread');
    assert.equal(getExplicitDesktopThreadId(bridgeLegacy), undefined);
    assert.equal(isDesktopBackedSession(desktopLegacy), true);
    assert.equal(isDesktopBackedSession(bridgeLegacy), false);
    assert.equal(getCodexThreadId(bridgeLegacy), 'legacy-bridge-thread');
  });
});
