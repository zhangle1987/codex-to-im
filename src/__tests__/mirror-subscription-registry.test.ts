import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildMirrorSubscriptionRegistryPlan } from '../lib/bridge/mirror-subscription-registry.js';

describe('mirror-subscription-registry', () => {
  it('keeps only bindings that are active, have a running channel, and resolve to a desktop thread', () => {
    const bindings = [
      {
        id: 'ignore-bridge-sdk-thread',
        channelType: 'feishu-default',
        codepilotSessionId: 'session-1',
        sdkSessionId: 'thread-1',
      },
      {
        id: 'keep-from-session',
        channelType: 'feishu-default',
        codepilotSessionId: 'session-2',
        sdkSessionId: '',
      },
      {
        id: 'inactive',
        channelType: 'feishu-default',
        codepilotSessionId: 'session-3',
        sdkSessionId: 'thread-3',
        active: false,
      },
      {
        id: 'missing-channel',
        channelType: 'weixin-default',
        codepilotSessionId: 'session-4',
        sdkSessionId: 'thread-4',
      },
      {
        id: 'missing-thread',
        channelType: 'feishu-default',
        codepilotSessionId: 'session-5',
        sdkSessionId: '',
      },
    ];

    const plan = buildMirrorSubscriptionRegistryPlan(
      bindings,
      ['feishu-default'],
      [],
      (sessionId) => {
        if (sessionId === 'session-1') {
          return { sdk_session_id: 'thread-1', thread_origin: 'bridge' };
        }
        if (sessionId === 'session-2') {
          return { sdk_session_id: 'thread-2', desktop_thread_id: 'thread-2', thread_origin: 'desktop' };
        }
        if (sessionId === 'session-5') {
          return { sdk_session_id: '' };
        }
        return null;
      },
    );

    assert.deepEqual(
      plan.upsertBindings.map((binding) => binding.id),
      ['keep-from-session'],
    );
    assert.deepEqual(plan.removeBindingIds, []);
  });

  it('removes subscriptions that are no longer desired', () => {
    const plan = buildMirrorSubscriptionRegistryPlan(
      [
        {
          id: 'binding-1',
          channelType: 'feishu-default',
          codepilotSessionId: 'session-1',
          sdkSessionId: 'thread-1',
        },
      ],
      ['feishu-default'],
      ['binding-1', 'binding-2', 'binding-3'],
      () => ({ desktop_thread_id: 'thread-1', thread_origin: 'desktop' }),
    );

    assert.deepEqual(plan.upsertBindings.map((binding) => binding.id), ['binding-1']);
    assert.deepEqual(plan.removeBindingIds, ['binding-2', 'binding-3']);
  });
});
