import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';

import {
  CTI_HOME,
  DEFAULT_WORKSPACE_ROOT,
  configToSettings,
  feishuSiteToApiBaseUrl,
  findChannelInstance,
  loadConfig,
  normalizeFeishuSite,
  saveConfig,
  type ChannelInstance,
  type ChannelProvider,
  type Config,
  type FeishuChannelConfig,
  type FeishuSite,
  type WeixinChannelConfig,
} from './config.js';
import { PendingPermissions } from './permission-gateway.js';
import { CodexProvider } from './codex-provider.js';
import { getCodexSessionsRoot, listDesktopSessions } from './desktop-sessions.js';
import {
  type BindingSummary,
  listBindingSummaries,
  listBindingTargetOptions,
  removeBinding,
  updateBindingTarget,
} from './session-bindings.js';
import {
  getBridgeAutostartStatus,
  getBridgeLogs,
  getBridgeStatus,
  installCodexIntegration,
  isCodexIntegrationInstalled,
  getPackageRoot,
  getUiServerStatus,
  getUiServerUrl,
  restartBridge,
  startBridge,
  stopBridge,
  writeUiServerStatus,
} from './service-manager.js';
import { JsonFileStore } from './store.js';
import { runWeixinLogin } from './weixin-login.js';
import { listWeixinAccounts } from './weixin-store.js';
import { listSelectableCodexModels, readConfiguredCodexModel } from './codex-models.js';

let port = 4781;
const serverStartTime = new Date().toISOString();
const AUTH_COOKIE_NAME = 'cti_ui_auth';
const availableCodexModels = listSelectableCodexModels();
const availableCodexModelSlugs = new Set(availableCodexModels.map((model) => model.slug));
const FEISHU_CHAT_LABEL_TTL_MS = 5 * 60 * 1000;
const feishuChatLabelCache = new Map<string, { label: string; userId?: string; expiresAt: number }>();
const feishuTenantTokenCache = new Map<
  string,
  {
    token: string;
    expiresAt: number;
  }
>();

function parsePreferredPort(): number {
  const raw = Number(process.env.CTI_UI_PORT || '4781');
  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) return 4781;
  return raw;
}

async function canListen(portToCheck: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(portToCheck, '0.0.0.0', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function resolveUiPort(preferredPort: number): Promise<number> {
  const end = Math.min(preferredPort + 20, 65535);
  for (let candidate = preferredPort; candidate <= end; candidate += 1) {
    if (await canListen(candidate)) return candidate;
  }

  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const address = probe.address();
      const dynamicPort = typeof address === 'object' && address ? address.port : preferredPort;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(dynamicPort);
      });
    });
  });
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
}

function text(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) as T : {} as T;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsv(value: unknown): string[] | undefined {
  const text = asString(value);
  if (!text) return undefined;
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeChannelAlias(value: string | undefined, provider: ChannelProvider): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return provider === 'feishu' ? '飞书' : '微信';
}

function normalizeChannelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'channel';
}

function buildChannelId(provider: ChannelProvider, alias: string, takenIds: Set<string>, currentId?: string): string {
  const base = normalizeChannelId(`${provider}-${alias}`);
  if (!takenIds.has(base) || base === currentId) return base;
  let suffix = 2;
  while (takenIds.has(`${base}-${suffix}`) && `${base}-${suffix}` !== currentId) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function parseChannelProvider(value: unknown): ChannelProvider | undefined {
  if (value === 'feishu' || value === 'weixin') return value;
  return undefined;
}

function createUiStore(): JsonFileStore {
  return new JsonFileStore(configToSettings(loadConfig()));
}

function cloneChannel(channel: ChannelInstance): ChannelInstance {
  return {
    ...channel,
    config: { ...channel.config } as ChannelInstance['config'],
  };
}

function channelToPayload(channel: ChannelInstance) {
  return {
    id: channel.id,
    alias: channel.alias,
    provider: channel.provider,
    enabled: channel.enabled,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    config: { ...channel.config },
  };
}

function generateAccessToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function timingSafeMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const header = request.headers.cookie;
  if (!header) return new Map();

  return new Map(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return [part, ''];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function makeAuthCookie(token: string): string {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function redirect(response: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string | string[]> = { Location: location };
  if (cookie) headers['Set-Cookie'] = cookie;
  response.writeHead(302, headers);
  response.end();
}

function getRemoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress || '';
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function isLocalRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(getRemoteAddress(request));
}

function getLanUrls(currentPort: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls = new Set<string>();

  for (const records of Object.values(interfaces)) {
    for (const record of records || []) {
      if (!record || record.internal || record.family !== 'IPv4') continue;
      urls.add(`http://${record.address}:${currentPort}`);
    }
  }

  return Array.from(urls).sort();
}

function buildUiAccessInfo(currentPort: number, config: Config, request?: IncomingMessage) {
  return {
    allowLan: config.uiAllowLan === true,
    localUrl: getUiServerUrl(currentPort),
    lanUrls: getLanUrls(currentPort),
    accessToken: config.uiAccessToken || '',
    requestIsLocal: request ? isLocalRequest(request) : true,
    authenticated: request ? isRemoteAuthenticated(request, config) : true,
  };
}

function isRemoteAuthenticated(request: IncomingMessage, config: Config): boolean {
  if (isLocalRequest(request)) return true;
  if (config.uiAllowLan !== true) return false;
  return timingSafeMatch(parseCookies(request).get(AUTH_COOKIE_NAME), config.uiAccessToken);
}

function configToPayload(config: Config) {
  return {
    runtime: config.runtime,
    defaultWorkspaceRoot: config.defaultWorkspaceRoot || '',
    defaultModel: config.defaultModel || '',
    codexDefaultModel: readConfiguredCodexModel() || '',
    availableModels: availableCodexModels,
    defaultMode: config.defaultMode,
    historyMessageLimit: config.historyMessageLimit ?? 8,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck === true,
    codexSandboxMode: config.codexSandboxMode || 'workspace-write',
    codexReasoningEffort: config.codexReasoningEffort || 'medium',
    uiAllowLan: config.uiAllowLan === true,
    uiAccessToken: config.uiAccessToken || '',
    autoApprove: config.autoApprove === true,
    channels: (config.channels || []).map(channelToPayload),
  };
}

function mergeConfig(payload: Record<string, unknown>): Config {
  const current = loadConfig();
  const rawDefaultModel = typeof payload.defaultModel === 'string'
    ? payload.defaultModel.trim()
    : undefined;
  const uiAllowLan = payload.uiAllowLan === true;
  const requestedUiAccessToken = asString(payload.uiAccessToken);
  const uiAccessToken = requestedUiAccessToken
    || current.uiAccessToken
    || (uiAllowLan ? generateAccessToken() : undefined);

  return {
    ...current,
    runtime: payload.runtime === 'claude' || payload.runtime === 'auto' ? payload.runtime : 'codex',
    enabledChannels: current.enabledChannels,
    defaultWorkspaceRoot: asString(payload.defaultWorkspaceRoot),
    defaultModel: rawDefaultModel === undefined
      ? current.defaultModel
      : rawDefaultModel === ''
        ? undefined
        : availableCodexModelSlugs.has(rawDefaultModel)
          ? rawDefaultModel
          : current.defaultModel,
    defaultMode: payload.defaultMode === 'plan' || payload.defaultMode === 'ask' ? payload.defaultMode : 'code',
    historyMessageLimit: asPositiveInt(payload.historyMessageLimit) || current.historyMessageLimit || 8,
    codexSkipGitRepoCheck: payload.codexSkipGitRepoCheck === true,
    codexSandboxMode: payload.codexSandboxMode === 'read-only'
      || payload.codexSandboxMode === 'danger-full-access'
      ? payload.codexSandboxMode
      : 'workspace-write',
    codexReasoningEffort: payload.codexReasoningEffort === 'minimal'
      || payload.codexReasoningEffort === 'low'
      || payload.codexReasoningEffort === 'high'
      || payload.codexReasoningEffort === 'xhigh'
      ? payload.codexReasoningEffort
      : 'medium',
    uiAllowLan,
    uiAccessToken,
    autoApprove: payload.autoApprove === true,
    channels: current.channels,
  };
}

function mergeChannelInstance(
  payload: Record<string, unknown>,
  current: Config,
): { config: Config; channel: ChannelInstance } {
  const provider = parseChannelProvider(payload.provider);
  if (!provider) {
    throw new Error('通道提供方只能是飞书或微信。');
  }

  const existingId = asString(payload.id);
  const existing = existingId ? findChannelInstance(existingId, current) : undefined;
  const alias = normalizeChannelAlias(asString(payload.alias), provider);
  const baseChannels = (current.channels || []).map(cloneChannel);
  const takenIds = new Set(baseChannels.map((channel) => channel.id));
  const channelId = existing?.id || buildChannelId(provider, alias, takenIds);
  const now = new Date().toISOString();

  let nextConfig: FeishuChannelConfig | WeixinChannelConfig;
  if (provider === 'feishu') {
    nextConfig = {
      appId: asString(payload.appId),
      appSecret: asString(payload.appSecret),
      site: normalizeFeishuSite(asString(payload.site) || asString(payload.domain)),
      allowedUsers: parseCsv(payload.allowedUsers),
      streamingEnabled: payload.streamingEnabled !== false,
      feedbackMarkdownEnabled: payload.feedbackMarkdownEnabled !== false,
    };
  } else {
    nextConfig = {
      accountId: asString(payload.accountId),
      baseUrl: asString(payload.baseUrl),
      cdnBaseUrl: asString(payload.cdnBaseUrl),
      mediaEnabled: payload.mediaEnabled === true,
      feedbackMarkdownEnabled: payload.feedbackMarkdownEnabled === true,
    };
  }

  const nextChannel: ChannelInstance = {
    id: channelId,
    alias,
    provider,
    enabled: payload.enabled !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    config: nextConfig,
  };

  const nextChannels = existing
    ? baseChannels.map((channel) => channel.id === existing.id ? nextChannel : channel)
    : [...baseChannels, nextChannel];

  return {
    config: {
      ...current,
      channels: nextChannels,
      enabledChannels: Array.from(new Set(nextChannels.filter((channel) => channel.enabled).map((channel) => channel.provider))),
    },
    channel: nextChannel,
  };
}

function getWeixinAccountsPayload() {
  return listWeixinAccounts().map((account) => ({
    accountId: account.accountId,
    name: account.name,
    userId: account.userId,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    lastLoginAt: account.lastLoginAt,
    updatedAt: account.updatedAt,
  }));
}

function getChannelLabel(channel: Pick<ChannelInstance, 'alias' | 'provider'>): string {
  const providerLabel = channel.provider === 'weixin' ? '微信' : '飞书';
  return channel.alias?.trim() ? `${channel.alias} · ${providerLabel}` : providerLabel;
}

function getFeishuSite(channel: ChannelInstance): FeishuSite {
  const feishu = channel.config as FeishuChannelConfig;
  return normalizeFeishuSite(feishu.site);
}

function getFeishuDomain(channel: ChannelInstance): string {
  return feishuSiteToApiBaseUrl(getFeishuSite(channel));
}

function getFeishuTokenCacheKey(channel: ChannelInstance): string {
  const feishu = channel.config as FeishuChannelConfig;
  return [
    channel.id,
    feishu.appId || '',
    feishu.appSecret || '',
    getFeishuDomain(channel),
  ].join(':');
}

async function validateFeishuCredentials(channel: ChannelInstance): Promise<{ ok: boolean; message: string }> {
  const feishu = channel.config as FeishuChannelConfig;
  if (!feishu.appId || !feishu.appSecret) {
    return { ok: false, message: 'Feishu App ID / App Secret 不能为空。' };
  }

  const domain = getFeishuDomain(channel);
  const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: feishu.appId,
      app_secret: feishu.appSecret,
    }),
  });

  const data = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (response.ok && data.code === 0 && data.tenant_access_token) {
    return { ok: true, message: '飞书凭据校验成功，tenant_access_token 已获取。' };
  }

  return {
    ok: false,
    message: `${getChannelLabel(channel)} 校验失败：${data.msg || `HTTP ${response.status}`}`,
  };
}

async function getFeishuTenantAccessToken(channel: ChannelInstance): Promise<string | null> {
  const feishu = channel.config as FeishuChannelConfig;
  if (!feishu.appId || !feishu.appSecret) return null;

  const domain = getFeishuDomain(channel);
  const cacheKey = getFeishuTokenCacheKey(channel);
  const now = Date.now();
  const cached = feishuTenantTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }

  const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: feishu.appId,
      app_secret: feishu.appSecret,
    }),
  });

  const data = await response.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    return null;
  }

  feishuTenantTokenCache.set(cacheKey, {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, Number(data.expire || 7200)) * 1000,
  });
  return data.tenant_access_token;
}

async function resolveFeishuBindingDisplay(
  config: Config,
  binding: BindingSummary,
): Promise<Pick<BindingSummary, 'chatDisplayName' | 'chatUserId'>> {
  const channel = findChannelInstance(binding.channelType, config);
  if (!channel || channel.provider !== 'feishu') {
    return {
      chatDisplayName: binding.chatDisplayName,
      chatUserId: binding.chatUserId,
    };
  }

  const cached = feishuChatLabelCache.get(binding.chatId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      chatDisplayName: cached.label,
      chatUserId: cached.userId || binding.chatUserId,
    };
  }

  const token = await getFeishuTenantAccessToken(channel);
  if (!token) {
    return {
      chatDisplayName: binding.chatDisplayName,
      chatUserId: binding.chatUserId,
    };
  }

  const domain = getFeishuDomain(channel);
  try {
    const chatResponse = await fetch(
      `${domain}/open-apis/im/v1/chats/${encodeURIComponent(binding.chatId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const chatData = await chatResponse.json() as {
      code?: number;
      data?: {
        name?: string;
        owner_id?: string;
        chat_mode?: string;
      };
    };

    const chatName = asString(chatData.data?.name);
    const ownerId = asString(chatData.data?.owner_id) || binding.chatUserId;
    if (chatResponse.ok && chatData.code === 0 && chatName) {
      feishuChatLabelCache.set(binding.chatId, {
        label: chatName,
        userId: ownerId,
        expiresAt: Date.now() + FEISHU_CHAT_LABEL_TTL_MS,
      });
      return {
        chatDisplayName: chatName,
        chatUserId: ownerId,
      };
    }

    if (ownerId) {
      const userResponse = await fetch(
        `${domain}/open-apis/contact/v3/users/${encodeURIComponent(ownerId)}?user_id_type=open_id`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const userData = await userResponse.json() as {
        code?: number;
        data?: {
          user?: {
            name?: string;
            nickname?: string;
          };
        };
      };
      const userName = asString(userData.data?.user?.name) || asString(userData.data?.user?.nickname);
      if (userResponse.ok && userData.code === 0 && userName) {
        feishuChatLabelCache.set(binding.chatId, {
          label: userName,
          userId: ownerId,
          expiresAt: Date.now() + FEISHU_CHAT_LABEL_TTL_MS,
        });
        return {
          chatDisplayName: userName,
          chatUserId: ownerId,
        };
      }
    }
  } catch {
    // Best effort: keep raw chat id if lookup fails.
  }

  return {
    chatDisplayName: binding.chatDisplayName,
    chatUserId: binding.chatUserId,
  };
}

async function buildBindingsPayload(store: JsonFileStore, config: Config) {
  const bindings = listBindingSummaries(store);
  const enriched = await Promise.all(bindings.map(async (binding) => {
    const resolved = await resolveFeishuBindingDisplay(config, binding);
    if (
      (
        resolved.chatDisplayName !== binding.chatDisplayName
        || resolved.chatUserId !== binding.chatUserId
      )
      && (resolved.chatDisplayName || resolved.chatUserId)
    ) {
      store.updateChannelBinding(binding.id, {
        chatDisplayName: resolved.chatDisplayName,
        chatUserId: resolved.chatUserId,
      });
    }
    return {
      ...binding,
      chatDisplayName: resolved.chatDisplayName || binding.chatDisplayName,
      chatUserId: resolved.chatUserId || binding.chatUserId,
    };
  }));

  return {
    bindings: enriched,
    options: listBindingTargetOptions(store, 12),
  };
}

function syncBindingChannelMeta(store: JsonFileStore, channel: ChannelInstance): void {
  for (const binding of store.listChannelBindings(channel.id)) {
    store.updateChannelBinding(binding.id, {
      channelProvider: channel.provider,
      channelAlias: channel.alias,
    });
  }
}

function deleteChannelInstance(current: Config, channelId: string): Config {
  const channels = current.channels || [];
  const nextChannels = channels.filter((channel) => channel.id !== channelId);
  if (nextChannels.length === channels.length) {
    throw new Error('指定的通道不存在。');
  }

  return {
    ...current,
    channels: nextChannels,
    enabledChannels: Array.from(new Set(nextChannels.filter((channel) => channel.enabled).map((channel) => channel.provider))),
  };
}

async function testCodexConnection(config: Config): Promise<{ ok: boolean; message: string; raw?: string }> {
  const provider = new CodexProvider(new PendingPermissions());
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  const workingDirectory = config.defaultWorkspaceRoot || DEFAULT_WORKSPACE_ROOT;
  fs.mkdirSync(workingDirectory, { recursive: true });

  try {
    const stream = provider.streamChat({
      prompt: 'Reply with the single word OK.',
      sessionId: `ui-test-${Date.now()}`,
      workingDirectory,
      permissionMode: 'plan',
      abortController,
    });

    const reader = stream.getReader();
    let responseText = '';
    let raw = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += value;
      const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const parsed = JSON.parse(line.slice(6)) as { type: string; data: string };
        if (parsed.type === 'text') {
          responseText += parsed.data;
        }
        if (parsed.type === 'error') {
          return { ok: false, message: parsed.data, raw };
        }
      }
    }

    return {
      ok: true,
      message: responseText.trim() || 'Codex SDK 已连通，但测试没有返回文本。',
      raw,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function renderLoginHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex to IM 登录</title>
    <style>
      :root {
        --bg: #f5f7fa;
        --surface: #ffffff;
        --border: #e5e7eb;
        --border-strong: #d0d7e2;
        --text: #111827;
        --muted: #667085;
        --primary: #1677ff;
        --primary-strong: #0958d9;
        --danger: #dc2626;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.5 "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      }
      .auth-card {
        width: min(420px, 100%);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
        line-height: 1.2;
      }
      p {
        margin: 0 0 18px;
        color: var(--muted);
      }
      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-weight: 500;
      }
      input {
        width: 100%;
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        padding: 10px 12px;
        font: inherit;
      }
      input:focus {
        outline: 2px solid rgba(22, 119, 255, 0.14);
        border-color: var(--primary);
      }
      button {
        margin-top: 16px;
        width: 100%;
        border: 1px solid var(--primary);
        background: var(--primary);
        color: #ffffff;
        border-radius: 8px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }
      button:hover {
        background: var(--primary-strong);
        border-color: var(--primary-strong);
      }
      .message {
        display: none;
        margin-top: 14px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(220, 38, 38, 0.08);
        color: var(--danger);
      }
      .message.show { display: block; }
    </style>
  </head>
  <body>
    <section class="auth-card">
      <h1>访问 Codex to IM</h1>
      <p>当前工作台已开启局域网访问。请输入访问 token，验证通过后才能查看和修改配置。</p>
      <form id="loginForm">
        <label>
          访问 token
          <input id="token" name="token" autocomplete="off" spellcheck="false" />
        </label>
        <button type="submit">登录</button>
      </form>
      <div class="message" id="message"></div>
    </section>
    <script>
      const form = document.getElementById('loginForm');
      const message = document.getElementById('message');
      const tokenInput = document.getElementById('token');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        message.className = 'message';
        message.textContent = '';

        try {
          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tokenInput.value }),
          });
          const text = await response.text();
          const data = text ? JSON.parse(text) : {};
          if (!response.ok) {
            throw new Error(data.error || '登录失败');
          }
          window.location.href = '/';
        } catch (error) {
          message.className = 'message show';
          message.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    </script>
  </body>
</html>`;
}

function renderAccessDeniedHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex to IM</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #f5f7fa;
        color: #111827;
        font: 14px/1.5 "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      }
      .card {
        width: min(420px, 100%);
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
        line-height: 1.2;
      }
      p {
        margin: 0;
        color: #667085;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>当前未开放局域网访问</h1>
      <p>这个 Web 工作台目前只允许本机访问。请先在本机配置页中勾选“允许局域网访问 Web 控制台”。</p>
    </section>
  </body>
</html>`;
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex to IM</title>
    <style>
      :root {
        --bg: #f5f7fa;
        --surface: #ffffff;
        --surface-soft: #fafafa;
        --border: #e5e7eb;
        --border-strong: #d0d7e2;
        --text: #111827;
        --muted: #667085;
        --primary: #1677ff;
        --primary-strong: #0958d9;
        --success: #15803d;
        --danger: #dc2626;
        --sidebar: #001529;
        --sidebar-border: #0f2b46;
        --sidebar-text: #c7d2e0;
        --sidebar-active: #1677ff;
        --code-bg: #0f172a;
      }

      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font: 14px/1.5 "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
        color: var(--text);
        background: var(--bg);
      }

      button, input, select, textarea {
        font: inherit;
      }

      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 232px minmax(0, 1fr);
      }

      .sidebar {
        background: var(--sidebar);
        color: var(--sidebar-text);
        padding: 20px 16px;
        border-right: 1px solid var(--sidebar-border);
      }

      .brand {
        padding: 10px 12px 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        margin-bottom: 18px;
      }

      .brand-title {
        margin: 0;
        color: #ffffff;
        font-size: 16px;
        font-weight: 700;
      }

      .brand-copy {
        margin: 6px 0 0;
        color: var(--sidebar-text);
        font-size: 13px;
      }

      .nav {
        display: grid;
        gap: 4px;
      }

      .nav-link {
        width: 100%;
        border: 0;
        background: transparent;
        color: var(--sidebar-text);
        text-align: left;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
      }

      .nav-link:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #ffffff;
      }

      .nav-link.active {
        background: var(--sidebar-active);
        color: #ffffff;
      }

      .main {
        padding: 28px 32px 36px;
      }

      .page {
        display: none;
      }

      .page.active {
        display: block;
      }

      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        margin-bottom: 20px;
      }

      .page-title {
        margin: 0;
        font-size: 28px;
        line-height: 1.2;
      }

      .page-copy {
        margin: 6px 0 0;
        color: var(--muted);
      }

      .status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
        margin-bottom: 20px;
      }

      .status-card,
      .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
      }

      .status-card {
        padding: 16px 18px;
      }

      .status-card strong {
        display: block;
        font-size: 12px;
        color: var(--muted);
        font-weight: 600;
        margin-bottom: 8px;
      }

      .status-value {
        font-size: 22px;
        line-height: 1.2;
        font-weight: 700;
        word-break: break-word;
      }

      .panel {
        padding: 20px;
      }

      .section-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 20px;
      }

      .overview-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.9fr);
        gap: 20px;
      }

      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 16px;
      }

      .panel-header h2,
      .panel-header h3 {
        margin: 0;
        font-size: 18px;
      }

      .panel-header p {
        margin: 6px 0 0;
        color: var(--muted);
      }

      .toolbar,
      .actions,
      .session-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      button {
        border: 1px solid var(--border-strong);
        background: #ffffff;
        color: var(--text);
        border-radius: 8px;
        padding: 9px 14px;
        cursor: pointer;
      }

      button:hover {
        border-color: var(--primary);
        color: var(--primary);
      }

      button.primary {
        background: var(--primary);
        border-color: var(--primary);
        color: #ffffff;
      }

      button.primary:hover {
        background: var(--primary-strong);
        border-color: var(--primary-strong);
        color: #ffffff;
      }

      button[disabled] {
        border-color: var(--border);
        color: #9ca3af;
        background: #f3f4f6;
        cursor: not-allowed;
      }

      button[disabled]:hover {
        border-color: var(--border);
        color: #9ca3af;
      }

      .fields {
        display: grid;
        gap: 16px;
      }

      .field-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }

      .field-row.triple {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-weight: 500;
      }

      input, select, textarea {
        width: 100%;
        border: 1px solid var(--border-strong);
        background: #ffffff;
        color: var(--text);
        border-radius: 8px;
        padding: 10px 12px;
      }

      input:focus, select:focus, textarea:focus {
        outline: 2px solid rgba(22, 119, 255, 0.14);
        border-color: var(--primary);
      }

      textarea {
        min-height: 220px;
        resize: vertical;
      }

      .checkbox-row {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }

      .checkbox {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
      }

      .checkbox input {
        width: 16px;
        height: 16px;
        margin: 0;
      }

      .notice {
        padding: 12px 14px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        color: var(--muted);
      }

      .message {
        display: none;
      }

      .global-message-host {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        display: grid;
        gap: 12px;
        z-index: 2400;
        pointer-events: none;
      }

      .global-message {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-width: 260px;
        max-width: min(640px, calc(100vw - 32px));
        padding: 11px 14px;
        border-radius: 10px;
        border: 1px solid rgba(208, 215, 226, 0.88);
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
        color: var(--text);
        line-height: 1.45;
        animation: message-enter 160ms ease;
      }

      .global-message.success {
        border-color: rgba(22, 163, 74, 0.22);
      }

      .global-message.error {
        border-color: rgba(220, 38, 38, 0.24);
      }

      .global-message-icon {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 700;
        background: rgba(15, 23, 42, 0.06);
      }

      .global-message.success .global-message-icon {
        color: var(--success);
        background: rgba(22, 163, 74, 0.12);
      }

      .global-message.error .global-message-icon {
        color: var(--danger);
        background: rgba(220, 38, 38, 0.10);
      }

      .global-message-content {
        min-width: 0;
        word-break: break-word;
      }

      @keyframes message-enter {
        from {
          opacity: 0;
          transform: translateY(-6px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .info-list {
        display: grid;
        gap: 12px;
      }

      .info-item {
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-soft);
      }

      .info-item strong {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        color: var(--muted);
      }

      .mono,
      .project-group-path,
      .session-path,
      .binding-detail code {
        font-family: "Cascadia Code", Consolas, "SF Mono", monospace;
      }

      .session-list {
        display: grid;
        gap: 16px;
      }

      .session-section {
        display: grid;
        gap: 12px;
      }

      .session-section + .session-section {
        margin-top: 22px;
      }

      .session-section-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
      }

      .session-section-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
      }

      .session-section-meta {
        color: var(--muted);
        font-size: 12px;
      }

      .project-group {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface);
        padding: 16px;
        display: grid;
        gap: 14px;
      }

      .project-group-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }

      .project-group-title {
        font-size: 16px;
        font-weight: 700;
      }

      .project-group-path {
        color: var(--muted);
        font-size: 12px;
        margin-top: 4px;
        word-break: break-all;
      }

      .project-group-count {
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }

      .project-session-list {
        display: grid;
        gap: 12px;
      }

      .session-card {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 14px;
        background: var(--surface-soft);
      }

      .session-card.current-thread {
        border-color: rgba(22, 119, 255, 0.32);
        background: rgba(22, 119, 255, 0.03);
      }

      .session-head {
        display: grid;
        grid-template-columns: minmax(0, 1.9fr) 150px minmax(220px, 1fr) auto;
        gap: 16px;
        align-items: center;
      }

      .session-main {
        min-width: 0;
        display: grid;
        gap: 4px;
      }

      .session-title {
        font-weight: 700;
      }

      .session-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .session-mark {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        border-radius: 999px;
        background: rgba(22, 119, 255, 0.10);
        color: var(--primary);
        font-size: 12px;
        border: 1px solid rgba(22, 119, 255, 0.16);
      }

      .session-thread {
        color: var(--muted);
        font-size: 12px;
      }

      .session-thread code {
        word-break: break-all;
      }

      .session-inline-action {
        border: 0;
        background: transparent;
        color: var(--primary);
        padding: 0;
        margin-left: 8px;
        font-size: 12px;
      }

      .session-inline-action:hover {
        color: var(--primary-strong);
        text-decoration: underline;
      }

      .session-cell {
        min-width: 0;
        display: grid;
        gap: 4px;
      }

      .session-label {
        color: var(--muted);
        font-size: 12px;
      }

      .session-value,
      .session-path {
        color: var(--muted);
        font-size: 12px;
        word-break: break-all;
      }

      .session-actions {
        justify-content: flex-end;
        align-items: center;
        flex-wrap: wrap;
      }

      .session-binding-tags {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }

      .session-binding-tag {
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 10px;
        background: rgba(22, 119, 255, 0.08);
        color: var(--primary);
        font-size: 12px;
        border: 1px solid rgba(22, 119, 255, 0.16);
        width: fit-content;
        max-width: 100%;
      }

      .session-binding-tag button {
        padding: 4px 8px;
        border-radius: 999px;
        background: #ffffff;
        font-size: 12px;
      }

      .session-binding-tag-label {
        min-width: 0;
        word-break: break-word;
      }

      .session-simple-list {
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
        background: #ffffff;
      }

      .session-simple-item {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(220px, 1fr) auto;
        gap: 16px;
        align-items: center;
        padding: 14px 16px;
        border-top: 1px solid var(--border);
      }

      .session-simple-item:first-child {
        border-top: 0;
      }

      .session-simple-main {
        min-width: 0;
        display: grid;
        gap: 4px;
      }

      .session-simple-title {
        font-weight: 700;
        word-break: break-word;
      }

      .session-simple-thread,
      .session-simple-time,
      .session-simple-path {
        color: var(--muted);
        font-size: 12px;
        word-break: break-all;
      }

      .session-simple-side {
        min-width: 0;
        display: grid;
        gap: 4px;
      }

      .panel-block {
        margin-top: 18px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
      }

      .panel-subtitle {
        margin: 0 0 10px;
        font-size: 14px;
        font-weight: 700;
      }

      .channel-shell {
        padding: 0;
        overflow: hidden;
      }

      .channel-layout {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        gap: 20px;
      }

      .channel-sidebar {
        border-right: 1px solid var(--border);
        padding-right: 20px;
        display: grid;
        gap: 12px;
        align-content: start;
      }

      .channel-sidebar-meta {
        color: var(--muted);
        font-size: 12px;
      }

      .channel-list {
        display: grid;
        gap: 8px;
      }

      .channel-list-item {
        width: 100%;
        text-align: left;
        border-radius: 10px;
        padding: 12px 14px;
        display: grid;
        gap: 8px;
      }

      .channel-list-item.active {
        border-color: rgba(22, 119, 255, 0.30);
        background: rgba(22, 119, 255, 0.06);
        color: var(--text);
      }

      .channel-list-item-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }

      .channel-list-item-title {
        font-weight: 700;
        min-width: 0;
        word-break: break-word;
      }

      .channel-list-item-provider,
      .channel-list-item-meta {
        color: var(--muted);
        font-size: 12px;
      }

      .channel-list-item-stats {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        font-size: 12px;
        color: var(--muted);
      }

      .channel-list-item-status {
        color: var(--text);
        font-weight: 600;
      }

      .channel-editor {
        min-width: 0;
      }

      .channel-editor-summary {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }

      .channel-editor-stat {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-soft);
        padding: 12px 14px;
        display: grid;
        gap: 4px;
      }

      .channel-editor-stat strong {
        font-size: 12px;
        color: var(--muted);
        font-weight: 600;
      }

      .channel-editor-stat span {
        font-size: 14px;
        font-weight: 700;
        color: var(--text);
      }

      .editor-section {
        border-top: 1px solid var(--border);
        padding-top: 16px;
        display: grid;
        gap: 14px;
      }

      .editor-section-title {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
      }

      .toolbar-split {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
      }

      .toolbar-danger {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      button.danger {
        border-color: rgba(220, 38, 38, 0.24);
        color: var(--danger);
      }

      button.danger:hover {
        border-color: var(--danger);
        color: var(--danger);
      }

      .inline-select {
        display: inline-grid;
        gap: 6px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 500;
      }

      .channel-tabs {
        display: flex;
        align-items: flex-end;
        gap: 0;
        padding: 0 20px;
        border-bottom: 1px solid var(--border);
        background: #ffffff;
      }

      .command-sections {
        display: grid;
        gap: 14px;
      }

      .command-section {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-soft);
        overflow: hidden;
      }

      .command-section-title {
        margin: 0;
        padding: 10px 14px;
        font-size: 14px;
        font-weight: 700;
        border-bottom: 1px solid var(--border);
        background: #ffffff;
      }

      .command-list {
        display: grid;
      }

      .command-list-head,
      .command-item {
        display: grid;
        grid-template-columns: 220px 320px minmax(0, 1fr);
        gap: 16px;
        padding: 10px 14px;
        align-items: start;
      }

      .command-list-head {
        padding-top: 12px;
        padding-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .04em;
        background: #fcfcfd;
        border-top: 1px solid var(--border);
      }

      .command-item:first-child {
        border-top: 0;
      }

      .command-item code {
        word-break: break-all;
      }

      .command-col-command,
      .command-col-original {
        min-width: 0;
      }

      .command-col-desc {
        color: #475467;
      }

      .channel-tab {
        border: 0;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        padding: 14px 18px 12px;
        background: transparent;
        color: var(--muted);
        margin-bottom: -1px;
      }

      .channel-tab.active {
        color: var(--primary);
        border-bottom-color: var(--primary);
        background: transparent;
      }

      .channel-view {
        display: none;
        padding: 20px;
      }

      .channel-view.active {
        display: block;
      }

      .binding-list {
        display: grid;
        gap: 10px;
      }

      .binding-tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }

      .binding-tab {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: #ffffff;
        color: var(--muted);
        padding: 7px 12px;
      }

      .binding-tab.active {
        border-color: rgba(22, 119, 255, 0.30);
        background: rgba(22, 119, 255, 0.08);
        color: var(--primary);
      }

      .binding-item {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface-soft);
        padding: 12px 14px;
      }

      .binding-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 6px;
      }

      .binding-title {
        font-weight: 700;
      }

      .binding-detail {
        color: var(--muted);
        font-size: 12px;
        margin-top: 4px;
        word-break: break-all;
      }

      .binding-controls {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        margin-top: 12px;
      }

      .binding-table-wrap {
        margin-top: 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #ffffff;
        overflow: hidden;
      }

      .binding-table {
        width: 100%;
        border-collapse: collapse;
      }

      .binding-table th,
      .binding-table td {
        padding: 10px 12px;
        border-top: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }

      .binding-table thead th {
        border-top: 0;
        background: #f8fafc;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .binding-table tbody tr.current {
        background: rgba(22, 119, 255, 0.04);
      }

      .binding-table-title {
        font-weight: 700;
        word-break: break-word;
      }

      .binding-table-thread,
      .binding-table-path {
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }

      .binding-table-mark {
        display: inline-flex;
        align-items: center;
        margin-left: 8px;
        padding: 1px 8px;
        border-radius: 999px;
        background: rgba(22, 119, 255, 0.10);
        color: var(--primary);
        font-size: 12px;
      }

      .binding-target-btn {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #ffffff;
        white-space: nowrap;
      }

      .binding-target-btn.current {
        border-color: rgba(22, 119, 255, 0.30);
        background: rgba(22, 119, 255, 0.08);
        color: var(--primary);
      }

      .binding-empty {
        padding: 12px 14px;
        border: 1px dashed var(--border-strong);
        border-radius: 8px;
        color: var(--muted);
        background: var(--surface-soft);
      }

      .logs {
        white-space: pre-wrap;
        word-break: break-word;
        background: var(--code-bg);
        color: #e2e8f0;
        border-radius: 10px;
        padding: 16px;
        min-height: 420px;
        overflow: auto;
      }

      .ghost,
      .small {
        color: var(--muted);
        font-size: 12px;
      }

      @media (max-width: 1180px) {
        .overview-grid,
        .section-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 980px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar { border-right: 0; border-bottom: 1px solid var(--sidebar-border); }
        .nav { grid-template-columns: repeat(6, minmax(0, 1fr)); }
        .main { padding: 20px 20px 28px; }
        .channel-layout { grid-template-columns: 1fr; }
        .channel-sidebar { border-right: 0; padding-right: 0; }
        .channel-editor-summary { grid-template-columns: 1fr; }
        .field-row,
        .field-row.triple,
        .command-item,
        .command-list-head,
        .binding-controls { grid-template-columns: 1fr; }
        .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }

      @media (max-width: 720px) {
        .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .status-grid { grid-template-columns: 1fr; }
        .page-header,
        .panel-header,
        .project-group-head,
        .binding-head,
        .session-section-head { flex-direction: column; align-items: stretch; }
        .session-head { grid-template-columns: 1fr; }
        .session-simple-item { grid-template-columns: 1fr; }
        .session-actions { justify-content: flex-start; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <p class="brand-title">Codex to IM</p>
          <p class="brand-copy">本地后台、会话共享、通道绑定和调试都走这里。</p>
        </div>
        <nav class="nav">
          <button type="button" class="nav-link active" data-page="overview">概览</button>
          <button type="button" class="nav-link" data-page="sessions">会话</button>
          <button type="button" class="nav-link" data-page="config">配置</button>
          <button type="button" class="nav-link" data-page="channels">通道</button>
          <button type="button" class="nav-link" data-page="logs">日志</button>
          <button type="button" class="nav-link" data-page="commands">命令说明</button>
        </nav>
      </aside>
      <main class="main">
        <section class="page active" data-page="overview">
          <div class="page-header">
            <div>
              <h1 class="page-title">概览</h1>
              <p class="page-copy">运行状态、后台控制和当前环境集中在这一页。</p>
            </div>
          </div>

          <section class="status-grid">
            <div class="status-card">
              <strong>Bridge</strong>
              <div class="status-value" id="bridgeStatus">-</div>
            </div>
            <div class="status-card">
              <strong>Bridge 开机自启动</strong>
              <div class="status-value" id="autostartStatus">-</div>
            </div>
            <div class="status-card">
              <strong>Codex Skill</strong>
              <div class="status-value" id="integrationStatus">-</div>
            </div>
            <div class="status-card">
              <strong>Runtime</strong>
              <div class="status-value" id="runtimeStatus">-</div>
            </div>
            <div class="status-card">
              <strong>Desktop Sessions</strong>
              <div class="status-value" id="desktopSessionCount">-</div>
            </div>
            <div class="status-card">
              <strong>IM Bindings</strong>
              <div class="status-value" id="bindingCount">-</div>
            </div>
            <div class="status-card">
              <strong>Config Home</strong>
              <div class="status-value" id="homeStatus" style="font-size: 14px;">-</div>
            </div>
          </section>

          <div class="overview-grid">
            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>运行控制</h2>
                  <p>保存配置后，可以直接在这里启停 bridge、测试 Codex 或刷新整体状态。</p>
                </div>
              </div>
              <div class="actions">
                <button class="primary" id="startBridgeBtn">启动 Bridge</button>
                <button id="stopBridgeBtn">停止 Bridge</button>
                <button id="restartBridgeBtn">重启 Bridge</button>
                <button id="testCodexBtn">测试 Codex</button>
                <button id="refreshBtn">刷新状态</button>
              </div>

              <div class="panel-block">
                <p class="panel-subtitle">当前能力</p>
                <div class="notice">已接通：保存配置、后台启停、飞书凭据测试、微信扫码、Codex 连接测试、桌面会话发现、IM 绑定查看与网页侧切换。</div>
              </div>

              <div class="panel-block">
                <p class="panel-subtitle">Bridge 开机自启动</p>
                <div class="notice" id="autostartNotice">正在检查当前 Windows 任务计划程序状态…</div>
                <div class="actions" style="margin-top: 12px;">
                  <button id="refreshAutostartBtn">刷新开机自启动状态</button>
                </div>
              </div>

              <div class="panel-block">
                <p class="panel-subtitle">可选 Codex Skill</p>
                <div class="notice">bridge 不再注入发送附件的提示词。需要让 Codex 知道“可以把本地图片/文件回发到 IM”时，请安装这个可选 skill。</div>
                <div class="actions" style="margin-top: 12px;">
                  <button id="installIntegrationBtn">安装可选 Codex Skill</button>
                </div>
              </div>

              <div class="message" id="opsMessage"></div>
            </section>

            <section class="panel">
              <div class="panel-header">
                <div>
                  <h2>当前环境</h2>
                  <p>这里显示本机运行时和关键目录，便于排查部署问题。</p>
                </div>
              </div>
              <div class="info-list">
                <div class="info-item">
                  <strong>包根目录</strong>
                  <div class="mono" id="packageRoot">-</div>
                </div>
                <div class="info-item">
                  <strong>配置目录</strong>
                  <div class="mono" id="overviewHomeStatus">-</div>
                </div>
                <div class="info-item">
                  <strong>桌面会话根目录</strong>
                  <div class="mono" id="desktopRootStatus">-</div>
                </div>
                <div class="info-item">
                  <strong>界面说明</strong>
                  <div>左侧切换页面；“会话”管理桌面 thread；“通道”里查看飞书/微信当前绑定并直接切换。</div>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section class="page" data-page="sessions">
          <div class="page-header">
            <div>
              <h1 class="page-title">会话</h1>
              <p class="page-copy">先看当前已经绑定到聊天的会话，再查看全部桌面会话列表。</p>
            </div>
            <div class="toolbar">
              <button id="refreshDesktopBtn">刷新桌面会话</button>
            </div>
          </div>

          <section class="panel" id="desktop">
            <div class="notice">这里只展示在 Codex 桌面索引里有名字的线程，和 Codex Desktop App 左侧列表保持一致。</div>
            <div class="notice" style="margin-top: 12px;">最短路径：找到目标 thread，然后把 <code>/thread 019d1da4</code> 这样的命令发给飞书机器人，或直接到“通道”页切换绑定。</div>
            <div class="small" id="desktopSessionMeta" style="margin: 14px 0 16px;">正在加载…</div>
            <div class="session-list">
              <section class="session-section">
                <div class="session-section-head">
                  <h2 class="session-section-title">当前已绑定会话</h2>
                  <div class="session-section-meta" id="boundSessionsMeta">正在加载…</div>
                </div>
                <div id="boundSessionsList"></div>
              </section>
              <section class="session-section">
                <div class="session-section-head">
                  <h2 class="session-section-title">全部会话</h2>
                  <div class="session-section-meta" id="allSessionsMeta">正在加载…</div>
                </div>
                <div id="desktopSessionsList"></div>
              </section>
            </div>
            <div class="message" id="desktopMessage"></div>
          </section>
        </section>

        <section class="page" data-page="config">
          <div class="page-header">
            <div>
              <h1 class="page-title">配置</h1>
              <p class="page-copy">这里维护默认工作空间、运行模式和全局行为开关。</p>
            </div>
          </div>

          <section class="panel" id="config">
            <div class="panel-header">
              <div>
                <h2>基础配置</h2>
                <p>保存后会写入本地配置目录。未绑定聊天会先进入临时草稿线程；默认工作空间、Sandbox、思考级别等会在下一次请求生效；通道启停会自动同步；只有少数运行时配置需要重启 Bridge。</p>
              </div>
              <div class="toolbar">
                <button class="primary" id="saveConfigBtn">保存配置</button>
              </div>
            </div>

            <div class="fields">
              <div class="field-row triple">
                <label>
                  Runtime
                  <select id="runtime">
                    <option value="codex" selected>codex</option>
                    <option value="auto">auto</option>
                    <option value="claude">claude</option>
                  </select>
                </label>
                <label>
                  默认模式
                  <select id="defaultMode">
                    <option value="code">code</option>
                    <option value="plan">plan</option>
                    <option value="ask">ask</option>
                  </select>
                </label>
                <label>
                  /history 返回条数
                  <input id="historyMessageLimit" type="number" min="1" max="20" value="8" />
                </label>
              </div>
              <label>
                默认工作空间
                <input id="defaultWorkspaceRoot" placeholder="留空时使用 ~/cx2im" />
              </label>
              <div class="field-row triple">
                <label>
                  默认模型
                  <select id="defaultModel"></select>
                </label>
                <label>
                  Codex 文件系统权限
                  <select id="codexSandboxMode">
                    <option value="workspace-write">workspace-write</option>
                    <option value="read-only">read-only</option>
                    <option value="danger-full-access">danger-full-access</option>
                  </select>
                </label>
                <label>
                  Codex 思考级别
                  <select id="codexReasoningEffort">
                    <option value="medium">medium</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </label>
              </div>
              <div class="small">未绑定的 IM 聊天会先进入临时草稿线程（等同 <code>/t 0</code>）；“默认工作空间”只用于 <code>/new proj1</code> 这类相对项目名。留空时会按当前系统自动回退到 <code>~/cx2im</code>。默认模型候选项来自启动时读取的 Codex 模型缓存：隐藏模型不会展示，CLI only 模型会标成“仅 IM / CLI”。留空则继续跟随 Codex 当前默认模型。文件系统权限是全局默认值，思考级别可在 IM 会话里再单独覆盖。</div>
              <div class="small">当前需要重启 Bridge 的配置：<code>Runtime</code>、<code>自动批准工具权限</code>、<code>允许在未信任 Git 目录运行 Codex</code>。通道实例的接入配置请在“通道”页维护。</div>
              <div class="checkbox-row">
                <label class="checkbox"><input id="autoApprove" type="checkbox" /> 自动批准工具权限</label>
              </div>
              <div class="checkbox-row">
                <label class="checkbox"><input id="codexSkipGitRepoCheck" type="checkbox" checked /> 允许在未信任 Git 目录运行 Codex</label>
              </div>
              <div class="small">如果新建会话报 “Not inside a trusted directory”，可以打开这个选项。修改后需要重启 Bridge 才会生效。</div>
              <div class="checkbox-row" style="margin-top: 12px;">
                <label class="checkbox"><input id="uiAllowLan" type="checkbox" /> 允许局域网访问 Web 控制台</label>
              </div>
              <div class="notice" id="uiAccessSummary">默认仅允许本机访问当前工作台。</div>
              <div id="uiLanDetails" hidden>
                <div class="field-row" style="margin-top: 16px;">
                  <label>
                    访问 token
                    <input id="uiAccessToken" readonly />
                  </label>
                  <div style="display: grid; gap: 10px; align-content: end;">
                    <div class="toolbar">
                      <button type="button" id="copyUiTokenBtn">复制 token</button>
                      <button type="button" id="regenerateUiTokenBtn">重新生成 token</button>
                    </div>
                    <div class="toolbar">
                      <button type="button" id="copyUiLanLinkBtn">复制局域网登录链接</button>
                    </div>
                  </div>
                </div>
                <div class="info-list" id="uiAccessUrls" style="margin-top: 16px;"></div>
              </div>
            </div>

            <div class="message" id="configMessage"></div>
          </section>
        </section>

        <section class="page" data-page="commands">
          <div class="page-header">
            <div>
              <h1 class="page-title">命令说明</h1>
              <p class="page-copy">这里列出当前桥接聊天里可用的命令，飞书和微信共用同一套语义。</p>
            </div>
          </div>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h2>命令使用说明</h2>
                <p>下面这些命令适用于当前桥接到的聊天通道，飞书和微信共用同一套命令语义。</p>
              </div>
            </div>

            <div class="notice" style="margin-bottom: 16px;">最短使用路径：先发 <code>/t</code> 查看最近会话，再发 <code>/t 1</code> 接管；之后直接发送文本即可继续当前会话。这里保留原始命令，仅用于后台查阅和兼容旧用法。</div>

            <div class="command-sections">
              <section class="command-section">
                <h3 class="command-section-title">最常用</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/</code></div><div class="command-col-original"><code>/status</code></div><div class="command-col-desc">查看当前会话。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/h</code></div><div class="command-col-original"><code>/help</code></div><div class="command-col-desc">查看帮助。</div></div>
          <div class="command-item"><div class="command-col-command"><code>/t</code></div><div class="command-col-original"><code>/threads</code></div><div class="command-col-desc">列出最近 10 条桌面会话。</div></div>
          <div class="command-item"><div class="command-col-command"><code>/t all</code></div><div class="command-col-original"><code>/threads all</code></div><div class="command-col-desc">最多列出 200 条桌面会话。</div></div>
          <div class="command-item"><div class="command-col-command"><code>/t n 100</code></div><div class="command-col-original"><code>/threads n 100</code></div><div class="command-col-desc">列出最近 100 条桌面会话，最多 200 条。</div></div>
              <div class="command-item"><div class="command-col-command"><code>/t &lt;序号&gt;</code></div><div class="command-col-original"><code>/thread &lt;序号&gt;</code></div><div class="command-col-desc">按序号接管桌面会话。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/n [绝对路径 | 项目名]</code></div><div class="command-col-original"><code>/new [绝对路径 | 项目名]</code></div><div class="command-col-desc">不带参数时在当前正式会话目录下新建线程；相对项目名会在“默认工作空间”下创建目录；当前若是临时草稿线程则会报错。通过 IM 创建的新线程当前只保证在 IM 中可继续，不会自动出现在 Codex Desktop 会话列表中。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>直接发送文本</code></div><div class="command-col-original">—</div><div class="command-col-desc">继续当前已绑定会话；未绑定时会自动进入临时草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his</code></div><div class="command-col-original"><code>/history</code></div><div class="command-col-desc">查看当前会话整理后的摘要。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his raw</code></div><div class="command-col-original"><code>/history raw</code></div><div class="command-col-desc">查看最近 N 条原始消息。</div></div>
                </div>
              </section>

              <section class="command-section">
                <h3 class="command-section-title">设置与切换</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/m</code></div><div class="command-col-original"><code>/mode</code></div><div class="command-col-desc">查看当前模式；可选 <code>code</code>、<code>plan</code>、<code>ask</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/r</code></div><div class="command-col-original"><code>/reasoning</code></div><div class="command-col-desc">查看当前思考级别；可选 <code>1=minimal</code>、<code>2=low</code>、<code>3=medium</code>、<code>4=high</code>、<code>5=xhigh</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/model [slug|default]</code></div><div class="command-col-original"><code>/model [slug|default]</code></div><div class="command-col-desc">查看或切换当前 IM 会话使用的模型；CLI only 模型会标注“仅 IM / CLI”，共享桌面线程只允许查看不允许切换。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t 0</code></div><div class="command-col-original"><code>/thread 0</code></div><div class="command-col-desc">切换到当前聊天的临时草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t 0 reset</code></div><div class="command-col-original"><code>/thread 0 reset</code></div><div class="command-col-desc">丢弃当前草稿上下文并重建一条新的草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/unbind</code></div><div class="command-col-original"><code>/unbind</code></div><div class="command-col-desc">解绑当前聊天，释放当前会话；之后再直接发文本会自动进入新的临时草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command">—</div><div class="command-col-original"><code>/stop</code></div><div class="command-col-desc">停止当前任务。</div></div>
                </div>
              </section>

              <section class="command-section">
                <h3 class="command-section-title">权限</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command">—</div><div class="command-col-original"><code>/perm allow|allow_session|deny &lt;id&gt;</code></div><div class="command-col-desc">文本方式处理一个待批准权限。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>1 / 2 / 3</code></div><div class="command-col-original">—</div><div class="command-col-desc">快速处理单个待批准权限。</div></div>
                </div>
              </section>
            </div>
          </section>
        </section>

        <section class="page" data-page="channels">
          <div class="page-header">
            <div>
              <h1 class="page-title">通道</h1>
              <p class="page-copy">每个通道都显示当前绑定的会话，并支持在网页里直接改绑。</p>
            </div>
          </div>

          <section class="panel channel-workspace">
            <div class="panel-header">
              <div>
                <h2>通道实例</h2>
                <p>这里管理多个飞书或微信机器人实例。实例只是不同聊天入口，不会改变 Codex 的会话语义。</p>
              </div>
              <div class="toolbar">
                <label class="inline-select">
                  新通道
                  <select id="newChannelProvider">
                    <option value="feishu">飞书</option>
                    <option value="weixin">微信</option>
                  </select>
                </label>
                <button id="createChannelBtn">新增通道</button>
                <button id="refreshChannelsBtn">刷新状态</button>
              </div>
            </div>

            <div class="channel-layout">
              <aside class="channel-sidebar">
                <div class="channel-sidebar-meta" id="channelListMeta">正在加载…</div>
                <div class="channel-list" id="channelList"></div>
              </aside>
              <section class="channel-editor" id="channelEditor">
                <div class="binding-empty">正在加载通道配置…</div>
              </section>
            </div>
            <div class="message" id="channelMessage"></div>
          </section>
        </section>

        <section class="page" data-page="logs">
          <div class="page-header">
            <div>
              <h1 class="page-title">日志</h1>
              <p class="page-copy">日志页只负责查看 bridge 日志，便于排查运行和通道问题。</p>
            </div>
            <div class="toolbar">
              <button id="refreshLogsBtn">刷新日志</button>
            </div>
          </div>

          <section class="panel" id="logs">
            <div class="logs" id="logsOutput">等待加载日志…</div>
          </section>
        </section>
      </main>
    </div>
    <div id="globalMessageHost" class="global-message-host" aria-live="polite"></div>

    <script>
      const state = {
        config: null,
        availableModels: [],
        uiAccess: null,
        bridgeStatus: null,
        autostartStatus: null,
        desktopSessions: [],
        bindings: [],
        bindingOptions: [],
        activeBindingByChannelId: {},
        weixinAccounts: [],
        desktopRoot: '',
        activePage: 'overview',
        activeChannelId: '',
        channelDraft: null,
      };

      function escapeHtml(value) {
        return String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      }

      function renderDefaultModelOptions(config) {
        const options = Array.isArray(config && config.availableModels) ? config.availableModels : [];
        state.availableModels = options;

        const select = document.getElementById('defaultModel');
        const currentValue = config && typeof config.defaultModel === 'string' ? config.defaultModel : '';
        const codexDefaultModel = config && typeof config.codexDefaultModel === 'string' ? config.codexDefaultModel : '';
        const items = [];
        const seen = new Set();

        items.push(
          '<option value="">' + escapeHtml(
            codexDefaultModel
              ? '跟随 Codex 默认模型（当前 ' + codexDefaultModel + '）'
              : '跟随 Codex 默认模型'
          ) + '</option>'
        );

        for (const model of options) {
          if (!model || typeof model.slug !== 'string' || !model.slug) continue;
          if (seen.has(model.slug)) continue;
          seen.add(model.slug);
          const label = model.slug + (model.supportedInApi === false ? '（仅 IM / CLI）' : '');
          items.push(
            '<option value="' + escapeHtml(model.slug) + '">' + escapeHtml(label) + '</option>'
          );
        }

        if (currentValue && !seen.has(currentValue)) {
          items.push(
            '<option value="' + escapeHtml(currentValue) + '">当前配置值（已不可用）：' + escapeHtml(currentValue) + '</option>'
          );
        }

        select.innerHTML = items.join('');
        select.value = currentValue;
      }

      function shortId(value) {
        if (!value) return '-';
        return value.length > 14 ? value.slice(0, 8) + '...' + value.slice(-4) : value;
      }

      function shortThreadCommand(value) {
        if (!value) return '/thread';
        return '/thread ' + value.slice(0, 12);
      }

      function pathSegments(value) {
        const normalized = String(value || '').split('/').join('\\\\');
        return normalized.split('\\\\').filter(Boolean);
      }

      function baseName(value) {
        const segments = pathSegments(value);
        return segments[segments.length - 1] || value || '(no cwd)';
      }

      function formatTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString('zh-CN', { hour12: false });
      }

      function optionLabel(option) {
        return option.label + ' · ' + option.description;
      }

      function renderBindingTable(binding) {
        const sessions = state.desktopSessions || [];
        if (!sessions.length) {
          return '<div class="binding-empty">当前还没有和会话页一致的命名桌面线程。</div>';
        }

        return ''
          + '<div class="binding-table-wrap">'
          +   '<table class="binding-table">'
          +     '<thead><tr><th>标题</th><th>Thread</th><th>目录</th><th>操作</th></tr></thead>'
          +     '<tbody>'
          +       sessions.map((session) => {
            const targetKey = 'desktop:' + session.threadId;
            const active = targetKey === binding.currentTargetKey;
            return ''
              + '<tr class="' + (active ? 'current' : '') + '">'
              +   '<td><div class="binding-table-title">' + escapeHtml(session.title || 'Untitled Session') + (active ? '<span class="binding-table-mark">当前</span>' : '') + '</div></td>'
              +   '<td><div class="binding-table-thread"><code>' + escapeHtml(session.threadId) + '</code></div></td>'
              +   '<td><div class="binding-table-path">' + escapeHtml(session.cwd || '(no cwd)') + '</div></td>'
              +   '<td><button type="button" class="binding-target-btn' + (active ? ' current' : '') + '" data-action="switch-binding-target" data-binding-id="' + escapeHtml(binding.id) + '" data-target-key="' + escapeHtml(targetKey) + '"' + (active ? ' disabled' : '') + '>' + (active ? '当前会话' : '切换到当前会话') + '</button></td>'
              + '</tr>';
          }).join('')
          +     '</tbody>'
          +   '</table>'
          + '</div>';
      }

      function bindingTabLabel(binding) {
        return binding.chatDisplayName || binding.chatId || binding.id;
      }

      function renderBindingCard(binding) {
        return ''
          + '<article class="binding-item" data-binding-id="' + escapeHtml(binding.id) + '">'
          +   '<div class="binding-head">'
          +     '<div class="binding-title">' + escapeHtml(binding.chatDisplayName || binding.chatId) + '</div>'
          +     '<div class="actions">'
          +       '<div class="small">' + escapeHtml(binding.mode) + '</div>'
          +       '<button type="button" data-action="unbind-binding" data-binding-id="' + escapeHtml(binding.id) + '">解绑当前聊天</button>'
          +     '</div>'
          +   '</div>'
          +   '<div class="binding-detail">聊天 ID：<code>' + escapeHtml(binding.chatId) + '</code></div>'
          +   '<div class="binding-detail">当前会话：<code>' + escapeHtml(binding.currentSessionId.slice(0, 8)) + '...</code> · ' + escapeHtml(binding.currentSessionName) + '</div>'
          +   '<div class="binding-detail">当前目标：' + escapeHtml(binding.currentTargetLabel || '未绑定') + '</div>'
          +   '<div class="binding-detail">当前 thread：<code>' + escapeHtml(binding.currentThreadId || 'not-shared') + '</code></div>'
          +   '<div class="binding-detail">运行状态：' + escapeHtml(bindingRuntimeText(binding)) + '</div>'
          +   '<div class="binding-detail">共享镜像：' + escapeHtml(bindingMirrorText(binding)) + '</div>'
          +   '<div class="binding-detail">目录：' + escapeHtml(binding.workingDirectory || '~') + '</div>'
          +   renderBindingTable(binding)
          + '</article>';
      }

      function formPayload() {
        return {
          runtime: document.getElementById('runtime').value,
          defaultMode: document.getElementById('defaultMode').value,
          historyMessageLimit: document.getElementById('historyMessageLimit').value,
          defaultWorkspaceRoot: document.getElementById('defaultWorkspaceRoot').value,
          defaultModel: document.getElementById('defaultModel').value,
          codexSkipGitRepoCheck: document.getElementById('codexSkipGitRepoCheck').checked,
          codexSandboxMode: document.getElementById('codexSandboxMode').value,
          codexReasoningEffort: document.getElementById('codexReasoningEffort').value,
          uiAllowLan: document.getElementById('uiAllowLan').checked,
          uiAccessToken: document.getElementById('uiAccessToken').value,
          autoApprove: document.getElementById('autoApprove').checked,
        };
      }

      function showMessage(id, type, message) {
        const node = document.getElementById(id);
        if (node) {
          node.className = 'message';
          node.textContent = '';
        }
        showGlobalMessage(type, message);
      }

      function showGlobalMessage(type, message) {
        const host = document.getElementById('globalMessageHost');
        if (!host) return;

        const item = document.createElement('div');
        item.className = 'global-message ' + (type || 'success');
        const icon = document.createElement('span');
        icon.className = 'global-message-icon';
        icon.textContent = type === 'error' ? '!' : '✓';

        const content = document.createElement('div');
        content.className = 'global-message-content';
        content.textContent = message;

        item.appendChild(icon);
        item.appendChild(content);
        host.appendChild(item);

        window.setTimeout(() => {
          item.remove();
        }, 2200);
      }

      function setActivePage(page, syncHash) {
        const nextPage = ['overview', 'sessions', 'config', 'commands', 'channels', 'logs'].includes(page) ? page : 'overview';
        state.activePage = nextPage;

        document.querySelectorAll('.nav-link').forEach((element) => {
          const node = element;
          node.classList.toggle('active', node.dataset.page === nextPage);
        });

        document.querySelectorAll('.page').forEach((element) => {
          const node = element;
          node.classList.toggle('active', node.dataset.page === nextPage);
        });

        if (syncHash !== false) {
          const hash = nextPage === 'channels'
            ? '#channels/' + (state.activeChannelId || '')
            : '#' + nextPage;
          if (window.location.hash !== hash) {
            history.replaceState(null, '', hash);
          }
        }
      }

      function setActiveChannel(channelId, syncHash) {
        state.activeChannelId = channelId || '';
        renderChannelsWorkspace();

        if (syncHash !== false && state.activePage === 'channels') {
          const hash = '#channels/' + (state.activeChannelId || '');
          if (window.location.hash !== hash) {
            history.replaceState(null, '', hash);
          }
        }
      }

      function syncPageFromHash() {
        const raw = String(window.location.hash || '').replace(/^#/, '');
        if (!raw) {
          setActivePage('overview', false);
          return;
        }

        if (raw.startsWith('channels/')) {
          setActivePage('channels', false);
          setActiveChannel(raw.split('/')[1] || '', false);
          return;
        }

        setActivePage(raw, false);
      }

      async function copyText(value, successMessage) {
        if (!navigator.clipboard || !value) {
          throw new Error('当前浏览器不支持复制，或没有可复制的内容。');
        }
        await navigator.clipboard.writeText(value);
        showGlobalMessage('success', successMessage);
      }

      function groupDesktopSessions(sessions) {
        const groups = new Map();
        for (const session of sessions || []) {
          const key = session.cwd || '(no cwd)';
          if (!groups.has(key)) {
            groups.set(key, {
              key,
              name: baseName(key),
              cwd: key,
              latest: session.lastEventAt || '',
              sessions: [],
            });
          }
          const group = groups.get(key);
          group.sessions.push(session);
          if ((session.lastEventAt || '') > group.latest) {
            group.latest = session.lastEventAt || '';
          }
        }

        return Array.from(groups.values())
          .map((group) => ({
            ...group,
            sessions: group.sessions.sort((left, right) => (right.lastEventAt || '').localeCompare(left.lastEventAt || '')),
          }))
          .sort((left, right) => {
            const timeOrder = (right.latest || '').localeCompare(left.latest || '');
            if (timeOrder !== 0) return timeOrder;
            return left.name.localeCompare(right.name, 'zh-CN');
          });
      }

      function providerLabel(provider) {
        if (provider === 'weixin') return '微信';
        if (provider === 'feishu') return '飞书';
        return '通道';
      }

      function configuredChannels() {
        return Array.isArray(state.config && state.config.channels) ? state.config.channels : [];
      }

      function visibleChannels() {
        const channels = configuredChannels().slice();
        if (state.channelDraft) {
          channels.push(state.channelDraft);
        }
        return channels;
      }

      function getChannelById(channelId) {
        if (state.channelDraft && state.channelDraft.id === channelId) return state.channelDraft;
        return configuredChannels().find((channel) => channel.id === channelId) || null;
      }

      function adapterStatuses() {
        return state.bridgeStatus && Array.isArray(state.bridgeStatus.adapters) ? state.bridgeStatus.adapters : [];
      }

      function getAdapterStatus(channelId) {
        return adapterStatuses().find((item) => item.channelType === channelId) || null;
      }

      function isChannelRunning(channelId) {
        const status = getAdapterStatus(channelId);
        return Boolean(state.bridgeStatus && state.bridgeStatus.running && status && status.running);
      }

      const CONFIG_FIELD_LABELS = {
        runtime: 'Runtime',
        defaultWorkspaceRoot: '默认工作空间',
        defaultModel: '默认模型',
        defaultMode: '默认模式',
        historyMessageLimit: '/history 返回条数',
        codexSkipGitRepoCheck: '允许在未信任 Git 目录运行 Codex',
        codexSandboxMode: 'Codex 文件系统权限',
        codexReasoningEffort: 'Codex 思考级别',
        uiAllowLan: '允许局域网访问 Web 控制台',
        uiAccessToken: '局域网访问 token',
        autoApprove: '自动批准工具权限',
      };

      const BRIDGE_RESTART_FIELDS = new Set([
        'runtime',
        'codexSkipGitRepoCheck',
        'autoApprove',
      ]);

      const AUTO_SYNC_FIELDS = new Set([]);

      const IMMEDIATE_FIELDS = new Set([
        'defaultWorkspaceRoot',
        'defaultModel',
        'defaultMode',
        'historyMessageLimit',
        'codexSandboxMode',
        'codexReasoningEffort',
        'uiAllowLan',
        'uiAccessToken',
      ]);

      const SAVE_SCOPE_FIELDS = {
        all: null,
        feishu: new Set([]),
        weixin: new Set([]),
      };

      function normalizeConfigValue(value) {
        if (Array.isArray(value)) {
          return value.slice().map((item) => String(item)).sort().join('|');
        }
        if (value === undefined || value === null) return '';
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return String(value);
      }

      function listChangedConfigFields(before, after, scope) {
        const allowedFields = SAVE_SCOPE_FIELDS[scope] || null;
        const keys = new Set([
          ...Object.keys(before || {}),
          ...Object.keys(after || {}),
        ]);

        return Array.from(keys).filter((key) => {
          if (allowedFields && !allowedFields.has(key)) return false;
          return normalizeConfigValue(before ? before[key] : undefined) !== normalizeConfigValue(after ? after[key] : undefined);
        });
      }

      function formatFieldLabels(fields) {
        return fields
          .map((field) => CONFIG_FIELD_LABELS[field] || field)
          .join('、');
      }

      function buildConfigSaveMessage(before, after, scope) {
        const changed = listChangedConfigFields(before, after, scope);
        if (changed.length === 0) {
          return '配置未变更。';
        }

        const restartFields = changed.filter((field) => BRIDGE_RESTART_FIELDS.has(field));
        const autoSyncFields = changed.filter((field) => AUTO_SYNC_FIELDS.has(field));
        const immediateFields = changed.filter((field) => IMMEDIATE_FIELDS.has(field));
        const notes = [];

        if (immediateFields.length > 0) {
          notes.push('已即时生效：' + formatFieldLabels(immediateFields));
        }
        if (autoSyncFields.length > 0) {
          notes.push(
            (state.bridgeStatus && state.bridgeStatus.running)
              ? '会在几秒内自动同步：' + formatFieldLabels(autoSyncFields)
              : '会在下次启动 Bridge 时生效：' + formatFieldLabels(autoSyncFields),
          );
        }
        if (restartFields.length > 0) {
          notes.push(
            (state.bridgeStatus && state.bridgeStatus.running)
              ? '需要重启 Bridge 后生效：' + formatFieldLabels(restartFields)
              : '会在下次启动 Bridge 时生效：' + formatFieldLabels(restartFields),
          );
        }

        return '配置已保存。' + (notes.length > 0 ? ' ' + notes.join('；') + '。' : '');
      }

      function channelDisplayLabel(channel) {
        const alias = String(channel.alias || '').trim();
        const provider = providerLabel(channel.provider);
        if (!alias) return provider;
        return alias === provider ? alias : alias + ' · ' + provider;
      }

      function formatChannelRuntimeLabel(channel) {
        const label = channelDisplayLabel(channel);
        if (channel.enabled === false) {
          return label + '已停用。';
        }
        if (!state.bridgeStatus || !state.bridgeStatus.running) {
          return label + '已配置，但 Bridge 还没启动。';
        }
        const status = getAdapterStatus(channel.id);
        if (!status || !status.running) {
          return label + '已保存，Bridge 会在几秒内自动同步。';
        }
        return label + '已接通到当前运行中的 Bridge。';
      }

      function emptyBindingText(channel) {
        const label = channelDisplayLabel(channel);
        if (channel.enabled === false) {
          return label + '已停用。启用后才会创建聊天绑定。';
        }
        if (!state.bridgeStatus || !state.bridgeStatus.running) {
          return label + '已配置，但 Bridge 还没启动。启动后才会创建绑定。';
        }
        if (!isChannelRunning(channel.id)) {
          return label + '已配置，Bridge 会在几秒内自动同步；如果页面还没更新，可手动点“刷新状态”。';
        }
        return label + '当前还没有聊天接入。先从这个机器人发一条消息。';
      }

      function currentThreadMarks(threadId) {
        const marks = [];
        const currentTargetKey = 'desktop:' + threadId;
        const counts = new Map();

        for (const binding of state.bindings || []) {
          const matchesThread = binding.currentThreadId === threadId || binding.currentTargetKey === currentTargetKey;
          if (!matchesThread) continue;
          const label = (binding.channelAlias || providerLabel(binding.channelProvider)) + ' 当前';
          counts.set(label, (counts.get(label) || 0) + 1);
        }

        for (const [label, count] of counts.entries()) {
          marks.push(count > 1 ? label + ' x' + count : label);
        }

        return marks;
      }

      function bindingsForThread(threadId) {
        const currentTargetKey = 'desktop:' + threadId;
        return (state.bindings || []).filter((binding) => (
          binding.currentThreadId === threadId || binding.currentTargetKey === currentTargetKey
        ));
      }

      function projectNameFromCwd(cwd) {
        const value = String(cwd || '').trim();
        if (!value) return '(no cwd)';
        const parts = value.split(/[\\\\/]+/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : value;
      }

      function formatBindingAccount(binding) {
        const alias = String(binding.channelAlias || '').trim();
        const provider = providerLabel(binding.channelProvider);
        const channel = alias ? (alias === provider ? alias : alias + ' · ' + provider) : provider;
        return channel + ' · ' + (binding.chatDisplayName || binding.chatId);
      }

      function bindingRuntimeText(binding) {
        const status = binding.runtimeStatus || 'idle';
        const queuedCount = Number(binding.queuedCount || 0);
        if (status === 'queued') {
          return queuedCount > 0 ? '排队中（' + queuedCount + '）' : '排队中';
        }
        if (status === 'running') {
          return '运行中';
        }
        return '空闲';
      }

      function bindingMirrorText(binding) {
        if (binding.mirrorStatus === 'watching') {
          return binding.mirrorLastEventAt
            ? '监听中 · 最近同步 ' + formatTime(binding.mirrorLastEventAt)
            : '监听中';
        }
        if (binding.mirrorStatus === 'stale') {
          return '待恢复（暂时没定位到桌面 thread 文件）';
        }
        return '未监听';
      }

      function renderDesktopSessionCard(session) {
        const originator = session.originator || 'Codex Desktop';
        const marks = currentThreadMarks(session.threadId);
        const markHtml = marks.map((mark) => '<span class="session-mark">' + escapeHtml(mark) + '</span>').join('');

        return ''
          + '<article class="session-card' + (marks.length ? ' current-thread' : '') + '">'
          +   '<div class="session-head">'
          +     '<div class="session-main">'
          +       '<div class="session-title-row"><div class="session-title">' + escapeHtml(session.title || 'Untitled Session') + '</div>' + markHtml + '</div>'
          +       '<div class="session-thread">Thread: <code>' + escapeHtml(session.threadId) + '</code><button type="button" class="session-inline-action" data-action="copy-thread" data-thread-id="' + escapeHtml(session.threadId) + '">复制</button></div>'
          +     '</div>'
          +     '<div class="session-cell">'
          +       '<div class="session-label">来源</div>'
          +       '<div class="session-value">' + escapeHtml(originator) + '</div>'
          +     '</div>'
          +     '<div class="session-cell">'
          +       '<div class="session-label">目录</div>'
          +       '<div class="session-path">' + escapeHtml(session.cwd || '(no cwd)') + '</div>'
          +     '</div>'
          +     '<div class="session-actions">'
          +       '<button type="button" data-action="copy-thread" data-thread-id="' + escapeHtml(session.threadId) + '">复制 thread</button>'
          +       '<button type="button" data-action="copy-bind-command" data-thread-id="' + escapeHtml(session.threadId) + '">复制命令</button>'
          +   '</div>'
          + '</div>'
          + '</article>';
      }

      function renderBoundDesktopSessionCard(session) {
        const bindings = bindingsForThread(session.threadId);
        const marks = currentThreadMarks(session.threadId);
        const markHtml = marks.map((mark) => '<span class="session-mark">' + escapeHtml(mark) + '</span>').join('');
        const bindingTags = bindings.map((binding) => (
          '<div class="session-binding-tag">'
            + '<span class="session-binding-tag-label">' + escapeHtml(formatBindingAccount(binding)) + '</span>'
            + '<button type="button" data-action="unbind-binding" data-binding-id="' + escapeHtml(binding.id) + '" data-channel="' + escapeHtml(binding.channelType) + '">解绑</button>'
          + '</div>'
        )).join('');

        return ''
          + '<article class="session-card' + (marks.length ? ' current-thread' : '') + '">'
          +   '<div class="session-head">'
          +     '<div class="session-main">'
          +       '<div class="session-title-row"><div class="session-title">' + escapeHtml(session.title || 'Untitled Session') + '</div>' + markHtml + '</div>'
          +       '<div class="session-thread">Thread: <code>' + escapeHtml(session.threadId) + '</code></div>'
          +       '<div class="session-path">' + escapeHtml(session.cwd || '(no cwd)') + '</div>'
          +       '<div class="session-binding-tags">' + bindingTags + '</div>'
          +     '</div>'
          +     '<div class="session-cell">'
          +       '<div class="session-label">所属项目</div>'
          +       '<div class="session-value">' + escapeHtml(projectNameFromCwd(session.cwd)) + '</div>'
          +     '</div>'
          +     '<div class="session-cell">'
          +       '<div class="session-label">最近活动</div>'
          +       '<div class="session-value">' + escapeHtml(formatTime(session.lastEventAt || '')) + '</div>'
          +     '</div>'
          +     '<div class="session-cell">'
          +       '<div class="session-label">来源</div>'
          +       '<div class="session-value">' + escapeHtml(session.originator || 'Codex Desktop') + '</div>'
          +     '</div>'
          +   '</div>'
          + '</article>';
      }

      function renderDesktopSessionListItem(session) {
        const marks = currentThreadMarks(session.threadId);
        const markHtml = marks.map((mark) => '<span class="binding-table-mark">' + escapeHtml(mark) + '</span>').join('');

        return ''
          + '<article class="session-simple-item">'
          +   '<div class="session-simple-main">'
          +     '<div class="session-title-row"><div class="session-simple-title">' + escapeHtml(session.title || 'Untitled Session') + '</div>' + markHtml + '</div>'
          +     '<div class="session-simple-thread">Thread: <code>' + escapeHtml(session.threadId) + '</code></div>'
          +     '<div class="session-simple-time">最近活动：' + escapeHtml(formatTime(session.lastEventAt || '')) + '</div>'
          +   '</div>'
          +   '<div class="session-simple-side">'
          +     '<div class="session-simple-path">' + escapeHtml(session.cwd || '(no cwd)') + '</div>'
          +     '<div class="session-simple-time">来源：' + escapeHtml(session.originator || 'Codex Desktop') + '</div>'
          +   '</div>'
          +   '<div class="session-actions">'
          +     '<button type="button" data-action="copy-thread" data-thread-id="' + escapeHtml(session.threadId) + '">复制 thread</button>'
          +     '<button type="button" data-action="copy-bind-command" data-thread-id="' + escapeHtml(session.threadId) + '">复制命令</button>'
          +   '</div>'
          + '</article>';
      }

      function renderDesktopSessions(result) {
        state.desktopSessions = result.sessions || [];
        state.desktopRoot = result.root || '-';
        const sessions = state.desktopSessions || [];
        const boundSessions = sessions.filter((session) => bindingsForThread(session.threadId).length > 0);
        document.getElementById('desktopSessionCount').textContent = String(state.desktopSessions.length);
        document.getElementById('desktopSessionMeta').textContent =
          '扫描目录：' + state.desktopRoot + ' · ' + state.desktopSessions.length + ' 条桌面会话';
        document.getElementById('desktopRootStatus').textContent = state.desktopRoot;

        const boundList = document.getElementById('boundSessionsList');
        const boundMeta = document.getElementById('boundSessionsMeta');
        const list = document.getElementById('desktopSessionsList');
        const allMeta = document.getElementById('allSessionsMeta');
        boundMeta.textContent = boundSessions.length > 0
          ? '当前有 ' + boundSessions.length + ' 条桌面会话已绑定到聊天。'
          : '当前没有已绑定到聊天的桌面会话。';
        allMeta.textContent = '按最近活动排序，共 ' + sessions.length + ' 条。';

        if (boundSessions.length === 0) {
          boundList.innerHTML = '<div class="binding-empty">当前没有任何桌面会话正在绑定到聊天入口。</div>';
        } else {
          boundList.innerHTML = boundSessions.map((session) => renderBoundDesktopSessionCard(session)).join('');
        }

        if (state.desktopSessions.length === 0) {
          list.innerHTML = '<div class="notice ghost">当前没有发现桌面端会话。先在 Codex Desktop App 中打开或运行一个会话，再回到这里刷新。</div>';
          renderChannelsWorkspace();
          return;
        }

        list.innerHTML = '<div class="session-simple-list">'
          + sessions.map((session) => renderDesktopSessionListItem(session)).join('')
          + '</div>';

        renderChannelsWorkspace();
      }

      function rerenderDesktopSessions() {
        if (!state.desktopSessions.length && !state.desktopRoot) return;
        renderDesktopSessions({
          root: state.desktopRoot,
          sessions: state.desktopSessions,
        });
      }

      function bindingsForChannel(channelId) {
        return (state.bindings || []).filter((item) => item.channelType === channelId);
      }

      function ensureActiveBinding(channelId, bindings) {
        const current = state.activeBindingByChannelId[channelId];
        if (current && bindings.some((binding) => binding.id === current)) {
          return current;
        }
        const next = bindings[0] ? bindings[0].id : '';
        state.activeBindingByChannelId[channelId] = next;
        return next;
      }

      function ensureActiveChannelId() {
        if (state.channelDraft && state.activeChannelId === state.channelDraft.id) {
          return state.activeChannelId;
        }
        const channels = visibleChannels();
        if (state.activeChannelId && channels.some((channel) => channel.id === state.activeChannelId)) {
          return state.activeChannelId;
        }
        state.activeChannelId = channels[0] ? channels[0].id : '';
        return state.activeChannelId;
      }

      function getWeixinAccountOptions() {
        return Array.isArray(state.weixinAccounts) ? state.weixinAccounts : [];
      }

      function renderChannelList() {
        const list = document.getElementById('channelList');
        const meta = document.getElementById('channelListMeta');
        const channels = visibleChannels();

        meta.textContent = channels.length > 0
          ? '共 ' + channels.length + ' 个通道实例。每个实例是一个独立聊天入口。'
          : '当前还没有通道实例。先新增一个飞书或微信机器人。';

        if (channels.length === 0) {
          list.innerHTML = '<div class="binding-empty">当前还没有可用通道实例。</div>';
          return;
        }

        ensureActiveChannelId();
        list.innerHTML = channels.map((channel) => {
          const adapter = getAdapterStatus(channel.id);
          const active = channel.id === state.activeChannelId;
          const bindingCount = bindingsForChannel(channel.id).length;
          const statusText = channel.enabled === false
            ? '已停用'
            : adapter && adapter.running
              ? '运行中'
              : state.bridgeStatus && state.bridgeStatus.running
                ? '等待同步'
                : 'Bridge 未启动';
          return ''
            + '<button type="button" class="channel-list-item' + (active ? ' active' : '') + '" data-action="select-channel" data-channel-id="' + escapeHtml(channel.id) + '">'
            +   '<div class="channel-list-item-head">'
            +     '<div class="channel-list-item-title">' + escapeHtml(channel.alias) + '</div>'
            +     '<span class="channel-list-item-provider">' + escapeHtml(providerLabel(channel.provider)) + '</span>'
            +   '</div>'
            +   '<div class="channel-list-item-stats">'
            +     '<span class="channel-list-item-status">' + escapeHtml(statusText) + '</span>'
            +     '<span>' + escapeHtml(bindingCount === 0 ? '未绑定聊天' : ('已绑定 ' + bindingCount + ' 个聊天')) + '</span>'
            +   '</div>'
            +   '<div class="channel-list-item-meta">' + escapeHtml(channel.id) + '</div>'
            + '</button>';
        }).join('');
      }

      function renderChannelBindingsV2(channel) {
        const bindings = bindingsForChannel(channel.id);
        const emptyText = emptyBindingText(channel);
        if (bindings.length === 0) {
          return '<div class="binding-empty">' + escapeHtml(emptyText) + '</div>';
        }

        const activeBindingId = ensureActiveBinding(channel.id, bindings);
        const activeBinding = bindings.find((binding) => binding.id === activeBindingId) || bindings[0];
        const tabs = bindings.length > 1
          ? '<div class="binding-tabs">' + bindings.map((binding) => (
              '<button type="button" class="binding-tab' + (binding.id === activeBinding.id ? ' active' : '') + '"'
                + ' data-action="select-binding-tab"'
                + ' data-channel-id="' + escapeHtml(channel.id) + '"'
                + ' data-binding-id="' + escapeHtml(binding.id) + '"'
                + ' title="' + escapeHtml(binding.chatId) + '">'
                + escapeHtml(bindingTabLabel(binding))
              + '</button>'
            )).join('') + '</div>'
          : '';

        return ''
          + '<div class="small">当前已发现 ' + bindings.length + ' 个聊天绑定。一个会话同一时刻只能绑定一个聊天。</div>'
          + tabs
          + renderBindingCard(activeBinding);
      }

      function renderChannelEditor() {
        const editor = document.getElementById('channelEditor');
        const channel = getChannelById(ensureActiveChannelId());
        if (!channel) {
          editor.innerHTML = '<div class="binding-empty">请选择一个通道实例，或先创建新通道。</div>';
          return;
        }

        const adapter = getAdapterStatus(channel.id);
        const statusText = formatChannelRuntimeLabel(channel);
        const feishu = channel.provider === 'feishu' ? (channel.config || {}) : {};
        const weixin = channel.provider === 'weixin' ? (channel.config || {}) : {};
        const weixinAccounts = getWeixinAccountOptions();
        const weixinAccountOptions = ['<option value="">未绑定账号</option>'].concat(
          weixinAccounts.map((account) => (
            '<option value="' + escapeHtml(account.accountId) + '"' + (account.accountId === weixin.accountId ? ' selected' : '') + '>'
              + escapeHtml(account.name || account.accountId)
            + '</option>'
          )),
        ).join('');
        const bindingsHtml = renderChannelBindingsV2(channel);
        const bindingCount = bindingsForChannel(channel.id).length;
        const detailsHtml = channel.provider === 'feishu'
          ? ''
            + '<div class="editor-section">'
            +   '<p class="editor-section-title">连接配置</p>'
            +   '<div class="field-row">'
            +     '<label>App ID<input id="channelAppId" value="' + escapeHtml(feishu.appId || '') + '" /></label>'
            +     '<label>App Secret<input id="channelAppSecret" value="' + escapeHtml(feishu.appSecret || '') + '" /></label>'
            +   '</div>'
            +   '<div class="field-row">'
            +     '<label>站点<select id="channelSite">'
            +       '<option value="feishu"' + ((feishu.site || 'feishu') === 'feishu' ? ' selected' : '') + '>Feishu</option>'
            +       '<option value="lark"' + (feishu.site === 'lark' ? ' selected' : '') + '>Lark</option>'
            +     '</select></label>'
            +     '<label>Allowed Users<input id="channelAllowedUsers" value="' + escapeHtml(Array.isArray(feishu.allowedUsers) ? feishu.allowedUsers.join(', ') : '') + '" placeholder="多个 user_id 用逗号分隔" /></label>'
            +   '</div>'
            + '</div>'
            + '<div class="editor-section">'
            +   '<p class="editor-section-title">行为开关</p>'
            +   '<div class="checkbox-row">'
            +     '<label class="checkbox"><input id="channelStreamingEnabled" type="checkbox"' + (feishu.streamingEnabled !== false ? ' checked' : '') + ' /> 启用飞书流式响应卡片</label>'
            +     '<label class="checkbox"><input id="channelFeedbackMarkdownEnabled" type="checkbox"' + (feishu.feedbackMarkdownEnabled !== false ? ' checked' : '') + ' /> 反馈使用markdown</label>'
            +   '</div>'
            + '</div>'
          : ''
            + '<div class="editor-section">'
            +   '<p class="editor-section-title">连接配置</p>'
            +   '<div class="field-row">'
            +     '<label>微信账号<select id="channelAccountId">' + weixinAccountOptions + '</select></label>'
            +     '<label>Base URL<input id="channelBaseUrl" value="' + escapeHtml(weixin.baseUrl || '') + '" /></label>'
            +   '</div>'
            +   '<div class="field-row">'
            +     '<label>CDN Base URL<input id="channelCdnBaseUrl" value="' + escapeHtml(weixin.cdnBaseUrl || '') + '" /></label>'
            +     '<div></div>'
            +   '</div>'
            + '</div>'
            + '<div class="editor-section">'
            +   '<p class="editor-section-title">行为开关</p>'
            +   '<div class="checkbox-row">'
            +     '<label class="checkbox"><input id="channelMediaEnabled" type="checkbox"' + (weixin.mediaEnabled === true ? ' checked' : '') + ' /> 启用图片 / 文件 / 视频入站下载</label>'
            +     '<label class="checkbox"><input id="channelFeedbackMarkdownEnabled" type="checkbox"' + (weixin.feedbackMarkdownEnabled === true ? ' checked' : '') + ' /> 反馈使用markdown</label>'
            +   '</div>'
            + '</div>';

        editor.innerHTML = ''
          + '<div class="panel-header">'
          +   '<div>'
            +     '<h2>' + escapeHtml(channel.alias) + '</h2>'
            +     '<p>' + escapeHtml(statusText) + (adapter && adapter.lastMessageAt ? ' · 最近消息 ' + escapeHtml(formatTime(adapter.lastMessageAt)) : '') + '</p>'
          +   '</div>'
          +   '<div class="toolbar-split">'
          +     '<div class="toolbar">'
          +       '<button type="button" data-action="channel-save" data-channel-id="' + escapeHtml(channel.id) + '" class="primary">保存通道</button>'
          +       '<button type="button" data-action="channel-test" data-channel-id="' + escapeHtml(channel.id) + '">测试当前通道</button>'
          +       (channel.provider === 'weixin' ? '<button type="button" data-action="channel-weixin-login" data-channel-id="' + escapeHtml(channel.id) + '">开始微信扫码</button>' : '')
          +     '</div>'
          +     '<div class="toolbar-danger">'
          +       '<button type="button" data-action="channel-delete" data-channel-id="' + escapeHtml(channel.id) + '" class="danger">删除通道</button>'
          +     '</div>'
          +   '</div>'
          + '</div>'
          + '<div class="channel-editor-summary">'
          +   '<div class="channel-editor-stat"><strong>当前状态</strong><span>' + escapeHtml(statusText) + '</span></div>'
          +   '<div class="channel-editor-stat"><strong>聊天绑定</strong><span>' + escapeHtml(String(bindingCount)) + '</span></div>'
          +   '<div class="channel-editor-stat"><strong>Provider</strong><span>' + escapeHtml(providerLabel(channel.provider)) + '</span></div>'
          + '</div>'
          + '<div class="fields">'
          +   '<div class="editor-section">'
          +     '<p class="editor-section-title">基础信息</p>'
          +     '<div class="field-row triple">'
          +       '<label>别名<input id="channelAliasInput" value="' + escapeHtml(channel.alias) + '" /></label>'
          +       '<label>实例 ID<input value="' + escapeHtml(channel.id) + '" disabled /></label>'
          +       '<label>Provider<input value="' + escapeHtml(providerLabel(channel.provider)) + '" disabled /></label>'
          +     '</div>'
          +     '<div class="checkbox-row">'
          +       '<label class="checkbox"><input id="channelEnabledInput" type="checkbox"' + (channel.enabled !== false ? ' checked' : '') + ' /> 启用当前通道</label>'
          +     '</div>'
          +   '</div>'
          +   detailsHtml
          + '</div>'
          + '<div class="panel-block">'
          +   '<p class="panel-subtitle">当前绑定</p>'
          +   bindingsHtml
          + '</div>';
      }

      function renderChannelsWorkspace() {
        renderChannelList();
        renderChannelEditor();
      }

      function renderBindings(result) {
        state.bindings = result.bindings || [];
        state.bindingOptions = result.options || [];
        document.getElementById('bindingCount').textContent = String(state.bindings.length);
        renderChannelsWorkspace();
        rerenderDesktopSessions();
      }

      function renderUiAccess() {
        const config = state.config || {};
        const uiAccess = state.uiAccess || {};
        const allowLan = config.uiAllowLan === true;
        const token = config.uiAccessToken || '';
        const lanUrls = Array.isArray(uiAccess.lanUrls) ? uiAccess.lanUrls : [];
        const localUrl = uiAccess.localUrl || window.location.origin;
        const summary = document.getElementById('uiAccessSummary');
        const details = document.getElementById('uiLanDetails');
        const tokenInput = document.getElementById('uiAccessToken');
        const urlList = document.getElementById('uiAccessUrls');
        const copyTokenBtn = document.getElementById('copyUiTokenBtn');
        const copyLanLinkBtn = document.getElementById('copyUiLanLinkBtn');

        document.getElementById('uiAllowLan').checked = allowLan;
        tokenInput.value = token;
        details.hidden = !allowLan;
        copyTokenBtn.disabled = !allowLan || !token;
        copyLanLinkBtn.disabled = !allowLan || !token || lanUrls.length === 0;

        if (!allowLan) {
          summary.textContent = '默认仅允许本机访问当前工作台。开启后，局域网设备需要先输入访问 token。';
          urlList.innerHTML = '';
          return;
        }

        summary.textContent = '局域网访问已开启。非本机设备访问时需要先输入 token；本机访问仍然不受影响。';
        const items = [
          '<div class="info-item"><strong>本机地址</strong><div class="mono">' + escapeHtml(localUrl) + '</div></div>',
        ];

        if (lanUrls.length === 0) {
          items.push('<div class="info-item"><strong>局域网地址</strong><div>未检测到可用的 IPv4 地址，请检查网络连接。</div></div>');
        } else {
          for (const lanUrl of lanUrls) {
            items.push(
              '<div class="info-item"><strong>局域网地址</strong><div class="mono">' + escapeHtml(lanUrl) + '</div><div class="small">登录链接：' + escapeHtml(lanUrl + '/?token=' + token) + '</div></div>'
            );
          }
        }

        urlList.innerHTML = items.join('');
      }

      function fillForm(config) {
        state.config = config;
        document.getElementById('runtime').value = config.runtime || 'codex';
        document.getElementById('defaultMode').value = config.defaultMode || 'code';
        document.getElementById('historyMessageLimit').value = String(config.historyMessageLimit || 8);
        document.getElementById('defaultWorkspaceRoot').value = config.defaultWorkspaceRoot || '';
        renderDefaultModelOptions(config);
        document.getElementById('codexSkipGitRepoCheck').checked = config.codexSkipGitRepoCheck === true;
        document.getElementById('codexSandboxMode').value = config.codexSandboxMode || 'workspace-write';
        document.getElementById('codexReasoningEffort').value = config.codexReasoningEffort || 'medium';
        document.getElementById('uiAllowLan').checked = config.uiAllowLan === true;
        document.getElementById('uiAccessToken').value = config.uiAccessToken || '';
        document.getElementById('autoApprove').checked = config.autoApprove === true;
        renderUiAccess();
        ensureActiveChannelId();
        renderChannelsWorkspace();
        rerenderDesktopSessions();
      }

      async function api(path, options) {
        const response = await fetch(path, Object.assign({
          headers: { 'Content-Type': 'application/json' },
        }, options || {}));
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(data.error || text || 'Request failed');
        }
        return data;
      }

      async function loadStatus() {
        const status = await api('/api/status');
        const config = await api('/api/config');
        state.uiAccess = status.uiAccess || null;
        state.bridgeStatus = status.bridge || null;
        state.autostartStatus = status.autostart || null;
        state.weixinAccounts = status.weixin && Array.isArray(status.weixin.linkedAccounts) ? status.weixin.linkedAccounts : [];
        fillForm(config);
        const runningChannelText = adapterStatuses().length
          ? ' · ' + adapterStatuses().filter((item) => item.running).map((item) => item.channelAlias || item.channelType).join(', ')
          : '';
        document.getElementById('bridgeStatus').textContent = status.bridge.running ? 'Running' + runningChannelText : 'Stopped';
        renderAutostartStatus(status.autostart || null);
        document.getElementById('integrationStatus').textContent = status.codexIntegrationInstalled ? '已安装' : '未安装';
        document.getElementById('runtimeStatus').textContent = config.runtime || 'codex';
        document.getElementById('homeStatus').textContent = status.home;
        document.getElementById('overviewHomeStatus').textContent = status.home;
        document.getElementById('packageRoot').textContent = status.packageRoot;
        renderBindings({
          bindings: state.bindings,
          options: state.bindingOptions,
        });
      }

      function renderAutostartStatus(status) {
        const valueEl = document.getElementById('autostartStatus');
        const noticeEl = document.getElementById('autostartNotice');
        const refreshBtn = document.getElementById('refreshAutostartBtn');

        if (!status || status.supported !== true) {
          valueEl.textContent = '不支持';
          noticeEl.textContent = status && status.error
            ? status.error
            : '当前系统暂不支持 Bridge 开机自启动。';
          refreshBtn.disabled = true;
          return;
        }

        if (status.error) {
          valueEl.textContent = '配置异常';
          noticeEl.textContent = status.error;
          refreshBtn.disabled = false;
          return;
        }

        if (!status.installed) {
          valueEl.textContent = '未启用';
          noticeEl.textContent = [
            '如需启用，请以管理员身份打开 PowerShell 或终端执行：',
            'codex-to-im autostart install',
            status.runAsUser ? '运行账号：' + status.runAsUser : '',
            '安装时会要求输入当前 Windows 登录密码。',
          ].filter(Boolean).join('\\n');
          refreshBtn.disabled = false;
          return;
        }

        valueEl.textContent = status.enabled ? '已启用' : '已禁用';
        noticeEl.textContent = [
          '方式：Windows 任务计划程序（开机触发）',
          status.runAsUser ? '运行账号：' + status.runAsUser : '',
          status.state ? '任务状态：' + status.state : '',
          '如需关闭，请以管理员身份执行：codex-to-im autostart uninstall',
        ].filter(Boolean).join(' · ');
        refreshBtn.disabled = false;
      }

      async function loadLogs() {
        const logs = await api('/api/logs?lines=220');
        document.getElementById('logsOutput').textContent = logs.logs || '暂无日志';
      }

      async function loadDesktopSessions() {
        const result = await api('/api/desktop-sessions');
        renderDesktopSessions(result);
      }

      async function loadBindings() {
        const result = await api('/api/bindings');
        renderBindings(result);
      }

      async function saveConfig(options) {
        const opts = options || {};
        const beforeConfig = state.config || {};
        const saved = await api('/api/config', {
          method: 'POST',
          body: JSON.stringify(formPayload()),
        });
        fillForm(saved.config);
        if (opts.messageId) {
          showMessage(
            opts.messageId,
            'success',
            buildConfigSaveMessage(beforeConfig, saved.config, opts.scope || 'all'),
          );
        }
        return saved;
      }

      function createChannelDraft(provider) {
        state.channelDraft = {
          id: '__draft__:' + provider,
          alias: providerLabel(provider),
          provider,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          config: provider === 'feishu'
            ? {
                appId: '',
                appSecret: '',
                site: 'feishu',
                allowedUsers: [],
                streamingEnabled: true,
                feedbackMarkdownEnabled: true,
              }
            : {
                accountId: '',
                baseUrl: '',
                cdnBaseUrl: '',
                mediaEnabled: false,
                feedbackMarkdownEnabled: false,
              },
        };
        state.activeChannelId = state.channelDraft.id;
        renderChannelsWorkspace();
      }

      function currentChannelEditorPayload(channel) {
        const payload = {
          provider: channel.provider,
          alias: document.getElementById('channelAliasInput').value,
          enabled: document.getElementById('channelEnabledInput').checked,
        };

        if (!String(channel.id || '').startsWith('__draft__:')) {
          payload.id = channel.id;
        }

        if (channel.provider === 'feishu') {
          payload.appId = document.getElementById('channelAppId').value;
          payload.appSecret = document.getElementById('channelAppSecret').value;
          payload.site = document.getElementById('channelSite').value;
          payload.allowedUsers = document.getElementById('channelAllowedUsers').value;
          payload.streamingEnabled = document.getElementById('channelStreamingEnabled').checked;
          payload.feedbackMarkdownEnabled = document.getElementById('channelFeedbackMarkdownEnabled').checked;
          return payload;
        }

        payload.accountId = document.getElementById('channelAccountId').value;
        payload.baseUrl = document.getElementById('channelBaseUrl').value;
        payload.cdnBaseUrl = document.getElementById('channelCdnBaseUrl').value;
        payload.mediaEnabled = document.getElementById('channelMediaEnabled').checked;
        payload.feedbackMarkdownEnabled = document.getElementById('channelFeedbackMarkdownEnabled').checked;
        return payload;
      }

      async function saveChannel(channel) {
        const result = await api('/api/channels/save', {
          method: 'POST',
          body: JSON.stringify(currentChannelEditorPayload(channel)),
        });
        state.channelDraft = null;
        fillForm(result.config);
        renderBindings(result);
        setActiveChannel(result.channel.id, false);
        return result;
      }

      async function deleteCurrentChannel(channel) {
        if (String(channel.id || '').startsWith('__draft__:')) {
          state.channelDraft = null;
          state.activeChannelId = '';
          renderChannelsWorkspace();
          showMessage('channelMessage', 'success', '未保存的新通道已取消。');
          return;
        }

        const result = await api('/api/channels/delete', {
          method: 'POST',
          body: JSON.stringify({ channelId: channel.id }),
        });
        state.channelDraft = null;
        fillForm(result.config);
        renderBindings(result);
        showMessage('channelMessage', 'success', '通道已删除。');
      }

      async function testCurrentChannel(channel) {
        if (String(channel.id || '').startsWith('__draft__:')) {
          const saved = await saveChannel(channel);
          channel = getChannelById(saved.channel.id);
        } else {
          await saveChannel(channel);
          channel = getChannelById(channel.id);
        }
        const result = await api('/api/channels/test', {
          method: 'POST',
          body: JSON.stringify({ channelId: channel.id }),
        });
        showMessage('channelMessage', result.ok ? 'success' : 'error', result.message);
      }

      async function loginWeixinForChannel(channel) {
        if (String(channel.id || '').startsWith('__draft__:')) {
          const saved = await saveChannel(channel);
          channel = getChannelById(saved.channel.id);
        } else {
          await saveChannel(channel);
          channel = getChannelById(channel.id);
        }
        const result = await api('/api/channels/weixin-login', {
          method: 'POST',
          body: JSON.stringify({ channelId: channel.id }),
        });
        fillForm(result.config || state.config);
        await loadStatus();
        showMessage('channelMessage', result.ok ? 'success' : 'error', result.message);
      }

      async function handleChannelEditorAction(event) {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-action]') : null;
        if (!target) return;

        const channelId = target.dataset.channelId || state.activeChannelId;
        const channel = getChannelById(channelId);
        if (!channel) return;

        try {
          if (target.dataset.action === 'channel-save') {
            await saveChannel(channel);
            showMessage('channelMessage', 'success', '通道已保存。');
            return;
          }
          if (target.dataset.action === 'channel-test') {
            await testCurrentChannel(channel);
            return;
          }
          if (target.dataset.action === 'channel-delete') {
            await deleteCurrentChannel(channel);
            return;
          }
          if (target.dataset.action === 'channel-weixin-login') {
            await loginWeixinForChannel(channel);
            return;
          }
          if (target.dataset.action === 'select-binding-tab') {
            state.activeBindingByChannelId[channel.id] = target.dataset.bindingId || '';
            renderChannelsWorkspace();
            return;
          }
          if (target.dataset.action === 'unbind-binding') {
            const result = await api('/api/bindings/delete', {
              method: 'POST',
              body: JSON.stringify({ bindingId: target.dataset.bindingId }),
            });
            renderBindings(result);
            showMessage('channelMessage', 'success', '聊天绑定已解绑。');
            return;
          }
          if (target.dataset.action === 'switch-binding-target') {
            const result = await api('/api/bindings/update', {
              method: 'POST',
              body: JSON.stringify({
                bindingId: target.dataset.bindingId,
                targetKey: target.dataset.targetKey,
              }),
            });
            renderBindings(result);
            showMessage('channelMessage', 'success', '聊天绑定已更新。');
          }
        } catch (error) {
          showMessage('channelMessage', 'error', error.message);
        }
      }

      document.querySelectorAll('.nav-link').forEach((element) => {
        element.addEventListener('click', () => {
          setActivePage(element.dataset.page || 'overview', true);
        });
      });

      window.addEventListener('hashchange', syncPageFromHash);

      document.getElementById('copyUiTokenBtn').addEventListener('click', async () => {
        try {
          await copyText(document.getElementById('uiAccessToken').value, '访问 token 已复制。');
        } catch (error) {
          showMessage('configMessage', 'error', error.message);
        }
      });

      document.getElementById('copyUiLanLinkBtn').addEventListener('click', async () => {
        try {
          const urls = state.uiAccess && Array.isArray(state.uiAccess.lanUrls) ? state.uiAccess.lanUrls : [];
          const token = document.getElementById('uiAccessToken').value;
          if (!urls.length || !token) {
            throw new Error('当前还没有可复制的局域网登录链接。');
          }
          await copyText(urls[0] + '/?token=' + token, '局域网登录链接已复制。');
        } catch (error) {
          showMessage('configMessage', 'error', error.message);
        }
      });

      document.getElementById('regenerateUiTokenBtn').addEventListener('click', () => {
        if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
          showMessage('configMessage', 'error', '当前浏览器不支持生成 token。');
          return;
        }
        document.getElementById('uiAccessToken').value =
          window.crypto.randomUUID().replaceAll('-', '') + window.crypto.randomUUID().replaceAll('-', '');
        renderUiAccess();
        showMessage('configMessage', 'success', '已生成新的访问 token，点击“保存配置”后生效。');
      });

      document.getElementById('saveConfigBtn').addEventListener('click', async () => {
        try {
          await saveConfig({ messageId: 'configMessage', scope: 'all' });
          await loadStatus();
          await loadBindings();
        } catch (error) {
          showMessage('configMessage', 'error', error.message);
        }
      });

      document.getElementById('startBridgeBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          const result = await api('/api/bridge/start', { method: 'POST' });
          showMessage('opsMessage', 'success', 'Bridge 已启动。PID: ' + (result.status.pid || '-'));
          await loadStatus();
          await loadBindings();
          await loadLogs();
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
          await loadLogs();
        }
      });

      document.getElementById('stopBridgeBtn').addEventListener('click', async () => {
        try {
          await api('/api/bridge/stop', { method: 'POST' });
          showMessage('opsMessage', 'success', 'Bridge 已停止。');
          await loadStatus();
          await loadBindings();
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
        }
      });

      document.getElementById('restartBridgeBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          const result = await api('/api/bridge/restart', { method: 'POST' });
          showMessage('opsMessage', 'success', 'Bridge 已重启。PID: ' + (result.status.pid || '-'));
          await loadStatus();
          await loadBindings();
          await loadLogs();
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
          await loadLogs();
        }
      });

      document.getElementById('testCodexBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          const result = await api('/api/test/codex', { method: 'POST' });
          showMessage('opsMessage', result.ok ? 'success' : 'error', result.message);
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
        }
      });

      document.getElementById('refreshBtn').addEventListener('click', async () => {
        try {
          await loadStatus();
          await loadBindings();
          await loadDesktopSessions();
          await loadLogs();
          showMessage('opsMessage', 'success', '状态已刷新。');
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
        }
      });

      document.getElementById('refreshAutostartBtn').addEventListener('click', async () => {
        try {
          await loadStatus();
          showMessage('opsMessage', 'success', '开机自启动状态已刷新。');
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
        }
      });

      document.getElementById('installIntegrationBtn').addEventListener('click', async () => {
        try {
          const result = await api('/api/install-codex-integration', { method: 'POST' });
          showMessage('opsMessage', 'success', '可选 Codex Skill 已处理：' + result.method + ' -> ' + result.targetDir);
          await loadStatus();
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
        }
      });

      document.getElementById('refreshLogsBtn').addEventListener('click', async () => {
        try {
          await loadLogs();
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
        }
      });

      document.getElementById('refreshDesktopBtn').addEventListener('click', async () => {
        try {
          await loadDesktopSessions();
          showMessage('desktopMessage', 'success', '桌面会话列表已刷新。');
        } catch (error) {
          showGlobalMessage('error', error.message);
        }
      });

      document.getElementById('createChannelBtn').addEventListener('click', () => {
        const provider = document.getElementById('newChannelProvider').value === 'weixin' ? 'weixin' : 'feishu';
        createChannelDraft(provider);
        setActivePage('channels', false);
        setActiveChannel(state.activeChannelId, true);
      });

      document.getElementById('refreshChannelsBtn').addEventListener('click', async () => {
        try {
          await loadStatus();
          await loadBindings();
          showMessage('channelMessage', 'success', '通道状态已刷新。');
        } catch (error) {
          showMessage('channelMessage', 'error', error.message);
        }
      });

      document.getElementById('channelList').addEventListener('click', (event) => {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-channel-id]') : null;
        if (!target) return;
        setActivePage('channels', false);
        setActiveChannel(target.dataset.channelId || '', true);
      });

      document.getElementById('channelEditor').addEventListener('click', (event) => {
        handleChannelEditorAction(event);
      });

      async function handleSessionListAction(event) {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-action]') : null;
        if (!target) return;

        try {
          if (target.dataset.action === 'copy-thread') {
            await copyText(target.dataset.threadId || '', 'Thread ID 已复制。');
            return;
          }
          if (target.dataset.action === 'copy-bind-command') {
            await copyText(shortThreadCommand(target.dataset.threadId || ''), '接管命令已复制。');
            return;
          }
        } catch (error) {
          showMessage('desktopMessage', 'error', error.message);
        }
      }

      document.getElementById('desktopSessionsList').addEventListener('click', handleSessionListAction);
      document.getElementById('boundSessionsList').addEventListener('click', async (event) => {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-action]') : null;
        if (!target) return;

        if (target.dataset.action === 'unbind-binding') {
          try {
            const result = await api('/api/bindings/delete', {
              method: 'POST',
              body: JSON.stringify({ bindingId: target.dataset.bindingId }),
            });
            renderBindings(result);
            showMessage('desktopMessage', 'success', '聊天绑定已解绑。');
          } catch (error) {
            showMessage('desktopMessage', 'error', error.message);
          }
          return;
        }

        await handleSessionListAction(event);
      });

      syncPageFromHash();

      Promise.all([loadStatus(), loadBindings(), loadDesktopSessions(), loadLogs()]).catch((error) => {
        showMessage('opsMessage', 'error', error.message);
      });

    </script>
  </body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', getUiServerUrl(port));
    const config = loadConfig();
    const localRequest = isLocalRequest(request);
    const queryToken = asString(url.searchParams.get('token'));

    if (
      request.method === 'GET'
      && !localRequest
      && config.uiAllowLan === true
      && timingSafeMatch(queryToken, config.uiAccessToken)
    ) {
      const redirectUrl = new URL(url.pathname || '/', getUiServerUrl(port));
      redirect(response, `${redirectUrl.pathname}${redirectUrl.search}`, makeAuthCookie(config.uiAccessToken || ''));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/login') {
      if (localRequest || isRemoteAuthenticated(request, config)) {
        redirect(response, '/');
        return;
      }
      if (config.uiAllowLan !== true) {
        html(response, renderAccessDeniedHtml());
        return;
      }
      html(response, renderLoginHtml());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (config.uiAllowLan !== true) {
        json(response, 403, { error: '当前未开启局域网访问。' });
        return;
      }
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const token = asString(payload.token);
      if (!timingSafeMatch(token, config.uiAccessToken)) {
        json(response, 401, { error: '访问 token 不正确。' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': makeAuthCookie(config.uiAccessToken || ''),
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': clearAuthCookie(),
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      if (!localRequest) {
        if (config.uiAllowLan !== true) {
          html(response, renderAccessDeniedHtml());
          return;
        }
        if (!isRemoteAuthenticated(request, config)) {
          html(response, renderLoginHtml());
          return;
        }
      }
      html(response, renderHtml());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/ping') {
      json(response, 200, { ok: true });
      return;
    }

    if (!localRequest) {
      if (config.uiAllowLan !== true) {
        json(response, 403, { error: '当前未开启局域网访问。' });
        return;
      }
      if (!isRemoteAuthenticated(request, config)) {
        json(response, 401, { error: '需要先登录并提供访问 token。' });
        return;
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, 200, {
        bridge: getBridgeStatus(),
        autostart: await getBridgeAutostartStatus(),
        ui: getUiServerStatus(),
        uiAccess: buildUiAccessInfo(port, config, request),
        home: CTI_HOME,
        packageRoot: getPackageRoot(),
        codexIntegrationInstalled: isCodexIntegrationInstalled(),
        weixin: {
          linkedAccounts: getWeixinAccountsPayload(),
        },
        startedAt: serverStartTime,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      json(response, 200, configToPayload(config));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/desktop-sessions') {
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? parsePositiveInt(limitParam, 10) : undefined;
      json(response, 200, {
        root: getCodexSessionsRoot(),
        sessions: listDesktopSessions(limit),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/bindings') {
      const store = createUiStore();
      json(response, 200, await buildBindingsPayload(store, config));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const config = mergeConfig(payload);
      saveConfig(config);
      json(response, 200, { ok: true, config: configToPayload(loadConfig()) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/channels/save') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const current = loadConfig();
      const merged = mergeChannelInstance(payload, current);
      saveConfig(merged.config);
      const store = createUiStore();
      syncBindingChannelMeta(store, merged.channel);
      json(response, 200, {
        ok: true,
        channel: channelToPayload(merged.channel),
        config: configToPayload(loadConfig()),
        ...(await buildBindingsPayload(store, loadConfig())),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/channels/delete') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const channelId = asString(payload.channelId);
      if (!channelId) {
        json(response, 400, { error: 'channelId 不能为空。' });
        return;
      }

      const store = createUiStore();
      const bindings = store.listChannelBindings(channelId);
      if (bindings.length > 0) {
        json(response, 400, { error: '该通道仍有聊天绑定，请先解绑后再删除。' });
        return;
      }

      const next = deleteChannelInstance(loadConfig(), channelId);
      saveConfig(next);
      json(response, 200, {
        ok: true,
        config: configToPayload(loadConfig()),
        ...(await buildBindingsPayload(store, loadConfig())),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/channels/test') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const channelId = asString(payload.channelId);
      if (!channelId) {
        json(response, 400, { error: 'channelId 不能为空。' });
        return;
      }
      const channel = findChannelInstance(channelId, loadConfig());
      if (!channel) {
        json(response, 404, { error: '指定的通道不存在。' });
        return;
      }

      if (channel.provider === 'feishu') {
        json(response, 200, await validateFeishuCredentials(channel));
        return;
      }

      json(response, 200, {
        ok: true,
        message: '微信通道请使用“开始微信扫码”并选择登录账号进行验证。',
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/channels/weixin-login') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const channelId = asString(payload.channelId);
      const current = loadConfig();
      const channel = channelId ? findChannelInstance(channelId, current) : undefined;
      const loginConfig = channel?.provider === 'weixin'
        ? channel.config as WeixinChannelConfig
        : {};
      const result = await runWeixinLogin(loginConfig);

      if (channelId) {
        if (channel && channel.provider === 'weixin') {
          const merged = mergeChannelInstance({
            id: channel.id,
            provider: channel.provider,
            alias: channel.alias,
            enabled: channel.enabled,
            accountId: result.accountId,
            baseUrl: (channel.config as WeixinChannelConfig).baseUrl,
            cdnBaseUrl: (channel.config as WeixinChannelConfig).cdnBaseUrl,
            mediaEnabled: (channel.config as WeixinChannelConfig).mediaEnabled === true,
            feedbackMarkdownEnabled: (channel.config as WeixinChannelConfig).feedbackMarkdownEnabled === true,
          }, current);
          saveConfig(merged.config);
        }
      }

      json(response, 200, {
        ok: true,
        message: `微信扫码成功，账号 ${result.accountId} 已保存。`,
        htmlPath: result.htmlPath,
        config: configToPayload(loadConfig()),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/test/codex') {
      const result = await testCodexConnection(loadConfig());
      json(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/install-codex-integration') {
      const result = await installCodexIntegration();
      json(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/bridge/start') {
      const status = await startBridge();
      json(response, 200, { ok: true, status });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/bridge/stop') {
      const status = await stopBridge();
      json(response, 200, { ok: true, status });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/bridge/restart') {
      const status = await restartBridge();
      json(response, 200, { ok: true, status });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/bindings/update') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const bindingId = asString(payload.bindingId);
      const targetKey = asString(payload.targetKey);
      if (!bindingId || !targetKey) {
        json(response, 400, { error: 'bindingId 和 targetKey 不能为空。' });
        return;
      }

      const store = createUiStore();
      const updated = updateBindingTarget(store, bindingId, targetKey);
      json(response, 200, {
        ok: true,
        updated,
        ...(await buildBindingsPayload(store, loadConfig())),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/bindings/delete') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const bindingId = asString(payload.bindingId);
      if (!bindingId) {
        json(response, 400, { error: 'bindingId 不能为空。' });
        return;
      }

      const store = createUiStore();
      removeBinding(store, bindingId);
      json(response, 200, {
        ok: true,
        ...(await buildBindingsPayload(store, loadConfig())),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/logs') {
      const lines = Number(url.searchParams.get('lines') || '200');
      json(response, 200, { logs: getBridgeLogs(lines) });
      return;
    }

    text(response, 404, 'Not found');
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function startServer(): Promise<void> {
  port = await resolveUiPort(parsePreferredPort());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  writeUiServerStatus({
    running: true,
    pid: process.pid,
    port,
    startedAt: serverStartTime,
  });
  console.log(`[codex-to-im] UI server ready at ${getUiServerUrl(port)}`);
}

const cleanup = () => {
  writeUiServerStatus({
    running: false,
    pid: process.pid,
    port,
    startedAt: serverStartTime,
  });
  server.close(() => process.exit(0));
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

startServer().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('[codex-to-im] Failed to start UI server:', message);
  writeUiServerStatus({
    running: false,
    pid: process.pid,
    port,
    startedAt: serverStartTime,
  });
  process.exit(1);
});
