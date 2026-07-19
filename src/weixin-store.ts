import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { CTI_HOME } from './config.js';
import { withFileLock, withFileLocks } from './file-lock.js';

export interface WeixinAccountRecord {
  accountId: string;
  userId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  name: string;
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const DATA_DIR = path.join(CTI_HOME, 'data');
// Keep the historical plural filename for compatibility.
const ACCOUNTS_PATH = path.join(DATA_DIR, 'weixin-accounts.json');
const CONTEXT_TOKENS_PATH = path.join(DATA_DIR, 'weixin-context-tokens.json');
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new Error(`无法读取微信数据文件 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function now(): string {
  return new Date().toISOString();
}

function getAccountRecency(account: WeixinAccountRecord): string {
  return account.lastLoginAt ?? account.updatedAt ?? account.createdAt;
}

function sortAccountsByRecency(accounts: WeixinAccountRecord[]): WeixinAccountRecord[] {
  return [...accounts].sort((a, b) => {
    const recencyDiff = getAccountRecency(b).localeCompare(getAccountRecency(a));
    if (recencyDiff !== 0) return recencyDiff;

    const updatedDiff = b.updatedAt.localeCompare(a.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    const createdDiff = b.createdAt.localeCompare(a.createdAt);
    if (createdDiff !== 0) return createdDiff;

    return 0;
  });
}

function normalizeAccounts(accounts: WeixinAccountRecord[]): WeixinAccountRecord[] {
  const deduped = new Map<string, WeixinAccountRecord>();
  for (const account of sortAccountsByRecency(accounts)) {
    if (!account?.accountId || deduped.has(account.accountId)) continue;
    deduped.set(account.accountId, account);
  }
  return Array.from(deduped.values());
}

function persistAccounts(accounts: WeixinAccountRecord[]): WeixinAccountRecord[] {
  ensureDir(DATA_DIR);
  const normalized = normalizeAccounts(accounts);
  atomicWrite(ACCOUNTS_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

function readStoredAccounts(): WeixinAccountRecord[] {
  ensureDir(DATA_DIR);
  const raw = readJson<unknown>(ACCOUNTS_PATH, []);
  return Array.isArray(raw) ? raw as WeixinAccountRecord[] : [];
}

function readAccounts(): WeixinAccountRecord[] {
  return normalizeAccounts(readStoredAccounts());
}

function writeAccounts(accounts: WeixinAccountRecord[]): void {
  persistAccounts(accounts);
}

function readContextTokens(): Record<string, string> {
  ensureDir(DATA_DIR);
  return readJson<Record<string, string>>(CONTEXT_TOKENS_PATH, {});
}

function writeContextTokens(tokens: Record<string, string>): void {
  ensureDir(DATA_DIR);
  atomicWrite(CONTEXT_TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function contextKey(accountId: string, peerUserId: string): string {
  return `${accountId}::${peerUserId}`;
}

export function listWeixinAccounts(): WeixinAccountRecord[] {
  return sortAccountsByRecency(readAccounts());
}

export function getWeixinAccount(accountId: string): WeixinAccountRecord | undefined {
  return readAccounts().find((account) => account.accountId === accountId);
}

export function upsertWeixinAccount(params: {
  accountId: string;
  userId?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  token?: string;
  name?: string;
  enabled?: boolean;
}): WeixinAccountRecord {
  return withFileLock(ACCOUNTS_PATH, () => {
    const accounts = readAccounts();
    const existing = accounts.find((account) => account.accountId === params.accountId);
    const timestamp = now();

    const account: WeixinAccountRecord = existing
      ? {
          ...existing,
          userId: params.userId ?? existing.userId,
          baseUrl: params.baseUrl ?? existing.baseUrl,
          cdnBaseUrl: params.cdnBaseUrl ?? existing.cdnBaseUrl,
          token: params.token ?? existing.token,
          name: params.name ?? existing.name,
          enabled: params.enabled ?? existing.enabled,
          lastLoginAt: timestamp,
          updatedAt: timestamp,
        }
      : {
          accountId: params.accountId,
          userId: params.userId ?? '',
          baseUrl: params.baseUrl ?? DEFAULT_BASE_URL,
          cdnBaseUrl: params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
          token: params.token ?? '',
          name: params.name ?? params.accountId,
          enabled: params.enabled ?? true,
          lastLoginAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    writeAccounts([
      account,
      ...accounts.filter((item) => item.accountId !== account.accountId),
    ]);
    return account;
  });
}

export function deleteWeixinAccount(accountId: string): boolean {
  return withFileLocks([ACCOUNTS_PATH, CONTEXT_TOKENS_PATH], () => {
    const accounts = readAccounts();
    const nextAccounts = accounts.filter((account) => account.accountId !== accountId);
    if (nextAccounts.length === accounts.length) return false;
    writeAccounts(nextAccounts);
    const tokens = readContextTokens();
    writeContextTokens(Object.fromEntries(
      Object.entries(tokens).filter(([key]) => !key.startsWith(`${accountId}::`)),
    ));
    return true;
  });
}

export function setWeixinAccountEnabled(accountId: string, enabled: boolean): boolean {
  return withFileLock(ACCOUNTS_PATH, () => {
    const accounts = readAccounts();
    let changed = false;
    const nextAccounts = accounts.map((account) => {
      if (account.accountId !== accountId) return account;
      changed = true;
      return {
        ...account,
        enabled,
        updatedAt: now(),
      };
    });

    if (changed) writeAccounts(nextAccounts);
    return changed;
  });
}

export function getWeixinContextToken(accountId: string, peerUserId: string): string | undefined {
  const tokens = readContextTokens();
  return tokens[contextKey(accountId, peerUserId)];
}

export function upsertWeixinContextToken(accountId: string, peerUserId: string, contextToken: string): void {
  withFileLock(CONTEXT_TOKENS_PATH, () => {
    const tokens = readContextTokens();
    tokens[contextKey(accountId, peerUserId)] = contextToken;
    writeContextTokens(tokens);
  });
}

export function deleteWeixinContextTokensByAccount(accountId: string): void {
  withFileLock(CONTEXT_TOKENS_PATH, () => {
    const tokens = readContextTokens();
    const nextTokens = Object.fromEntries(
      Object.entries(tokens).filter(([key]) => !key.startsWith(`${accountId}::`)),
    );
    writeContextTokens(nextTokens);
  });
}

export function getWeixinAccountsFilePath(): string {
  return ACCOUNTS_PATH;
}
