import type { BridgeSession } from '../host.js';
import type { ChannelBinding } from '../types.js';
import type { BridgeTurnClassification } from './turn-types.js';

export type DesktopThreadLookup = (threadId: string) => boolean;

type SessionLike = Pick<
  BridgeSession,
  'id' | 'sdk_session_id' | 'codex_thread_id' | 'desktop_thread_id' | 'thread_origin'
>;

type BindingLike = Pick<ChannelBinding, 'codepilotSessionId' | 'sdkSessionId'>;

function normalizeThreadId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function getCodexThreadId(
  session: SessionLike | null | undefined,
  binding?: BindingLike | null,
): string | undefined {
  return normalizeThreadId(session?.codex_thread_id)
    || normalizeThreadId(binding?.sdkSessionId)
    || normalizeThreadId(session?.sdk_session_id);
}

export function getExplicitDesktopThreadId(
  session: SessionLike | null | undefined,
): string | undefined {
  return normalizeThreadId(session?.desktop_thread_id)
    || (session?.thread_origin === 'desktop'
      ? normalizeThreadId(session.sdk_session_id)
      : undefined);
}

export function isDesktopBackedSession(
  session: SessionLike | null | undefined,
  desktopLookup?: DesktopThreadLookup,
): boolean {
  const desktopThreadId = getExplicitDesktopThreadId(session);
  if (!desktopThreadId) return false;
  return desktopLookup ? desktopLookup(desktopThreadId) : true;
}

export function classifyInteractiveTurn(
  binding: BindingLike,
  session: SessionLike | null | undefined,
  desktopLookup?: DesktopThreadLookup,
): BridgeTurnClassification {
  const sessionId = session?.id || binding.codepilotSessionId;
  const codexThreadId = getCodexThreadId(session, binding);
  const desktopThreadId = getExplicitDesktopThreadId(session);

  if (desktopThreadId) {
    const desktopAvailable = desktopLookup ? desktopLookup(desktopThreadId) : true;
    return {
      kind: desktopAvailable ? 'im_desktop_reuse' : 'im_sdk',
      sessionId,
      codexThreadId,
      desktopThreadId,
      desktopAvailable,
      reason: desktopAvailable ? 'desktop_thread' : 'desktop_thread_missing',
    };
  }

  return {
    kind: 'im_sdk',
    sessionId,
    codexThreadId,
    desktopAvailable: false,
    reason: codexThreadId ? 'bridge_thread' : 'new_bridge_thread',
  };
}
