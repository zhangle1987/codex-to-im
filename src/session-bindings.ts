import path from 'node:path';

import type { BridgeSession, BridgeStore } from './lib/bridge/host.js';
import type { ChannelBinding } from './lib/bridge/types.js';
import {
  getDesktopSessionByThreadId,
  isArchivedDesktopThread,
  listDesktopSessions,
  type DesktopSessionSummary,
} from './desktop-sessions.js';

export interface BindingTargetOption {
  key: string;
  kind: 'desktop';
  id: string;
  label: string;
  description: string;
  cwd: string;
  threadId: string;
}

export interface BindingSummary {
  id: string;
  channelType: string;
  chatId: string;
  chatUserId?: string;
  chatDisplayName?: string;
  mode: ChannelBinding['mode'];
  model: string;
  workingDirectory: string;
  currentTargetKey: string;
  currentTargetLabel: string;
  currentSessionId: string;
  currentSessionName: string;
  currentThreadId?: string;
  runtimeStatus?: BridgeSession['runtime_status'];
  queuedCount?: number;
  mirrorStatus?: BridgeSession['mirror_status'];
  mirrorLastEventAt?: string;
}

function formatChannelLabel(channelType: string): string {
  return channelType === 'weixin' ? '微信' : channelType === 'feishu' ? '飞书' : channelType;
}

function formatBindingChatTarget(binding: ChannelBinding): string {
  return binding.chatDisplayName?.trim() || binding.chatId;
}

function findConflictingBinding(
  store: BridgeStore,
  current: { channelType: string; chatId: string },
  match: (binding: ChannelBinding) => boolean,
): ChannelBinding | null {
  return store.listChannelBindings().find((binding) => {
    if (binding.channelType === current.channelType && binding.chatId === current.chatId) {
      return false;
    }
    return match(binding);
  }) || null;
}

function assertBindingTargetAvailable(
  store: BridgeStore,
  current: { channelType: string; chatId: string },
  opts: { sessionId?: string; sdkSessionId?: string },
): void {
  const conflict = findConflictingBinding(
    store,
    current,
    (binding) => (
      (opts.sessionId ? binding.codepilotSessionId === opts.sessionId : false)
      || (opts.sdkSessionId ? binding.sdkSessionId === opts.sdkSessionId : false)
    ),
  );

  if (!conflict) return;

  throw new Error(
    `该会话已绑定到 ${formatChannelLabel(conflict.channelType)} 聊天 ${formatBindingChatTarget(conflict)}。一个会话只能绑定一个聊天。`,
  );
}

function getSessionName(session: BridgeSession): string {
  if (session.session_type === 'draft') return '临时草稿线程';
  if (session.session_type === 'history_summary') return '历史摘要线程';
  if (session.name?.trim()) return session.name.trim();
  if (session.working_directory) return path.basename(session.working_directory);
  return session.id.slice(0, 8);
}

function getSessionMode(store: BridgeStore, session: BridgeSession): ChannelBinding['mode'] {
  return session.preferred_mode
    || (store.getSetting('bridge_default_mode') as ChannelBinding['mode'])
    || 'code';
}

export function bindStoreToSession(
  store: BridgeStore,
  channelType: string,
  chatId: string,
  sessionId: string,
): ChannelBinding | null {
  const session = store.getSession(sessionId);
  if (!session) return null;

  assertBindingTargetAvailable(
    store,
    { channelType, chatId },
    { sessionId: session.id, sdkSessionId: session.sdk_session_id || undefined },
  );

  return store.upsertChannelBinding({
    channelType,
    chatId,
    codepilotSessionId: session.id,
    sdkSessionId: session.sdk_session_id || '',
    workingDirectory: session.working_directory,
    model: session.model,
    mode: getSessionMode(store, session),
  });
}

export function bindStoreToSdkSession(
  store: BridgeStore,
  channelType: string,
  chatId: string,
  sdkSessionId: string,
  opts?: { workingDirectory?: string; model?: string; displayName?: string },
): ChannelBinding {
  assertBindingTargetAvailable(
    store,
    { channelType, chatId },
    { sdkSessionId },
  );

  const existing = store.findSessionBySdkSessionId(sdkSessionId);
  if (existing) {
      return store.upsertChannelBinding({
        channelType,
        chatId,
        codepilotSessionId: existing.id,
        sdkSessionId,
        workingDirectory: opts?.workingDirectory || existing.working_directory,
        model: opts?.model || existing.model,
        mode: getSessionMode(store, existing),
      });
  }

  const workingDirectory = opts?.workingDirectory
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
    mode: getSessionMode(store, session),
  });
}

export function listBindingTargetOptions(
  _store: BridgeStore,
  desktopLimit = 12,
): BindingTargetOption[] {
  return listDesktopSessions(desktopLimit).map((session) => ({
    key: `desktop:${session.threadId}`,
    kind: 'desktop',
    id: session.threadId,
    label: session.title,
    description: `${session.threadId.slice(0, 8)}... · ${session.cwd || '(no cwd)'}`,
    cwd: session.cwd,
    threadId: session.threadId,
  }));
}

export function listBindingSummaries(store: BridgeStore): BindingSummary[] {
  return store.listChannelBindings().map((binding) => {
    const session = store.getSession(binding.codepilotSessionId);
    const currentThreadId = binding.sdkSessionId || session?.sdk_session_id || undefined;
    const desktop = currentThreadId ? getDesktopSessionByThreadId(currentThreadId) : null;
    const archived = currentThreadId ? isArchivedDesktopThread(currentThreadId) : false;
    const currentTargetKey = currentThreadId ? `desktop:${currentThreadId}` : `session:${binding.codepilotSessionId}`;
    const currentTargetLabel = currentThreadId
      ? (desktop?.title || (archived ? `已归档桌面线程 ${currentThreadId.slice(0, 8)}...` : `Desktop thread ${currentThreadId.slice(0, 8)}...`))
      : getSessionName(session || {
          id: binding.codepilotSessionId,
          working_directory: binding.workingDirectory,
          model: binding.model,
        });

    return {
      id: binding.id,
      channelType: binding.channelType,
      chatId: binding.chatId,
      chatUserId: binding.chatUserId,
      chatDisplayName: binding.chatDisplayName,
      mode: binding.mode,
      model: binding.model,
      workingDirectory: binding.workingDirectory,
      currentTargetKey,
      currentTargetLabel,
      currentSessionId: binding.codepilotSessionId,
      currentSessionName: session ? getSessionName(session) : binding.codepilotSessionId.slice(0, 8),
      currentThreadId,
      runtimeStatus: session?.runtime_status,
      queuedCount: session?.queued_count,
      mirrorStatus: session?.mirror_status,
      mirrorLastEventAt: session?.mirror_last_event_at,
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

export function removeBinding(
  store: BridgeStore,
  bindingId: string,
): void {
  const binding = store.listChannelBindings().find((item) => item.id === bindingId);
  if (!binding) {
    throw new Error('Binding not found.');
  }
  store.deleteChannelBinding(bindingId);
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
