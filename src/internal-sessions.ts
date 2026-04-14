import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from './config.js';
import type { BridgeSession, BridgeStore } from './lib/bridge/host.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HIDDEN_DRAFT_SESSIONS = 64;
const INTERNAL_SESSION_ROOT = path.join(CTI_HOME, 'runtime', 'internal-sessions');
const DRAFT_SESSION_PREFIX = 'Draft';

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizePathSlug(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scratch';
}

export function isSessionExpired(session: BridgeSession | null | undefined): boolean {
  if (!session?.expires_at) return false;
  const expiresAt = Date.parse(session.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export function getInternalScratchDir(kind: 'draft', key: string): string {
  const dir = path.join(INTERNAL_SESSION_ROOT, kind, sanitizePathSlug(key));
  ensureDirectory(dir);
  return dir;
}

export function makeDraftSessionName(address: { channelType: string; chatId: string }): string {
  return `${DRAFT_SESSION_PREFIX}:${address.channelType}:${address.chatId}`;
}

export function cleanupHiddenSessions(store: BridgeStore): void {
  const bindings = store.listChannelBindings();
  const boundSessionIds = new Set(bindings.map((binding) => binding.codepilotSessionId));
  const hiddenSessions = store.listSessions().filter((session) => session.hidden === true);

  for (const session of hiddenSessions) {
    if (isSessionExpired(session) && !boundSessionIds.has(session.id)) {
      store.deleteSession(session.id);
    }
  }

  const draftSessions = store.listSessions()
    .filter((session) => session.hidden === true && session.session_type === 'draft' && !boundSessionIds.has(session.id))
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || '') - Date.parse(a.updated_at || a.created_at || ''));

  for (const session of draftSessions.slice(MAX_HIDDEN_DRAFT_SESSIONS)) {
    store.deleteSession(session.id);
  }
}

export function getOrCreateDraftSession(
  store: BridgeStore,
  address: { channelType: string; chatId: string },
): BridgeSession {
  cleanupHiddenSessions(store);
  const expectedName = makeDraftSessionName(address);
  const existing = store.listSessions().find((session) =>
    session.hidden === true
    && session.session_type === 'draft'
    && session.name === expectedName
    && !isSessionExpired(session)
  );

  if (existing) {
    store.updateSession(existing.id, {
      preferred_mode: 'ask',
      expires_at: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
    });
    return store.getSession(existing.id) || existing;
  }

  const scratchDir = getInternalScratchDir('draft', `${address.channelType}-${address.chatId}`);
  return store.createSession(
    expectedName,
    store.getSetting('bridge_default_model') || '',
    undefined,
    scratchDir,
    'ask',
    {
      hidden: true,
      sessionType: 'draft',
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
      reasoningEffort: 'low',
    },
  );
}

export function resetDraftSession(
  store: BridgeStore,
  address: { channelType: string; chatId: string },
): BridgeSession {
  const expectedName = makeDraftSessionName(address);
  for (const session of store.listSessions()) {
    if (session.hidden === true && session.session_type === 'draft' && session.name === expectedName) {
      store.deleteSession(session.id);
    }
  }
  return getOrCreateDraftSession(store, address);
}
