import { createAdapter, type BaseChannelAdapter } from './channel-adapter.js';
import type { InboundMessage } from './types.js';
import { listConfiguredChannelInstances } from './bridge-channel-runtime.js';
import {
  buildAdapterSyncPlan,
  listEnabledAdapterInstances,
} from './adapter-sync-plan.js';

export interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
  configFingerprint: string;
}

export interface BridgeAdapterRuntimeState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  invalidAdapters: Map<string, string>;
  loopAborts: Map<string, AbortController>;
  running: boolean;
}

export interface CreateAdapterRuntimeDeps {
  notifyAdapterSetChanged(channelTypes: string[]): void;
  handleMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void>;
  processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void>;
  isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean;
  resolveSessionIdForMessage(msg: InboundMessage): string;
}

export interface AdapterRuntime {
  getActiveChannelTypes(): string[];
  stopAdapterInstance(channelType: string): Promise<void>;
  syncConfiguredAdapters(options: { startLoops: boolean }): Promise<void>;
  runAdapterLoop(adapter: BaseChannelAdapter): void;
  clearWarningCache(): void;
}

const INVALID_ADAPTER_WARNING_CACHE = new Map<string, string>();

export function createAdapterRuntime(
  getState: () => BridgeAdapterRuntimeState,
  deps: CreateAdapterRuntimeDeps,
): AdapterRuntime {
  function getActiveChannelTypes(): string[] {
    return Array.from(getState().adapters.keys()).sort();
  }

  async function stopAdapterInstance(channelType: string): Promise<void> {
    const state = getState();
    const adapter = state.adapters.get(channelType);
    state.invalidAdapters.delete(channelType);
    INVALID_ADAPTER_WARNING_CACHE.delete(channelType);
    if (!adapter) return;

    state.loopAborts.get(channelType)?.abort();
    state.loopAborts.delete(channelType);

    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${channelType}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${channelType}:`, err);
    }

    state.adapters.delete(channelType);
    state.adapterMeta.delete(channelType);
  }

  async function syncConfiguredAdapters(options: { startLoops: boolean }): Promise<void> {
    const state = getState();
    let changed = false;
    const desiredInstances = listEnabledAdapterInstances(
      listConfiguredChannelInstances(),
    );
    const plan = buildAdapterSyncPlan({
      currentAdapterIds: state.adapters.keys(),
      invalidAdapterIds: state.invalidAdapters.keys(),
      warningCacheIds: INVALID_ADAPTER_WARNING_CACHE.keys(),
      desiredInstances,
      getExistingFingerprint: (channelType) => state.adapterMeta.get(channelType)?.configFingerprint,
    });

    for (const existingKey of plan.stopChannelTypes) {
      await stopAdapterInstance(existingKey);
      changed = true;
    }
    for (const invalidKey of plan.removeInvalidIds) {
      state.invalidAdapters.delete(invalidKey);
    }
    for (const invalidKey of plan.removeWarningCacheIds) {
      INVALID_ADAPTER_WARNING_CACHE.delete(invalidKey);
    }

    for (const { instance, fingerprint, restartExisting } of plan.startItems) {
      if (restartExisting) {
        await stopAdapterInstance(instance.id);
        changed = true;
      }

      const adapter = createAdapter(instance);
      if (!adapter) continue;

      const configError = adapter.validateConfig();
      if (configError) {
        const invalidSignature = `${fingerprint}:${configError}`;
        if (INVALID_ADAPTER_WARNING_CACHE.get(instance.id) !== invalidSignature) {
          console.warn(`[bridge-manager] ${instance.id} adapter not valid:`, configError);
          INVALID_ADAPTER_WARNING_CACHE.set(instance.id, invalidSignature);
          state.invalidAdapters.set(instance.id, invalidSignature);
        }
        continue;
      }
      state.invalidAdapters.delete(instance.id);
      INVALID_ADAPTER_WARNING_CACHE.delete(instance.id);

      try {
        await adapter.start();
        if (!adapter.isRunning()) {
          throw new Error('adapter start completed without entering running state');
        }
        state.adapters.set(instance.id, adapter);
        state.adapterMeta.set(instance.id, {
          lastMessageAt: null,
          lastError: null,
          configFingerprint: fingerprint,
        });
        console.log(`[bridge-manager] Started adapter: ${instance.id}`);
        if (options.startLoops && state.running) {
          runAdapterLoop(adapter);
        }
        changed = true;
      } catch (err) {
        try {
          await adapter.stop();
        } catch (cleanupErr) {
          console.error(`[bridge-manager] Failed to clean up adapter ${instance.id} after start error:`, cleanupErr);
        }
        state.adapters.delete(instance.id);
        state.adapterMeta.delete(instance.id);
        console.error(`[bridge-manager] Failed to start adapter ${instance.id}:`, err);
      }
    }

    if (changed) {
      deps.notifyAdapterSetChanged(getActiveChannelTypes());
    }
  }

  function runAdapterLoop(adapter: BaseChannelAdapter): void {
    const state = getState();
    const abort = new AbortController();
    state.loopAborts.set(adapter.channelType, abort);

    (async () => {
      while (state.running && adapter.isRunning()) {
        try {
          const msg = await adapter.consumeOne();
          if (!msg) continue;

          if (
            msg.callbackData ||
            msg.text.trim().startsWith('/') ||
            deps.isNumericPermissionShortcut(adapter.provider, msg.text.trim(), msg.address.chatId)
          ) {
            try {
              await deps.handleMessage(adapter, msg);
            } catch (error) {
              if (msg.updateId != null) {
                adapter.rejectUpdate?.(msg.updateId, msg.messageId);
              }
              throw error;
            }
          } else {
            try {
              const sessionId = deps.resolveSessionIdForMessage(msg);
              deps.processWithSessionLock(sessionId, () =>
                deps.handleMessage(adapter, msg),
              ).catch(err => {
                if (msg.updateId != null) {
                  adapter.rejectUpdate?.(msg.updateId, msg.messageId);
                }
                console.error(`[bridge-manager] Session ${sessionId.slice(0, 8)} error:`, err);
              });
            } catch (error) {
              if (msg.updateId != null) {
                adapter.rejectUpdate?.(msg.updateId, msg.messageId);
              }
              throw error;
            }
          }
        } catch (err) {
          if (abort.signal.aborted) break;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
          const meta = state.adapterMeta.get(adapter.channelType) || {
            lastMessageAt: null,
            lastError: null,
            configFingerprint: '',
          };
          meta.lastError = errMsg;
          state.adapterMeta.set(adapter.channelType, meta);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })().catch(err => {
      if (!abort.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
        const meta = state.adapterMeta.get(adapter.channelType) || {
          lastMessageAt: null,
          lastError: null,
          configFingerprint: '',
        };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
      }
    });
  }

  function clearWarningCache(): void {
    INVALID_ADAPTER_WARNING_CACHE.clear();
  }

  return {
    getActiveChannelTypes,
    stopAdapterInstance,
    syncConfiguredAdapters,
    runAdapterLoop,
    clearWarningCache,
  };
}
