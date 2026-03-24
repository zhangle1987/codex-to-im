import path from 'node:path';

import type { BridgeSession, BridgeStore } from './lib/bridge/host.js';
import type { ChannelBinding } from './lib/bridge/types.js';
import { getDesktopSessionByThreadId, listDesktopSessions, type DesktopSessionSummary } from './desktop-sessions.js';

export interface BindingTargetOption {
  key: string;
  kind: 'desktop' | 'session';
  id: string;
  label: string;
  description: string;
}

export interface BindingSummary {
  id: string;
  channelType: string;
  chatId: string;
  mode: ChannelBinding['mode'];
  model: string;
  workingDirectory: string;
  currentTargetKey: string;
  currentTargetLabel: string;
  currentSessionId: string;
  currentSessionName: string;
  currentThreadId?: string;
}

function getSessionName(session: BridgeSession): string {
  if (session.name?.trim()) return session.name.trim();
  if (session.working_directory) return path.basename(session.working_directory);
  return session.id.slice(0, 8);
}

function getSessionDescription(session: BridgeSession): string {
  return session.working_directory || '(no working directory)';
}

export function bindStoreToSession(
  store: BridgeStore,
  channelType: string,
  chatId: string,
  sessionId: string,
): ChannelBinding | null {
  const session = store.getSession(sessionId);
  if (!session) return null;

  return store.upsertChannelBinding({
    channelType,
    chatId,
    codepilotSessionId: session.id,
    sdkSessionId: session.sdk_session_id || '',
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

export function bindStoreToSdkSession(
  store: BridgeStore,
  channelType: string,
  chatId: string,
  sdkSessionId: string,
  opts?: { workingDirectory?: string; model?: string; displayName?: string },
): ChannelBinding {
  const existing = store.findSessionBySdkSessionId(sdkSessionId);
  if (existing) {
    return store.upsertChannelBinding({
      channelType,
      chatId,
      codepilotSessionId: existing.id,
      sdkSessionId,
      workingDirectory: opts?.workingDirectory || existing.working_directory,
      model: opts?.model || existing.model,
    });
  }

  const workingDirectory = opts?.workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const model = opts?.model || store.getSetting('bridge_default_model') || '';
  const baseName = opts?.displayName
    || (workingDirectory ? path.basename(workingDirectory) : sdkSessionId.slice(0, 8));

  const session = store.createSession(
    `Desktop: ${baseName}`,
    model,
    undefined,
    workingDirectory,
    'code',
  );
  store.updateSdkSessionId(session.id, sdkSessionId);

  return store.upsertChannelBinding({
    channelType,
    chatId,
    codepilotSessionId: session.id,
    sdkSessionId,
    workingDirectory: workingDirectory || session.working_directory,
    model: model || session.model,
  });
}

export function listBindingTargetOptions(
  store: BridgeStore,
  desktopLimit = 12,
): BindingTargetOption[] {
  const desktopOptions = listDesktopSessions(desktopLimit).map((session) => ({
    key: `desktop:${session.threadId}`,
    kind: 'desktop' as const,
    id: session.threadId,
    label: `[Desktop] ${session.title}`,
    description: `${session.threadId.slice(0, 8)}... · ${session.cwd || '(no cwd)'}`,
  }));

  const sessionOptions = store.listSessions().map((session) => ({
    key: `session:${session.id}`,
    kind: 'session' as const,
    id: session.id,
    label: `[Internal] ${getSessionName(session)}`,
    description: `${session.id.slice(0, 8)}... · ${getSessionDescription(session)}${session.sdk_session_id ? ` · thread ${session.sdk_session_id.slice(0, 8)}...` : ''}`,
  }));

  return [...desktopOptions, ...sessionOptions];
}

export function listBindingSummaries(store: BridgeStore): BindingSummary[] {
  return store.listChannelBindings().map((binding) => {
    const session = store.getSession(binding.codepilotSessionId);
    const currentThreadId = binding.sdkSessionId || session?.sdk_session_id || undefined;
    const currentTargetKey = currentThreadId ? `desktop:${currentThreadId}` : `session:${binding.codepilotSessionId}`;
    const currentTargetLabel = currentThreadId
      ? `Desktop thread ${currentThreadId.slice(0, 8)}...`
      : `Internal session ${binding.codepilotSessionId.slice(0, 8)}...`;

    return {
      id: binding.id,
      channelType: binding.channelType,
      chatId: binding.chatId,
      mode: binding.mode,
      model: binding.model,
      workingDirectory: binding.workingDirectory,
      currentTargetKey,
      currentTargetLabel,
      currentSessionId: binding.codepilotSessionId,
      currentSessionName: session ? getSessionName(session) : binding.codepilotSessionId.slice(0, 8),
      currentThreadId,
    };
  }).sort((a, b) => {
    if (a.channelType !== b.channelType) return a.channelType.localeCompare(b.channelType);
    return a.chatId.localeCompare(b.chatId);
  });
}

export function updateBindingTarget(
  store: BridgeStore,
  bindingId: string,
  targetKey: string,
): BindingSummary {
  const binding = store.listChannelBindings().find((item) => item.id === bindingId);
  if (!binding) {
    throw new Error('Binding not found.');
  }

  if (targetKey.startsWith('desktop:')) {
    const threadId = targetKey.slice('desktop:'.length);
    const desktop = getDesktopSessionByThreadId(threadId);
    bindStoreToSdkSession(store, binding.channelType, binding.chatId, threadId, desktop ? {
      workingDirectory: desktop.cwd,
      displayName: desktop.title,
    } : {
      workingDirectory: binding.workingDirectory,
    });
  } else if (targetKey.startsWith('session:')) {
    const sessionId = targetKey.slice('session:'.length);
    const updated = bindStoreToSession(store, binding.channelType, binding.chatId, sessionId);
    if (!updated) {
      throw new Error('Session not found.');
    }
  } else {
    throw new Error('Unsupported target.');
  }

  const updated = listBindingSummaries(store).find((item) => item.id === bindingId);
  if (!updated) {
    throw new Error('Updated binding not found.');
  }
  return updated;
}

export function getChannelBindingSummaries(
  store: BridgeStore,
  channelType: string,
): BindingSummary[] {
  return listBindingSummaries(store).filter((binding) => binding.channelType === channelType);
}

export function getDesktopCandidateForThread(threadId: string): DesktopSessionSummary | null {
  return getDesktopSessionByThreadId(threadId);
}
