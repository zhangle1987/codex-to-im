/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codex-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from './lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from './lib/bridge/types.js';
import { CTI_HOME, configToSettings, findChannelInstance, loadConfig } from './config.js';
import { withFileLock, withFileLocks } from './file-lock.js';
import { atomicWriteFileSync } from './atomic-file.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const BINDINGS_PATH = path.join(DATA_DIR, 'bindings.json');
const PERMISSIONS_PATH = path.join(DATA_DIR, 'permissions.json');
const OFFSETS_PATH = path.join(DATA_DIR, 'offsets.json');
const DEDUP_PATH = path.join(DATA_DIR, 'dedup.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.json');
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;
const INBOUND_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  atomicWriteFileSync(filePath, data);
}

function dedupTtlMs(key: string): number {
  return key.startsWith('inbound:') ? INBOUND_DEDUP_TTL_MS : DEFAULT_DEDUP_TTL_MS;
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`无法读取 JSON 数据文件 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function defaultAliasForProvider(provider: string | undefined): string | undefined {
  if (provider === 'feishu') return '飞书';
  if (provider === 'weixin') return '微信';
  return undefined;
}

// One-time upgrade path for bindings created before v2 channel instances.
// Runtime should read and write v2 bindings only; legacy singleton ids are
// rewritten to instance ids the first time they are encountered on disk.
function upgradeLegacyBinding(binding: ChannelBinding): ChannelBinding {
  const config = loadConfig();
  const exactInstance = findChannelInstance(binding.channelType, config);
  const hasInstanceMetadata = Boolean(binding.channelProvider || binding.channelAlias);
  const legacyProvider = !exactInstance
    && !hasInstanceMetadata
    && (binding.channelType === 'feishu' || binding.channelType === 'weixin')
    ? binding.channelType
    : undefined;
  const resolvedInstance = exactInstance
    || (legacyProvider
      ? (config.channels || []).find((channel) => channel.provider === legacyProvider)
      : undefined);

  if (!resolvedInstance && !legacyProvider) {
    return {
      ...binding,
      active: binding.active !== false,
    };
  }

  const channelType = resolvedInstance?.id || binding.channelType;
  const channelProvider = resolvedInstance?.provider || legacyProvider || binding.channelProvider;
  const channelAlias = resolvedInstance?.alias || binding.channelAlias || defaultAliasForProvider(channelProvider);

  return {
    ...binding,
    channelType,
    channelProvider,
    channelAlias,
    active: binding.active !== false,
  };
}

function didBindingChange(before: ChannelBinding, after: ChannelBinding): boolean {
  return before.channelType !== after.channelType
    || before.channelProvider !== after.channelProvider
    || before.channelAlias !== after.channelAlias
    || (before.active !== false) !== after.active;
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private dynamicSettings: boolean;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(
    settingsMap: Map<string, string>,
    options?: { dynamicSettings?: boolean },
  ) {
    this.settings = settingsMap;
    this.dynamicSettings = options?.dynamicSettings === true;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    this.reloadSessions();
    this.reloadBindings();

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      PERMISSIONS_PATH,
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      OFFSETS_PATH,
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      DEDUP_PATH,
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(AUDIT_PATH, []);
  }

  private reloadSessions(): void {
    const sessions = readJson<Record<string, BridgeSession>>(
      SESSIONS_PATH,
      {},
    );
    this.sessions = new Map(Object.entries(sessions));
  }

  private reloadBindings(): void {
    const bindings = readJson<Record<string, ChannelBinding>>(
      BINDINGS_PATH,
      {},
    );
    const normalized = new Map<string, ChannelBinding>();
    let changed = false;

    for (const binding of Object.values(bindings)) {
      const normalizedBinding = upgradeLegacyBinding(binding);
      if (didBindingChange(binding, normalizedBinding)) {
        changed = true;
      }

      normalized.set(`${normalizedBinding.channelType}:${normalizedBinding.chatId}`, normalizedBinding);
    }

    this.bindings = normalized;
    if (changed) {
      withFileLock(BINDINGS_PATH, () => {
        const latest = readJson<Record<string, ChannelBinding>>(BINDINGS_PATH, {});
        this.bindings = new Map(Object.values(latest).map((binding) => {
          const upgraded = upgradeLegacyBinding(binding);
          return [`${upgraded.channelType}:${upgraded.chatId}`, upgraded];
        }));
        this.persistBindings();
      });
    }
  }

  private reloadPermissions(): void {
    this.permissionLinks = new Map(Object.entries(
      readJson<Record<string, PermissionLinkRecord>>(PERMISSIONS_PATH, {}),
    ));
  }

  private reloadOffsets(): void {
    this.offsets = new Map(Object.entries(readJson<Record<string, string>>(OFFSETS_PATH, {})));
  }

  private reloadDedup(): void {
    this.dedupKeys = new Map(Object.entries(readJson<Record<string, number>>(DEDUP_PATH, {})));
  }

  private reloadAudit(): void {
    this.auditLog = readJson(AUDIT_PATH, []);
  }

  private persistSessions(): void {
    writeJson(
      SESSIONS_PATH,
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      BINDINGS_PATH,
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      PERMISSIONS_PATH,
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      OFFSETS_PATH,
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      DEDUP_PATH,
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(AUDIT_PATH, this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  private mutateBindings<T>(mutation: () => T): T {
    return withFileLock(BINDINGS_PATH, () => {
      this.reloadBindings();
      const result = mutation();
      this.persistBindings();
      return result;
    });
  }

  private mutateSessions<T>(mutation: () => T): T {
    return withFileLock(SESSIONS_PATH, () => {
      this.reloadSessions();
      const result = mutation();
      this.persistSessions();
      return result;
    });
  }

  private mutateMessages<T>(sessionId: string, mutation: (messages: BridgeMessage[]) => T): T {
    const messagePath = path.join(MESSAGES_DIR, `${sessionId}.json`);
    return withFileLock(messagePath, () => {
      const messages = readJson<BridgeMessage[]>(messagePath, []);
      this.messages.set(sessionId, messages);
      const result = mutation(messages);
      this.persistMessages(sessionId);
      return result;
    });
  }

  // ── Settings ──

  private refreshSettings(): void {
    if (!this.dynamicSettings) return;
    try {
      const next = configToSettings(loadConfig());
      this.settings = new Map([
        ...this.settings,
        ...next,
      ]);
    } catch {
      // Keep the last known settings if the config file is temporarily unreadable.
    }
  }

  getSetting(key: string): string | null {
    this.refreshSettings();
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    this.reloadBindings();
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    return this.mutateBindings(() => {
      const key = `${data.channelType}:${data.chatId}`;
      const existing = this.bindings.get(key);
      if (existing) {
        const updated: ChannelBinding = {
          ...existing,
          codepilotSessionId: data.codepilotSessionId,
          sdkSessionId: data.sdkSessionId ?? existing.sdkSessionId,
          channelProvider: data.channelProvider ?? existing.channelProvider,
          channelAlias: data.channelAlias ?? existing.channelAlias,
          chatUserId: data.chatUserId ?? existing.chatUserId,
          chatDisplayName: data.chatDisplayName ?? existing.chatDisplayName,
          workingDirectory: data.workingDirectory,
          model: data.model,
          mode: (data.mode as ChannelBinding['mode']) ?? existing.mode,
          updatedAt: now(),
        };
        this.bindings.set(key, updated);
        return updated;
      }
      const binding: ChannelBinding = {
        id: uuid(),
        channelType: data.channelType,
        channelProvider: data.channelProvider,
        channelAlias: data.channelAlias,
        chatId: data.chatId,
        chatUserId: data.chatUserId,
        chatDisplayName: data.chatDisplayName,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId ?? '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: (data.mode as 'code' | 'plan' | 'ask') || (this.getSetting('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
        active: true,
        createdAt: now(),
        updatedAt: now(),
      };
      this.bindings.set(key, binding);
      return binding;
    });
  }

  deleteChannelBinding(id: string): void {
    this.mutateBindings(() => {
      for (const [key, binding] of this.bindings) {
        if (binding.id !== id) continue;
        this.bindings.delete(key);
        return;
      }
    });
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    this.mutateBindings(() => {
      for (const [key, b] of this.bindings) {
        if (b.id === id) {
          this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
          break;
        }
      }
    });
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    this.reloadBindings();
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    this.reloadSessions();
    return this.sessions.get(id) ?? null;
  }

  listSessions(): BridgeSession[] {
    this.reloadSessions();
    return Array.from(this.sessions.values());
  }

  findSessionBySdkSessionId(sdkSessionId: string): BridgeSession | null {
    this.reloadSessions();
    for (const session of this.sessions.values()) {
      if (
        session.sdk_session_id === sdkSessionId
        || session.codex_thread_id === sdkSessionId
        || session.desktop_thread_id === sdkSessionId
      ) {
        return session;
      }
    }
    return null;
  }

  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    mode?: string,
    options?: {
      reasoningEffort?: BridgeSession['reasoning_effort'];
      sessionType?: BridgeSession['session_type'];
      hidden?: boolean;
      parentSessionId?: string;
      expiresAt?: string;
    },
  ): BridgeSession {
    return this.mutateSessions(() => {
      const timestamp = now();
      const session: BridgeSession = {
        id: uuid(),
        name,
        working_directory: cwd || process.cwd(),
        model,
        preferred_mode: mode as BridgeSession['preferred_mode'],
        system_prompt: systemPrompt,
        reasoning_effort: options?.reasoningEffort,
        session_type: options?.sessionType || 'normal',
        hidden: options?.hidden === true,
        parent_session_id: options?.parentSessionId,
        expires_at: options?.expiresAt,
        created_at: timestamp,
        updated_at: timestamp,
      };
      this.sessions.set(session.id, session);
      return session;
    });
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    this.mutateSessions(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.provider_id = providerId;
      s.updated_at = now();
    });
  }

  updateSession(sessionId: string, updates: Partial<BridgeSession>, options?: { touch?: boolean }): void {
    this.mutateSessions(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const next: BridgeSession = {
        ...session,
        ...updates,
        id: session.id,
        updated_at: options?.touch === false ? session.updated_at : now(),
      };
      this.sessions.set(sessionId, next);
    });
  }

  deleteSession(sessionId: string): void {
    const messagePath = path.join(MESSAGES_DIR, `${sessionId}.json`);
    withFileLocks([SESSIONS_PATH, BINDINGS_PATH, messagePath], () => {
      this.reloadSessions();
      this.reloadBindings();
      this.sessions.delete(sessionId);
      for (const [key, binding] of this.bindings) {
        if (binding.codepilotSessionId === sessionId) {
          this.bindings.delete(key);
        }
      }
      this.messages.delete(sessionId);
      try { fs.rmSync(messagePath, { force: true }); } catch { /* best effort */ }
      this.persistSessions();
      this.persistBindings();
    });
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    this.mutateMessages(sessionId, (messages) => {
      messages.push({ role, content });
    });
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const messagePath = path.join(MESSAGES_DIR, `${sessionId}.json`);
    const msgs = readJson<BridgeMessage[]>(messagePath, []);
    this.messages.set(sessionId, msgs);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    this.mutateSessions(() => {
      const session = this.sessions.get(_sessionId);
      if (!session) return;

      const queuedCount = session.queued_count && session.queued_count > 0
        ? session.queued_count
        : 0;
      let runtimeStatus: BridgeSession['runtime_status'];

      if (_status === 'running') {
        runtimeStatus = queuedCount > 0 ? 'queued' : 'running';
      } else if (_status === 'idle') {
        runtimeStatus = queuedCount > 0 ? 'queued' : 'idle';
      } else {
        runtimeStatus = session.runtime_status;
      }

      const next: BridgeSession = {
        ...session,
        runtime_status: runtimeStatus,
        last_runtime_update_at: now(),
        updated_at: now(),
      };
      this.sessions.set(_sessionId, next);
    });
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    withFileLocks([SESSIONS_PATH, BINDINGS_PATH], () => {
      this.reloadSessions();
      this.reloadBindings();
      const s = this.sessions.get(sessionId);
      if (s) {
        s.sdk_session_id = sdkSessionId;
        if (sdkSessionId) {
          s.codex_thread_id = sdkSessionId;
          s.thread_origin = s.thread_origin || 'bridge';
        } else {
          delete s.codex_thread_id;
          if (s.thread_origin !== 'desktop') {
            delete s.thread_origin;
          }
        }
        s.updated_at = now();
      }
      for (const [key, b] of this.bindings) {
        if (b.codepilotSessionId === sessionId) {
          this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
        }
      }
      this.persistSessions();
      this.persistBindings();
    });
  }

  updateSessionModel(sessionId: string, model: string): void {
    this.mutateSessions(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.model = model;
      s.updated_at = now();
    });
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    withFileLock(AUDIT_PATH, () => {
      this.reloadAudit();
      this.auditLog.push({
        ...entry,
        id: uuid(),
        createdAt: now(),
      });
      if (this.auditLog.length > 1000) {
        this.auditLog = this.auditLog.slice(-1000);
      }
      this.persistAudit();
    });
  }

  checkDedup(key: string): boolean {
    this.reloadDedup();
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > dedupTtlMs(key)) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    withFileLock(DEDUP_PATH, () => {
      this.reloadDedup();
      this.dedupKeys.set(key, Date.now());
      this.persistDedup();
    });
  }

  cleanupExpiredDedup(): void {
    withFileLock(DEDUP_PATH, () => {
      this.reloadDedup();
      const timestamp = Date.now();
      let changed = false;
      for (const [key, ts] of this.dedupKeys) {
        if (timestamp - ts > dedupTtlMs(key)) {
          this.dedupKeys.delete(key);
          changed = true;
        }
      }
      if (changed) this.persistDedup();
    });
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    withFileLock(PERMISSIONS_PATH, () => {
      this.reloadPermissions();
      const record: PermissionLinkRecord = {
        permissionRequestId: link.permissionRequestId,
        chatId: link.chatId,
        messageId: link.messageId,
        sessionId: link.sessionId,
        resolved: false,
        suggestions: link.suggestions,
      };
      this.permissionLinks.set(link.permissionRequestId, record);
      this.persistPermissions();
    });
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    this.reloadPermissions();
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    return withFileLock(PERMISSIONS_PATH, () => {
      this.reloadPermissions();
      const link = this.permissionLinks.get(permissionRequestId);
      if (!link || link.resolved) return false;
      link.resolved = true;
      this.persistPermissions();
      return true;
    });
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    this.reloadPermissions();
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    this.reloadOffsets();
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    withFileLock(OFFSETS_PATH, () => {
      this.reloadOffsets();
      this.offsets.set(key, offset);
      this.persistOffsets();
    });
  }
}
