export interface MirrorRegistryBinding {
  id: string;
  channelType: string;
  codepilotSessionId: string;
  sdkSessionId?: string | null;
  active?: boolean;
}

export interface MirrorRegistrySession {
  sdk_session_id?: string | null;
}

export interface MirrorSubscriptionRegistryPlan<TBinding extends MirrorRegistryBinding> {
  upsertBindings: TBinding[];
  removeBindingIds: string[];
}

export function buildMirrorSubscriptionRegistryPlan<TBinding extends MirrorRegistryBinding>(
  bindings: TBinding[],
  activeChannelTypes: Iterable<string>,
  existingBindingIds: Iterable<string>,
  getSession: (sessionId: string) => MirrorRegistrySession | null | undefined,
): MirrorSubscriptionRegistryPlan<TBinding> {
  const activeChannels = new Set(activeChannelTypes);
  const upsertBindings = bindings.filter((binding) => {
    if (binding.active === false) return false;
    if (!activeChannels.has(binding.channelType)) return false;
    const session = getSession(binding.codepilotSessionId);
    return Boolean(binding.sdkSessionId || session?.sdk_session_id);
  });
  const desiredIds = new Set(upsertBindings.map((binding) => binding.id));
  const removeBindingIds = Array.from(existingBindingIds).filter((bindingId) => !desiredIds.has(bindingId));

  return {
    upsertBindings,
    removeBindingIds,
  };
}
