/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';
import { bindStoreToSdkSession, bindStoreToSession } from '../../session-bindings.js';
import { getOrCreateDraftSession } from '../../internal-sessions.js';

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding.
 * Without a working directory it starts in the hidden draft thread (/t 0).
 * With a working directory it creates a regular visible code session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const session = workingDirectory
    ? store.createSession(
        `Bridge: ${address.displayName || address.chatId}`,
        defaultModel,
        undefined,
        workingDirectory,
        'code',
      )
    : getOrCreateDraftSession(store, address);

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: session.working_directory,
    model: session.model,
    mode: session.preferred_mode || (workingDirectory ? 'code' : 'ask'),
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  return bindStoreToSession(getBridgeContext().store, address.channelType, address.chatId, codepilotSessionId);
}

/**
 * Bind an IM chat to an existing SDK thread, importing it into the bridge store on demand.
 */
export function bindToSdkSession(
  address: ChannelAddress,
  sdkSessionId: string,
  opts?: { workingDirectory?: string; model?: string; displayName?: string },
): ChannelBinding {
  return bindStoreToSdkSession(getBridgeContext().store, address.channelType, address.chatId, sdkSessionId, opts);
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
