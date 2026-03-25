import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';

import { CTI_HOME, configToSettings, loadConfig, saveConfig, type Config } from './config.js';
import { PendingPermissions } from './permission-gateway.js';
import { CodexProvider } from './codex-provider.js';
import { getCodexSessionsRoot, listDesktopSessions } from './desktop-sessions.js';
import {
  getChannelBindingSummaries,
  listBindingSummaries,
  listBindingTargetOptions,
  updateBindingTarget,
} from './session-bindings.js';
import {
  getBridgeLogs,
  getBridgeStatus,
  getPackageRoot,
  getUiServerStatus,
  getUiServerUrl,
  installCodexIntegration,
  isCodexIntegrationInstalled,
  restartBridge,
  startBridge,
  stopBridge,
  writeUiServerStatus,
} from './service-manager.js';
import { JsonFileStore } from './store.js';
import { runWeixinLogin } from './weixin-login.js';
import { listWeixinAccounts } from './weixin-store.js';

let port = 4781;
const serverStartTime = new Date().toISOString();
const supportedChannels = ['feishu', 'weixin'] as const;
const AUTH_COOKIE_NAME = 'cti_ui_auth';

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

function createUiStore(): JsonFileStore {
  return new JsonFileStore(configToSettings(loadConfig()));
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
    enabledChannels: config.enabledChannels,
    defaultWorkDir: config.defaultWorkDir,
    defaultWorkspaceRoot: config.defaultWorkspaceRoot || '',
    defaultModel: config.defaultModel || '',
    defaultMode: config.defaultMode,
    historyMessageLimit: config.historyMessageLimit ?? 8,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck === true,
    codexSandboxMode: config.codexSandboxMode || 'workspace-write',
    codexReasoningEffort: config.codexReasoningEffort || 'medium',
    uiAllowLan: config.uiAllowLan === true,
    uiAccessToken: config.uiAccessToken || '',
    autoApprove: config.autoApprove === true,
    feishuAppId: config.feishuAppId || '',
    feishuAppSecret: config.feishuAppSecret || '',
    feishuDomain: config.feishuDomain || 'https://open.feishu.cn',
    feishuAllowedUsers: config.feishuAllowedUsers?.join(',') || '',
    feishuStreamingEnabled: config.feishuStreamingEnabled !== false,
    feishuCommandMarkdownEnabled: config.feishuCommandMarkdownEnabled !== false,
    weixinMediaEnabled: config.weixinMediaEnabled === true,
    weixinCommandMarkdownEnabled: config.weixinCommandMarkdownEnabled === true,
  };
}

function mergeConfig(payload: Record<string, unknown>): Config {
  const current = loadConfig();
  const requestedChannels = Array.isArray(payload.enabledChannels)
    ? payload.enabledChannels.filter((value): value is string => typeof value === 'string')
    : current.enabledChannels;
  const uiAllowLan = payload.uiAllowLan === true;
  const requestedUiAccessToken = asString(payload.uiAccessToken);
  const uiAccessToken = requestedUiAccessToken
    || current.uiAccessToken
    || (uiAllowLan ? generateAccessToken() : undefined);

  return {
    ...current,
    runtime: payload.runtime === 'claude' || payload.runtime === 'auto' ? payload.runtime : 'codex',
    enabledChannels: requestedChannels.filter((channel) => supportedChannels.includes(channel as typeof supportedChannels[number])),
    defaultWorkDir: asString(payload.defaultWorkDir) || current.defaultWorkDir || process.cwd(),
    defaultWorkspaceRoot: asString(payload.defaultWorkspaceRoot),
    defaultModel: asString(payload.defaultModel),
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
    feishuAppId: asString(payload.feishuAppId),
    feishuAppSecret: asString(payload.feishuAppSecret),
    feishuDomain: asString(payload.feishuDomain) || 'https://open.feishu.cn',
    feishuAllowedUsers: parseCsv(payload.feishuAllowedUsers),
    feishuStreamingEnabled: payload.feishuStreamingEnabled !== false,
    feishuCommandMarkdownEnabled: payload.feishuCommandMarkdownEnabled !== false,
    weixinMediaEnabled: payload.weixinMediaEnabled === true,
    weixinCommandMarkdownEnabled: payload.weixinCommandMarkdownEnabled === true,
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

async function validateFeishuCredentials(config: Config): Promise<{ ok: boolean; message: string }> {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    return { ok: false, message: 'Feishu App ID / App Secret 不能为空。' };
  }

  const domain = config.feishuDomain || 'https://open.feishu.cn';
  const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret,
    }),
  });

  const data = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (response.ok && data.code === 0 && data.tenant_access_token) {
    return { ok: true, message: '飞书凭据校验成功，tenant_access_token 已获取。' };
  }

  return {
    ok: false,
    message: data.msg || `飞书校验失败，HTTP ${response.status}`,
  };
}

async function testCodexConnection(config: Config): Promise<{ ok: boolean; message: string; raw?: string }> {
  const provider = new CodexProvider(new PendingPermissions());
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);

  try {
    const stream = provider.streamChat({
      prompt: 'Reply with the single word OK.',
      sessionId: `ui-test-${Date.now()}`,
      workingDirectory: config.defaultWorkDir,
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
        .binding-head { flex-direction: column; align-items: stretch; }
        .session-head { grid-template-columns: 1fr; }
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
              <strong>Codex 集成</strong>
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
                <p class="panel-subtitle">可选 Codex 集成</p>
                <div class="notice">主流程不依赖这层集成。只有当你想在 Codex 里直接打开 codex-to-im，或者保留一个“共享当前会话到飞书”的轻入口时，才需要安装它。</div>
                <div class="actions" style="margin-top: 12px;">
                  <button id="installIntegrationBtn">安装可选 Codex 集成</button>
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
              <p class="page-copy">按工程目录查看最近桌面会话，并复制 thread 或接管命令。</p>
            </div>
            <div class="toolbar">
              <button id="refreshDesktopBtn">刷新桌面会话</button>
            </div>
          </div>

          <section class="panel" id="desktop">
            <div class="notice">这里只展示在 Codex 桌面索引里有名字的线程，和 Codex Desktop App 左侧列表保持一致。</div>
            <div class="notice" style="margin-top: 12px;">最短路径：找到目标 thread，然后把 <code>/thread 019d1da4</code> 这样的命令发给飞书机器人，或直接到“通道”页切换绑定。</div>
            <div class="small" id="desktopSessionMeta" style="margin: 14px 0 16px;">正在加载…</div>
            <div class="session-list" id="desktopSessionsList"></div>
            <div class="message" id="desktopMessage"></div>
          </section>
        </section>

        <section class="page" data-page="config">
          <div class="page-header">
            <div>
              <h1 class="page-title">配置</h1>
              <p class="page-copy">这里维护本地默认工作目录、运行模式和全局行为开关。</p>
            </div>
          </div>

          <section class="panel" id="config">
            <div class="panel-header">
              <div>
                <h2>基础配置</h2>
                <p>保存后会写入本地配置目录。默认目录、默认工作空间、Sandbox、思考级别等会在下一次请求生效；通道启停会自动同步；只有少数运行时配置需要重启 Bridge。</p>
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
                默认工作目录
                <input id="defaultWorkDir" placeholder="D:\\workspace\\project" />
              </label>
              <label>
                默认工作空间
                <input id="defaultWorkspaceRoot" placeholder="留空时使用 ~/cx2im" />
              </label>
              <label>
                默认模型
                <input id="defaultModel" placeholder="留空则使用 runtime 默认模型" />
              </label>
              <div class="field-row">
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
              <div class="small">“默认工作目录”用于新会话默认 cwd；“默认工作空间”用于 <code>/new proj1</code> 这类相对项目名。留空时会按当前系统自动回退到 <code>~/cx2im</code>。文件系统权限是全局默认值，思考级别可在 IM 会话里再单独覆盖。</div>
              <div class="small">当前需要重启 Bridge 的配置：<code>Runtime</code>、<code>自动批准工具权限</code>、<code>允许在未信任 Git 目录运行 Codex</code>、飞书 <code>App ID</code>/<code>App Secret</code>/<code>Domain</code>。</div>
              <div class="checkbox-row">
                <label class="checkbox"><input id="channelFeishu" type="checkbox" checked /> 启用飞书</label>
                <label class="checkbox"><input id="channelWeixin" type="checkbox" /> 启用微信</label>
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
                  <div class="command-item"><div class="command-col-command"><code>/t</code></div><div class="command-col-original"><code>/threads</code></div><div class="command-col-desc">列出最近桌面会话。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t &lt;序号&gt;</code></div><div class="command-col-original"><code>/thread &lt;序号&gt;</code></div><div class="command-col-desc">按序号接管桌面会话。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/n [绝对路径 | 项目名]</code></div><div class="command-col-original"><code>/new [绝对路径 | 项目名]</code></div><div class="command-col-desc">新建会话；相对项目名会在“默认工作空间”下创建目录。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>直接发送文本</code></div><div class="command-col-original">—</div><div class="command-col-desc">继续当前已绑定会话。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his</code></div><div class="command-col-original"><code>/history</code></div><div class="command-col-desc">查看当前会话整理后的摘要。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/his raw</code></div><div class="command-col-original"><code>/history raw</code></div><div class="command-col-desc">查看最近 N 条原始消息。</div></div>
                </div>
              </section>

              <section class="command-section">
                <h3 class="command-section-title">设置与切换</h3>
                <div class="command-list">
                  <div class="command-list-head"><div>命令</div><div>原始命令</div><div>说明</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/m</code></div><div class="command-col-original"><code>/mode</code></div><div class="command-col-desc">查看当前模式；可选 <code>code</code>、<code>plan</code>、<code>ask</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/r</code></div><div class="command-col-original"><code>/reasoning</code></div><div class="command-col-desc">查看当前思考级别；可选 <code>0=minimal</code>、<code>1=low</code>、<code>2=medium</code>、<code>3=high</code>、<code>4/5=xhigh</code>。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t 0</code></div><div class="command-col-original"><code>/thread 0</code></div><div class="command-col-desc">切换到当前聊天的临时草稿线程。</div></div>
                  <div class="command-item"><div class="command-col-command"><code>/t 0 reset</code></div><div class="command-col-original"><code>/thread 0 reset</code></div><div class="command-col-desc">丢弃当前草稿上下文并重建一条新的草稿线程。</div></div>
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

          <section class="panel channel-shell">
            <div class="channel-tabs" role="tablist" aria-label="通道配置">
              <button type="button" class="channel-tab active" data-channel="feishu" role="tab" aria-selected="true">飞书</button>
              <button type="button" class="channel-tab" data-channel="weixin" role="tab" aria-selected="false">微信</button>
            </div>

            <div class="channel-view active" data-channel="feishu" role="tabpanel">
              <section id="feishu">
              <div class="panel-header">
                <div>
                  <h2>飞书 / Lark</h2>
                  <p>填写凭据、测试可用性，并查看当前飞书聊天绑定到哪条会话。</p>
                </div>
                <div class="toolbar">
                  <button id="saveFeishuChannelBtn">保存通道配置</button>
                  <button id="testFeishuBtn">测试飞书凭据</button>
                  <button id="refreshFeishuStateBtn">刷新状态</button>
                </div>
              </div>

              <div class="fields">
                <div class="field-row">
                  <label>
                    App ID
                    <input id="feishuAppId" />
                  </label>
                  <label>
                    App Secret
                    <input id="feishuAppSecret" />
                  </label>
                </div>
                <div class="field-row">
                  <label>
                    Domain
                    <input id="feishuDomain" value="https://open.feishu.cn" />
                  </label>
                  <label>
                    Allowed Users
                    <input id="feishuAllowedUsers" placeholder="多个 user_id 用逗号分隔" />
                  </label>
                </div>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="feishuStreamingEnabled" type="checkbox" checked /> 启用飞书流式响应卡片</label>
                </div>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="feishuCommandMarkdownEnabled" type="checkbox" checked /> 命令反馈使用 Markdown</label>
                </div>
                <div class="small">需要飞书侧已开通可更新卡片的相关能力；如果权限不足，会自动回退为最终结果消息。</div>
                <div class="small">只影响 <code>/h</code>、<code>/status</code>、<code>/threads</code> 这类系统反馈，不影响 Codex 原始回复。</div>
                <div class="small">修改飞书 <code>App ID</code>、<code>App Secret</code>、<code>Domain</code> 后，需要重启 Bridge 让客户端重新初始化；白名单、流式开关、Markdown 开关会即时生效。</div>
              </div>

              <div class="panel-block">
                <p class="panel-subtitle">通道状态</p>
                <div class="small" id="feishuRuntimeMeta">正在加载…</div>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">当前飞书绑定</p>
                <div class="small" id="feishuBindingMeta">正在加载…</div>
                <div class="binding-list" id="feishuBindings" style="margin-top: 12px;"></div>
              </div>

              <div class="message" id="feishuMessage"></div>
              </section>
            </div>

            <div class="channel-view" data-channel="weixin" role="tabpanel">
              <section id="wechat">
              <div class="panel-header">
                <div>
                  <h2>微信</h2>
                  <p>扫码登录微信并查看当前聊天绑定的会话。</p>
                </div>
                <div class="toolbar">
                  <button id="saveWeixinChannelBtn">保存通道配置</button>
                  <button id="weixinLoginBtn">开始微信扫码</button>
                  <button id="refreshWeixinStateBtn">刷新状态</button>
                </div>
              </div>

              <div class="fields">
                <div class="checkbox-row">
                  <label class="checkbox"><input id="weixinMediaEnabled" type="checkbox" /> 启用图片 / 文件 / 视频入站下载</label>
                </div>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="weixinCommandMarkdownEnabled" type="checkbox" /> 命令反馈使用 Markdown</label>
                </div>
              </div>
              <div class="small">只影响 <code>/h</code>、<code>/status</code>、<code>/threads</code> 这类系统反馈，不影响 Codex 原始回复。默认关闭。</div>
              <div class="panel-block">
                <p class="panel-subtitle">通道状态</p>
                <div class="small" id="weixinRuntimeMeta">正在加载…</div>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">已登录微信账号</p>
                <div class="small" id="weixinAccountMeta">正在加载…</div>
                <div class="binding-list" id="weixinAccounts" style="margin-top: 12px;"></div>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">当前微信绑定</p>
                <div class="small" id="weixinBindingMeta">正在加载…</div>
                <div class="binding-list" id="weixinBindings" style="margin-top: 12px;"></div>
              </div>
              <div class="message" id="weixinMessage"></div>
              </section>
            </div>
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
        uiAccess: null,
        bridgeStatus: null,
        desktopSessions: [],
        bindings: [],
        bindingOptions: [],
        weixinAccounts: [],
        desktopRoot: '',
        activePage: 'overview',
        activeChannel: 'feishu',
      };

      function escapeHtml(value) {
        return String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
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

      function enabledChannelsFromForm() {
        const channels = [];
        if (document.getElementById('channelFeishu').checked) channels.push('feishu');
        if (document.getElementById('channelWeixin').checked) channels.push('weixin');
        return channels;
      }

      function formPayload() {
        return {
          runtime: document.getElementById('runtime').value,
          defaultMode: document.getElementById('defaultMode').value,
          historyMessageLimit: document.getElementById('historyMessageLimit').value,
          defaultWorkDir: document.getElementById('defaultWorkDir').value,
          defaultWorkspaceRoot: document.getElementById('defaultWorkspaceRoot').value,
          defaultModel: document.getElementById('defaultModel').value,
          codexSkipGitRepoCheck: document.getElementById('codexSkipGitRepoCheck').checked,
          codexSandboxMode: document.getElementById('codexSandboxMode').value,
          codexReasoningEffort: document.getElementById('codexReasoningEffort').value,
          uiAllowLan: document.getElementById('uiAllowLan').checked,
          uiAccessToken: document.getElementById('uiAccessToken').value,
          enabledChannels: enabledChannelsFromForm(),
          autoApprove: document.getElementById('autoApprove').checked,
          feishuAppId: document.getElementById('feishuAppId').value,
          feishuAppSecret: document.getElementById('feishuAppSecret').value,
          feishuDomain: document.getElementById('feishuDomain').value,
          feishuAllowedUsers: document.getElementById('feishuAllowedUsers').value,
          feishuStreamingEnabled: document.getElementById('feishuStreamingEnabled').checked,
          feishuCommandMarkdownEnabled: document.getElementById('feishuCommandMarkdownEnabled').checked,
          weixinMediaEnabled: document.getElementById('weixinMediaEnabled').checked,
          weixinCommandMarkdownEnabled: document.getElementById('weixinCommandMarkdownEnabled').checked,
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
            ? '#channels/' + state.activeChannel
            : '#' + nextPage;
          if (window.location.hash !== hash) {
            history.replaceState(null, '', hash);
          }
        }
      }

      function setActiveChannel(channel, syncHash) {
        const nextChannel = channel === 'weixin' ? 'weixin' : 'feishu';
        state.activeChannel = nextChannel;

        document.querySelectorAll('.channel-tab').forEach((element) => {
          const node = element;
          const active = node.dataset.channel === nextChannel;
          node.classList.toggle('active', active);
          node.setAttribute('aria-selected', active ? 'true' : 'false');
        });

        document.querySelectorAll('.channel-view').forEach((element) => {
          const node = element;
          const active = node.dataset.channel === nextChannel;
          node.classList.toggle('active', active);
          node.hidden = !active;
        });

        if (syncHash !== false && state.activePage === 'channels') {
          const hash = '#channels/' + nextChannel;
          if (window.location.hash !== hash) {
            history.replaceState(null, '', hash);
          }
        }
      }

      function syncPageFromHash() {
        const raw = String(window.location.hash || '').replace(/^#/, '');
        if (!raw) {
          setActivePage('overview', false);
          setActiveChannel('feishu', false);
          return;
        }

        if (raw.startsWith('channels/')) {
          setActivePage('channels', false);
          setActiveChannel(raw.split('/')[1] || 'feishu', false);
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

      function isChannelEnabled(channelType) {
        return Boolean(state.config && (state.config.enabledChannels || []).includes(channelType));
      }

      function runningChannels() {
        return state.bridgeStatus && Array.isArray(state.bridgeStatus.channels) ? state.bridgeStatus.channels : [];
      }

      function isChannelRunning(channelType) {
        return Boolean(state.bridgeStatus && state.bridgeStatus.running && runningChannels().includes(channelType));
      }

      const CONFIG_FIELD_LABELS = {
        runtime: 'Runtime',
        enabledChannels: '通道启用状态',
        defaultWorkDir: '默认工作目录',
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
        feishuAppId: '飞书 App ID',
        feishuAppSecret: '飞书 App Secret',
        feishuDomain: '飞书 Domain',
        feishuAllowedUsers: '飞书 Allowed Users',
        feishuStreamingEnabled: '飞书流式响应卡片',
        feishuCommandMarkdownEnabled: '飞书命令 Markdown',
        weixinMediaEnabled: '微信图片/文件/视频入站下载',
        weixinCommandMarkdownEnabled: '微信命令 Markdown',
      };

      const BRIDGE_RESTART_FIELDS = new Set([
        'runtime',
        'codexSkipGitRepoCheck',
        'autoApprove',
        'feishuAppId',
        'feishuAppSecret',
        'feishuDomain',
      ]);

      const AUTO_SYNC_FIELDS = new Set([
        'enabledChannels',
      ]);

      const IMMEDIATE_FIELDS = new Set([
        'defaultWorkDir',
        'defaultWorkspaceRoot',
        'defaultModel',
        'defaultMode',
        'historyMessageLimit',
        'codexSandboxMode',
        'codexReasoningEffort',
        'uiAllowLan',
        'uiAccessToken',
        'feishuAllowedUsers',
        'feishuStreamingEnabled',
        'feishuCommandMarkdownEnabled',
        'weixinMediaEnabled',
        'weixinCommandMarkdownEnabled',
      ]);

      const SAVE_SCOPE_FIELDS = {
        all: null,
        feishu: new Set([
          'enabledChannels',
          'feishuAppId',
          'feishuAppSecret',
          'feishuDomain',
          'feishuAllowedUsers',
          'feishuStreamingEnabled',
          'feishuCommandMarkdownEnabled',
        ]),
        weixin: new Set([
          'enabledChannels',
          'weixinMediaEnabled',
          'weixinCommandMarkdownEnabled',
        ]),
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

      function channelLabel(channelType) {
        return channelType === 'weixin' ? '微信' : '飞书';
      }

      function channelRuntimeText(channelType) {
        const label = channelLabel(channelType);
        if (!isChannelEnabled(channelType)) {
          return label + '在配置中未启用。';
        }
        if (!state.bridgeStatus || !state.bridgeStatus.running) {
          return label + '已启用，但 Bridge 还没启动。启动 Bridge 后才会真正接通。';
        }
        if (!isChannelRunning(channelType)) {
          return label + '已写入配置，Bridge 会在几秒内自动同步这个通道；如果页面还没更新，可手动点“刷新状态”。';
        }
        return label + '已接通到当前运行中的 Bridge。';
      }

      function emptyBindingText(channelType) {
        const label = channelLabel(channelType);
        if (!isChannelEnabled(channelType)) {
          return label + '未启用。先在“配置”里勾选后保存。';
        }
        if (!state.bridgeStatus || !state.bridgeStatus.running) {
          return label + '已启用，但 Bridge 还没启动。启动后才会创建绑定。';
        }
        if (!isChannelRunning(channelType)) {
          return label + '已启用，Bridge 会在几秒内自动同步这个通道；如果页面还没更新，可手动点“刷新状态”。';
        }
        return label + '当前还没有聊天接入。先从' + label + '发一条消息，bridge 才会创建绑定。';
      }

      function quickSwitchState(channelType) {
        const label = channelLabel(channelType);
        if (!isChannelEnabled(channelType)) {
          return { disabled: true, title: label + '未启用。' };
        }
        if (!state.bridgeStatus || !state.bridgeStatus.running) {
          return { disabled: true, title: 'Bridge 还没启动。启动后再切换' + label + '会话。' };
        }
        if (!isChannelRunning(channelType)) {
          return { disabled: true, title: label + '已写入配置，Bridge 会在几秒内自动同步；同步完成后再切换会话。' };
        }

        const bindings = state.bindings.filter((item) => item.channelType === channelType);
        if (bindings.length === 0) {
          return { disabled: true, title: '当前还没有' + label + '聊天绑定。先让' + label + '发来一条消息。' };
        }
        if (bindings.length > 1) {
          return { disabled: true, title: label + '有多个绑定，请到通道页切换。' };
        }

        return {
          disabled: false,
          title: '切换' + label + '到当前会话',
          bindingId: bindings[0].id,
        };
      }

      function currentThreadMarks(threadId) {
        const marks = [];
        const currentTargetKey = 'desktop:' + threadId;
        const counts = new Map();

        for (const binding of state.bindings || []) {
          const matchesThread = binding.currentThreadId === threadId || binding.currentTargetKey === currentTargetKey;
          if (!matchesThread) continue;
          counts.set(binding.channelType, (counts.get(binding.channelType) || 0) + 1);
        }

        for (const [channelType, count] of counts.entries()) {
          const label = channelType === 'weixin' ? '微信当前' : '飞书当前';
          marks.push(count > 1 ? label + ' x' + count : label);
        }

        return marks;
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
        const feishuSwitch = quickSwitchState('feishu');
        const weixinSwitch = quickSwitchState('weixin');
        const targetKey = 'desktop:' + session.threadId;
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
          +       '<button type="button" data-action="bind-channel" data-channel="feishu" data-binding-id="' + escapeHtml(feishuSwitch.bindingId || '') + '" data-target-key="' + escapeHtml(targetKey) + '" title="' + escapeHtml(feishuSwitch.title) + '"' + (feishuSwitch.disabled ? ' disabled' : '') + '>飞书切到此会话</button>'
          +       '<button type="button" data-action="bind-channel" data-channel="weixin" data-binding-id="' + escapeHtml(weixinSwitch.bindingId || '') + '" data-target-key="' + escapeHtml(targetKey) + '" title="' + escapeHtml(weixinSwitch.title) + '"' + (weixinSwitch.disabled ? ' disabled' : '') + '>微信切到此会话</button>'
          +       '<button type="button" data-action="copy-bind-command" data-thread-id="' + escapeHtml(session.threadId) + '">复制命令</button>'
          +   '</div>'
          + '</div>'
          + '</article>';
      }

      function renderDesktopSessions(result) {
        state.desktopSessions = result.sessions || [];
        state.desktopRoot = result.root || '-';
        const groups = groupDesktopSessions(state.desktopSessions);
        document.getElementById('desktopSessionCount').textContent = String(state.desktopSessions.length);
        document.getElementById('desktopSessionMeta').textContent =
          '扫描目录：' + state.desktopRoot + ' · ' + groups.length + ' 个工程 · ' + state.desktopSessions.length + ' 条桌面会话';
        document.getElementById('desktopRootStatus').textContent = state.desktopRoot;

        const list = document.getElementById('desktopSessionsList');
        if (state.desktopSessions.length === 0) {
          list.innerHTML = '<div class="notice ghost">当前没有发现桌面端会话。先在 Codex Desktop App 中打开或运行一个会话，再回到这里刷新。</div>';
          rerenderBindingPanels();
          return;
        }

        list.innerHTML = groups.map((group) => ''
          + '<section class="project-group">'
          +   '<div class="project-group-head">'
          +     '<div>'
          +       '<div class="project-group-title">' + escapeHtml(group.name) + '</div>'
          +       '<div class="project-group-path">' + escapeHtml(group.cwd || '(no cwd)') + '</div>'
          +     '</div>'
          +     '<div class="project-group-count">' + group.sessions.length + ' 个线程</div>'
          +   '</div>'
          +   '<div class="project-session-list">'
          +     group.sessions.map((session) => renderDesktopSessionCard(session)).join('')
          +   '</div>'
          + '</section>'
        ).join('');

        rerenderBindingPanels();
      }

      function rerenderDesktopSessions() {
        if (!state.desktopSessions.length && !state.desktopRoot) return;
        renderDesktopSessions({
          root: state.desktopRoot,
          sessions: state.desktopSessions,
        });
      }

      function rerenderBindingPanels() {
        renderChannelBindings(
          'feishu',
          'feishuBindings',
          'feishuBindingMeta',
          emptyBindingText('feishu')
        );
        renderChannelBindings(
          'weixin',
          'weixinBindings',
          'weixinBindingMeta',
          emptyBindingText('weixin')
        );
      }

      function renderChannelBindings(channelType, listId, metaId, emptyText) {
        const bindings = state.bindings.filter((item) => item.channelType === channelType);
        const list = document.getElementById(listId);
        const meta = document.getElementById(metaId);
        meta.textContent = bindings.length > 0
          ? '当前已发现 ' + bindings.length + ' 个聊天绑定。这里只显示和会话页一致的命名桌面线程。'
          : emptyText;

        if (bindings.length === 0) {
          list.innerHTML = '<div class="binding-empty">' + escapeHtml(emptyText) + '</div>';
          return;
        }

        list.innerHTML = bindings.map((binding) => {
          return ''
            + '<article class="binding-item" data-binding-id="' + escapeHtml(binding.id) + '">'
            +   '<div class="binding-head">'
            +     '<div class="binding-title">' + escapeHtml(binding.chatId) + '</div>'
            +     '<div class="small">' + escapeHtml(binding.mode) + '</div>'
            +   '</div>'
            +   '<div class="binding-detail">当前会话：<code>' + escapeHtml(binding.currentSessionId.slice(0, 8)) + '...</code> · ' + escapeHtml(binding.currentSessionName) + '</div>'
            +   '<div class="binding-detail">当前目标：' + escapeHtml(binding.currentTargetLabel || '未绑定') + '</div>'
            +   '<div class="binding-detail">当前 thread：<code>' + escapeHtml(binding.currentThreadId || 'not-shared') + '</code></div>'
            +   '<div class="binding-detail">运行状态：' + escapeHtml(bindingRuntimeText(binding)) + '</div>'
            +   '<div class="binding-detail">共享镜像：' + escapeHtml(bindingMirrorText(binding)) + '</div>'
            +   '<div class="binding-detail">目录：' + escapeHtml(binding.workingDirectory || '~') + '</div>'
            +   renderBindingTable(binding)
            + '</article>';
        }).join('');
      }

      function renderWeixinAccounts() {
        const meta = document.getElementById('weixinAccountMeta');
        const list = document.getElementById('weixinAccounts');
        const accounts = state.weixinAccounts || [];

        if (accounts.length === 0) {
          meta.textContent = '当前还没有已保存的微信账号。先点击“开始微信扫码”，然后在手机上确认。';
          list.innerHTML = '<div class="binding-empty">扫码成功后，这里会显示当前已保存的微信账号。</div>';
          return;
        }

        meta.textContent = '当前已保存 ' + accounts.length + ' 个微信账号。微信桥接是单账号模式，最新启用的账号会生效。';
        list.innerHTML = accounts.map((account) => ''
          + '<article class="binding-item">'
          +   '<div class="binding-head">'
          +     '<div class="binding-title">' + escapeHtml(account.name || account.accountId) + '</div>'
          +     '<div class="small">' + (account.enabled ? '已启用' : '已停用') + '</div>'
          +   '</div>'
          +   '<div class="binding-detail">账号 ID：<code>' + escapeHtml(account.accountId) + '</code></div>'
          +   '<div class="binding-detail">用户 ID：<code>' + escapeHtml(account.userId || '-') + '</code></div>'
          +   '<div class="binding-detail">Base URL：' + escapeHtml(account.baseUrl || '-') + '</div>'
          +   '<div class="binding-detail">最近登录：' + escapeHtml(formatTime(account.lastLoginAt || account.updatedAt)) + '</div>'
          + '</article>'
        ).join('');
      }

      function renderBindings(result) {
        state.bindings = result.bindings || [];
        state.bindingOptions = result.options || [];
        document.getElementById('bindingCount').textContent = String(state.bindings.length);
        renderChannelBindings(
          'feishu',
          'feishuBindings',
          'feishuBindingMeta',
          emptyBindingText('feishu')
        );
        renderChannelBindings(
          'weixin',
          'weixinBindings',
          'weixinBindingMeta',
          emptyBindingText('weixin')
        );
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
        document.getElementById('defaultWorkDir').value = config.defaultWorkDir || '';
        document.getElementById('defaultWorkspaceRoot').value = config.defaultWorkspaceRoot || '';
        document.getElementById('defaultModel').value = config.defaultModel || '';
        document.getElementById('codexSkipGitRepoCheck').checked = config.codexSkipGitRepoCheck === true;
        document.getElementById('codexSandboxMode').value = config.codexSandboxMode || 'workspace-write';
        document.getElementById('codexReasoningEffort').value = config.codexReasoningEffort || 'medium';
        document.getElementById('uiAllowLan').checked = config.uiAllowLan === true;
        document.getElementById('uiAccessToken').value = config.uiAccessToken || '';
        document.getElementById('channelFeishu').checked = (config.enabledChannels || []).includes('feishu');
        document.getElementById('channelWeixin').checked = (config.enabledChannels || []).includes('weixin');
        document.getElementById('autoApprove').checked = config.autoApprove === true;
        document.getElementById('feishuAppId').value = config.feishuAppId || '';
        document.getElementById('feishuAppSecret').value = config.feishuAppSecret || '';
        document.getElementById('feishuDomain').value = config.feishuDomain || 'https://open.feishu.cn';
        document.getElementById('feishuAllowedUsers').value = config.feishuAllowedUsers || '';
        document.getElementById('feishuStreamingEnabled').checked = config.feishuStreamingEnabled !== false;
        document.getElementById('feishuCommandMarkdownEnabled').checked = config.feishuCommandMarkdownEnabled !== false;
        document.getElementById('weixinMediaEnabled').checked = config.weixinMediaEnabled === true;
        document.getElementById('weixinCommandMarkdownEnabled').checked = config.weixinCommandMarkdownEnabled === true;
        renderUiAccess();
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
        state.weixinAccounts = status.weixin && Array.isArray(status.weixin.linkedAccounts) ? status.weixin.linkedAccounts : [];
        fillForm(config);
        const runningChannelText = runningChannels().length ? ' · ' + runningChannels().join(', ') : '';
        document.getElementById('bridgeStatus').textContent = status.bridge.running ? 'Running' + runningChannelText : 'Stopped';
        document.getElementById('integrationStatus').textContent = status.codexIntegrationInstalled ? '已安装' : '未安装';
        document.getElementById('runtimeStatus').textContent = config.runtime || 'codex';
        document.getElementById('homeStatus').textContent = status.home;
        document.getElementById('overviewHomeStatus').textContent = status.home;
        document.getElementById('packageRoot').textContent = status.packageRoot;
        document.getElementById('feishuRuntimeMeta').textContent = channelRuntimeText('feishu');
        document.getElementById('weixinRuntimeMeta').textContent = channelRuntimeText('weixin');
        renderWeixinAccounts();
        renderBindings({
          bindings: state.bindings,
          options: state.bindingOptions,
        });
      }

      async function loadLogs() {
        const logs = await api('/api/logs?lines=220');
        document.getElementById('logsOutput').textContent = logs.logs || '暂无日志';
      }

      async function loadDesktopSessions() {
        const result = await api('/api/desktop-sessions?limit=36');
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

      document.querySelectorAll('.nav-link').forEach((element) => {
        element.addEventListener('click', () => {
          setActivePage(element.dataset.page || 'overview', true);
        });
      });

      document.querySelectorAll('.channel-tab').forEach((element) => {
        element.addEventListener('click', () => {
          setActivePage('channels', false);
          setActiveChannel(element.dataset.channel || 'feishu', true);
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

      document.getElementById('saveFeishuChannelBtn').addEventListener('click', async () => {
        try {
          await saveConfig({ messageId: 'feishuMessage', scope: 'feishu' });
          await loadStatus();
          await loadBindings();
        } catch (error) {
          showMessage('feishuMessage', 'error', error.message);
        }
      });

      document.getElementById('testFeishuBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          await loadStatus();
          await loadBindings();
          const result = await api('/api/test/feishu', { method: 'POST' });
          showMessage('feishuMessage', result.ok ? 'success' : 'error', result.message);
        } catch (error) {
          showMessage('feishuMessage', 'error', error.message);
        }
      });

      document.getElementById('refreshFeishuStateBtn').addEventListener('click', async () => {
        try {
          await loadStatus();
          await loadBindings();
          await loadDesktopSessions();
          showMessage('feishuMessage', 'success', '飞书通道状态已刷新。');
        } catch (error) {
          showMessage('feishuMessage', 'error', error.message);
        }
      });

      document.getElementById('saveWeixinChannelBtn').addEventListener('click', async () => {
        try {
          await saveConfig({ messageId: 'weixinMessage', scope: 'weixin' });
          await loadStatus();
          await loadBindings();
        } catch (error) {
          showMessage('weixinMessage', 'error', error.message);
        }
      });

      document.getElementById('refreshWeixinStateBtn').addEventListener('click', async () => {
        try {
          await loadStatus();
          await loadBindings();
          await loadDesktopSessions();
          showMessage('weixinMessage', 'success', '微信通道状态已刷新。');
        } catch (error) {
          showMessage('weixinMessage', 'error', error.message);
        }
      });

      document.getElementById('weixinLoginBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          showMessage('weixinMessage', 'success', '微信扫码流程已启动，浏览器会打开二维码页面。');
          const result = await api('/api/test/weixin', { method: 'POST' });
          await loadStatus();
          await loadBindings();
          const followup = isChannelRunning('weixin')
            ? '微信账号已保存。当前 Bridge 已加载微信通道，几秒后会自动接入新账号。'
            : '微信账号已保存。Bridge 会在几秒内自动同步微信通道；如果页面还没更新，可手动点“刷新状态”。';
          showMessage('weixinMessage', result.ok ? 'success' : 'error', followup);
        } catch (error) {
          showMessage('weixinMessage', 'error', error.message);
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

      document.getElementById('installIntegrationBtn').addEventListener('click', async () => {
        try {
          const result = await api('/api/install-codex-integration', { method: 'POST' });
          showMessage('opsMessage', 'success', '可选 Codex 集成已处理：' + result.method + ' -> ' + result.targetDir);
          await loadStatus();
        } catch (error) {
          showMessage('opsMessage', 'error', error.message);
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

      document.getElementById('desktopSessionsList').addEventListener('click', async (event) => {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-action]') : null;
        if (!target) return;

        try {
          if (target.dataset.action === 'bind-channel') {
            const bindingId = target.dataset.bindingId || '';
            const targetKey = target.dataset.targetKey || '';
            const channelType = target.dataset.channel || '';
            if (!bindingId || !targetKey) {
              throw new Error('当前通道没有可切换的绑定，请先在通道页完成接入。');
            }
            const result = await api('/api/bindings/update', {
              method: 'POST',
              body: JSON.stringify({
                bindingId,
                targetKey,
              }),
            });
            renderBindings(result);
            showMessage(
              'desktopMessage',
              'success',
              (channelType === 'weixin' ? '微信' : '飞书') + '已切换到当前会话。'
            );
            return;
          }
          if (target.dataset.action === 'copy-thread') {
            await copyText(target.dataset.threadId || '', 'Thread ID 已复制。');
            return;
          }
          if (target.dataset.action === 'copy-bind-command') {
            await copyText(shortThreadCommand(target.dataset.threadId || ''), '飞书接管命令已复制。');
            return;
          }
          if (target.dataset.action === 'copy-cwd') {
            await copyText(target.dataset.cwd || '', '工作目录已复制。');
          }
        } catch (error) {
          showMessage('desktopMessage', 'error', error.message);
        }
      });

      async function handleBindingAction(event, channelType, messageId) {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-action="switch-binding-target"]') : null;
        if (!target) return;

        try {
          const result = await api('/api/bindings/update', {
            method: 'POST',
            body: JSON.stringify({
              bindingId: target.dataset.bindingId,
              targetKey: target.dataset.targetKey,
            }),
          });
          renderBindings(result);
          showMessage(messageId, 'success', channelType === 'feishu' ? '飞书绑定已更新。' : '微信绑定已更新。');
        } catch (error) {
          showMessage(messageId, 'error', error.message);
        }
      }

      document.getElementById('feishuBindings').addEventListener('click', (event) => {
        handleBindingAction(event, 'feishu', 'feishuMessage');
      });

      document.getElementById('weixinBindings').addEventListener('click', (event) => {
        handleBindingAction(event, 'weixin', 'weixinMessage');
      });

      syncPageFromHash();

      Promise.all([loadStatus(), loadBindings(), loadDesktopSessions(), loadLogs()]).catch((error) => {
        showMessage('opsMessage', 'error', error.message);
      });

      setInterval(() => {
        loadBindings().catch(() => {});
      }, 4000);
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
      const limit = parsePositiveInt(url.searchParams.get('limit'), 10);
      json(response, 200, {
        root: getCodexSessionsRoot(),
        sessions: listDesktopSessions(limit),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/bindings') {
      const store = createUiStore();
      json(response, 200, {
        bindings: listBindingSummaries(store),
        channels: {
          feishu: getChannelBindingSummaries(store, 'feishu'),
          weixin: getChannelBindingSummaries(store, 'weixin'),
        },
        options: listBindingTargetOptions(store, 12),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config') {
      const payload = await readJsonBody<Record<string, unknown>>(request);
      const config = mergeConfig(payload);
      saveConfig(config);
      json(response, 200, { ok: true, config: configToPayload(loadConfig()) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/test/feishu') {
      const result = await validateFeishuCredentials(loadConfig());
      json(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/test/weixin') {
      const result = await runWeixinLogin();
      json(response, 200, {
        ok: true,
        message: `微信扫码成功，账号 ${result.accountId} 已保存。`,
        htmlPath: result.htmlPath,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/test/codex') {
      const result = await testCodexConnection(loadConfig());
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
        bindings: listBindingSummaries(store),
        channels: {
          feishu: getChannelBindingSummaries(store, 'feishu'),
          weixin: getChannelBindingSummaries(store, 'weixin'),
        },
        options: listBindingTargetOptions(store, 12),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/install-codex-integration') {
      const result = await installCodexIntegration();
      json(response, 200, result);
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
