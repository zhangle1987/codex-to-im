import type { DesktopMirrorSubscription } from './mirror-subscription-state.js';

export type MirrorReconcileStatus = 'processed' | 'suspended';

export interface MirrorReconcileBatchDeps {
  syncSubscriptionSet: () => void;
  getSubscriptions: () => DesktopMirrorSubscription[];
  reconcileSubscription: (subscription: DesktopMirrorSubscription) => Promise<MirrorReconcileStatus>;
  clearFailureState: (subscription: DesktopMirrorSubscription) => void;
  handleFailure: (subscription: DesktopMirrorSubscription, error: unknown) => Promise<void> | void;
  logBatchError: (stage: string, error: unknown) => void;
}

export async function runMirrorReconcileBatch(deps: MirrorReconcileBatchDeps): Promise<void> {
  let stage = 'sync-start';

  try {
    try {
      stage = 'sync-subscription-set';
      deps.syncSubscriptionSet();
    } catch (error) {
      deps.logBatchError(stage, error);
      return;
    }

    stage = 'snapshot-subscriptions';
    const subscriptions = deps.getSubscriptions();
    for (const subscription of subscriptions) {
      stage = `subscription:${subscription.bindingId}`;
      try {
        const result = await deps.reconcileSubscription(subscription);
        if (result !== 'suspended') {
          deps.clearFailureState(subscription);
        }
      } catch (error) {
        await deps.handleFailure(subscription, error);
      }
    }
  } catch (error) {
    deps.logBatchError(stage, error);
  }
}
