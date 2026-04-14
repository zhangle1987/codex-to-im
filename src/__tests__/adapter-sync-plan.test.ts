import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdapterConfigFingerprint,
  buildAdapterSyncPlan,
  listEnabledAdapterInstances,
} from '../lib/bridge/adapter-sync-plan.js';

describe('adapter-sync-plan listEnabledAdapterInstances', () => {
  it('merges enabled configured instances with enabled legacy providers', () => {
    const instances = listEnabledAdapterInstances(
      [
        {
          id: 'feishu-main',
          provider: 'feishu',
          alias: '主飞书',
          enabled: true,
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          config: { appId: 'app-id' },
        },
        {
          id: 'weixin-disabled',
          provider: 'weixin',
          alias: '微信',
          createdAt: '2026-04-13T00:00:00.000Z',
          updatedAt: '2026-04-13T00:00:00.000Z',
          enabled: true,
          config: { accountId: 'wx-1' },
        },
      ],
      ['feishu', 'weixin', 'telegram', 'discord', 'qq'],
      (provider) => provider === 'discord' || provider === 'qq' || provider === 'weixin',
    );

    assert.deepEqual(instances, [
      {
        id: 'feishu-main',
        provider: 'feishu',
        alias: '主飞书',
        enabled: true,
        config: { appId: 'app-id' },
      },
      {
        id: 'weixin-disabled',
        provider: 'weixin',
        alias: '微信',
        enabled: true,
        config: { accountId: 'wx-1' },
      },
      {
        id: 'discord',
        provider: 'discord',
        alias: 'discord',
        enabled: true,
        config: {},
      },
      {
        id: 'qq',
        provider: 'qq',
        alias: 'qq',
        enabled: true,
        config: {},
      },
    ]);
  });
});

describe('adapter-sync-plan buildAdapterSyncPlan', () => {
  it('computes stop, cleanup, and restart actions from desired instances', () => {
    const same = {
      id: 'same',
      provider: 'discord',
      alias: 'Discord',
      enabled: true,
      config: { appId: 'same' },
    };
    const restart = {
      id: 'restart',
      provider: 'telegram',
      alias: 'Telegram',
      enabled: true,
      config: { appId: 'new' },
    };
    const created = {
      id: 'created',
      provider: 'qq',
      alias: 'QQ',
      enabled: true,
      config: {},
    };

    const plan = buildAdapterSyncPlan({
      currentAdapterIds: ['removed', 'same', 'restart'],
      invalidAdapterIds: ['removed-invalid', 'same-invalid'],
      warningCacheIds: ['removed-warning', 'same-warning'],
      desiredInstances: [same, restart, created],
      getExistingFingerprint: (channelType) => {
        if (channelType === 'same') {
          return buildAdapterConfigFingerprint(same);
        }
        if (channelType === 'restart') {
          return buildAdapterConfigFingerprint({
            ...restart,
            config: { appId: 'old' },
          });
        }
        return null;
      },
    });

    assert.deepEqual(plan.stopChannelTypes, ['removed']);
    assert.deepEqual(plan.removeInvalidIds, ['removed-invalid', 'same-invalid']);
    assert.deepEqual(plan.removeWarningCacheIds, ['removed-warning', 'same-warning']);
    assert.deepEqual(
      plan.startItems.map((item) => ({
        id: item.instance.id,
        restartExisting: item.restartExisting,
      })),
      [
        { id: 'restart', restartExisting: true },
        { id: 'created', restartExisting: false },
      ],
    );
  });
});
