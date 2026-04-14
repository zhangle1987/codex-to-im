import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMirrorReconcileBatch } from '../lib/bridge/mirror-reconcile-batch.js';

describe('mirror-reconcile-batch', () => {
  it('continues reconciling later subscriptions after one failure', async () => {
    const calls: string[] = [];
    const failures: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {
        calls.push('sync');
      },
      getSubscriptions: () => [
        { bindingId: 'binding-1' } as any,
        { bindingId: 'binding-2' } as any,
      ],
      reconcileSubscription: async (subscription) => {
        calls.push(`reconcile:${subscription.bindingId}`);
        if (subscription.bindingId === 'binding-1') {
          throw new Error('boom');
        }
        return 'processed';
      },
      clearFailureState: (subscription) => {
        calls.push(`clear:${subscription.bindingId}`);
      },
      handleFailure: (subscription) => {
        failures.push(subscription.bindingId);
      },
      logBatchError: () => {
        throw new Error('should not hit outer batch error');
      },
    });

    assert.deepEqual(calls, [
      'sync',
      'reconcile:binding-1',
      'reconcile:binding-2',
      'clear:binding-2',
    ]);
    assert.deepEqual(failures, ['binding-1']);
  });

  it('does not clear failure state for suspended subscriptions', async () => {
    const cleared: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {},
      getSubscriptions: () => [
        { bindingId: 'binding-1' } as any,
      ],
      reconcileSubscription: async () => 'suspended',
      clearFailureState: (subscription) => {
        cleared.push(subscription.bindingId);
      },
      handleFailure: () => {
        throw new Error('should not hit failure handler');
      },
      logBatchError: () => {
        throw new Error('should not hit outer batch error');
      },
    });

    assert.deepEqual(cleared, []);
  });

  it('logs the correct stage when subscription set sync throws', async () => {
    const stages: string[] = [];

    await runMirrorReconcileBatch({
      syncSubscriptionSet: () => {
        throw new Error('sync boom');
      },
      getSubscriptions: () => [],
      reconcileSubscription: async () => 'processed',
      clearFailureState: () => {},
      handleFailure: () => {},
      logBatchError: (stage) => {
        stages.push(stage);
      },
    });

    assert.deepEqual(stages, ['sync-subscription-set']);
  });
});
