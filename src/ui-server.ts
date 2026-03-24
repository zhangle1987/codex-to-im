import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';

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
  startBridge,
  stopBridge,
  writeUiServerStatus,
} from './service-manager.js';
import { JsonFileStore } from './store.js';
import { runWeixinLogin } from './weixin-login.js';

let port = 4781;
const serverStartTime = new Date().toISOString();
const supportedChannels = ['feishu', 'weixin'] as const;

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
    probe.listen(portToCheck, '127.0.0.1', () => {
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
    probe.listen(0, '127.0.0.1', () => {
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

function configToPayload(config: Config) {
  return {
    runtime: config.runtime,
    enabledChannels: config.enabledChannels,
    defaultWorkDir: config.defaultWorkDir,
    defaultModel: config.defaultModel || '',
    defaultMode: config.defaultMode,
    historyMessageLimit: config.historyMessageLimit ?? 8,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck === true,
    autoApprove: config.autoApprove === true,
    feishuAppId: config.feishuAppId || '',
    feishuAppSecret: config.feishuAppSecret || '',
    feishuDomain: config.feishuDomain || 'https://open.feishu.cn',
    feishuAllowedUsers: config.feishuAllowedUsers?.join(',') || '',
    feishuStreamingEnabled: config.feishuStreamingEnabled !== false,
    weixinMediaEnabled: config.weixinMediaEnabled === true,
  };
}

function mergeConfig(payload: Record<string, unknown>): Config {
  const current = loadConfig();
  const requestedChannels = Array.isArray(payload.enabledChannels)
    ? payload.enabledChannels.filter((value): value is string => typeof value === 'string')
    : current.enabledChannels;

  return {
    ...current,
    runtime: payload.runtime === 'claude' || payload.runtime === 'auto' ? payload.runtime : 'codex',
    enabledChannels: requestedChannels.filter((channel) => supportedChannels.includes(channel as typeof supportedChannels[number])),
    defaultWorkDir: asString(payload.defaultWorkDir) || current.defaultWorkDir || process.cwd(),
    defaultModel: asString(payload.defaultModel),
    defaultMode: payload.defaultMode === 'plan' || payload.defaultMode === 'ask' ? payload.defaultMode : 'code',
    historyMessageLimit: asPositiveInt(payload.historyMessageLimit) || current.historyMessageLimit || 8,
    codexSkipGitRepoCheck: payload.codexSkipGitRepoCheck === true,
    autoApprove: payload.autoApprove === true,
    feishuAppId: asString(payload.feishuAppId),
    feishuAppSecret: asString(payload.feishuAppSecret),
    feishuDomain: asString(payload.feishuDomain) || 'https://open.feishu.cn',
    feishuAllowedUsers: parseCsv(payload.feishuAllowedUsers),
    feishuStreamingEnabled: payload.feishuStreamingEnabled !== false,
    weixinMediaEnabled: payload.weixinMediaEnabled === true,
  };
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

function renderHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex to IM</title>
    <style>
      :root {
        --bg: #faf8f5;
        --surface: #ffffff;
        --panel: #f2ece5;
        --border: #d7cec3;
        --text: #2f2419;
        --muted: #6d5d4a;
        --primary: #9a3412;
        --primary-strong: #7c2d12;
        --success: #166534;
        --danger: #b91c1c;
        --sidebar: #efe7dd;
      }

      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font: 14px/1.5 "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background: var(--bg);
      }

      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 248px minmax(0, 1fr);
      }

      .sidebar {
        background: var(--sidebar);
        border-right: 1px solid var(--border);
        padding: 28px 20px;
      }

      .sidebar-title {
        font-size: 17px;
        font-weight: 700;
        margin: 0 0 6px;
      }

      .sidebar-copy {
        margin: 0 0 24px;
        color: var(--muted);
      }

      .nav {
        display: grid;
        gap: 8px;
      }

      .nav a {
        color: var(--text);
        text-decoration: none;
        padding: 8px 10px;
        border-radius: 8px;
      }

      .nav a:hover {
        background: rgba(255, 255, 255, 0.55);
      }

      .main {
        padding: 28px 32px 40px;
      }

      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 20px;
        margin-bottom: 24px;
      }

      .topbar h1 {
        margin: 0 0 4px;
        font-size: 28px;
        line-height: 1.2;
      }

      .topbar p {
        margin: 0;
        color: var(--muted);
      }

      .status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        margin-bottom: 24px;
      }

      .status-card, .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
      }

      .status-card {
        padding: 14px 16px;
      }

      .status-card strong {
        display: block;
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 8px;
        font-weight: 600;
      }

      .status-value {
        font-size: 20px;
        font-weight: 700;
      }

      .stack {
        display: grid;
        gap: 20px;
      }

      .section-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .channel-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .panel {
        padding: 18px;
      }

      .panel h2 {
        margin: 0 0 16px;
        font-size: 18px;
      }

      .fields {
        display: grid;
        gap: 14px;
      }

      .field-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-weight: 500;
      }

      input, select, textarea {
        width: 100%;
        border: 1px solid var(--border);
        background: #fff;
        color: var(--text);
        border-radius: 8px;
        padding: 10px 12px;
        font: inherit;
      }

      input:focus, select:focus, textarea:focus {
        outline: 2px solid rgba(154, 52, 18, 0.16);
        border-color: var(--primary);
      }

      textarea {
        min-height: 220px;
        resize: vertical;
      }

      .checkbox-row {
        display: flex;
        gap: 18px;
        flex-wrap: wrap;
      }

      .checkbox {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
        font-weight: 500;
      }

      .checkbox input {
        width: 16px;
        height: 16px;
        margin: 0;
      }

      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      button {
        border: 1px solid var(--border);
        background: #fff;
        color: var(--text);
        border-radius: 8px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }

      button.primary {
        background: var(--primary);
        border-color: var(--primary);
        color: #fff;
      }

      button.primary:hover {
        background: var(--primary-strong);
      }

      button:hover {
        border-color: var(--primary);
      }

      .notice {
        padding: 12px 14px;
        border-radius: 8px;
        background: var(--panel);
        color: var(--muted);
      }

      .notice strong {
        color: var(--text);
      }

      .logs {
        white-space: pre-wrap;
        word-break: break-word;
        background: #231b14;
        color: #f3eee7;
        border-radius: 10px;
        padding: 14px;
        min-height: 260px;
        overflow: auto;
      }

      .message {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        display: none;
      }

      .message.show { display: block; }
      .message.success { background: rgba(22, 101, 52, 0.1); color: var(--success); }
      .message.error { background: rgba(185, 28, 28, 0.1); color: var(--danger); }

      .session-list {
        display: grid;
        gap: 10px;
      }

      .session-card {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px 14px;
        background: #fcfbf9;
      }

      .session-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 6px;
      }

      .session-title {
        font-weight: 700;
      }

      .session-meta {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 8px 0;
      }

      .session-pill {
        display: inline-flex;
        align-items: center;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--muted);
        background: #fff;
        font-size: 12px;
      }

      .session-pill.active {
        color: var(--success);
        border-color: rgba(22, 101, 52, 0.26);
        background: rgba(22, 101, 52, 0.08);
      }

      .session-path {
        font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }

      .session-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 10px;
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

      .binding-list {
        display: grid;
        gap: 10px;
      }

      .binding-item {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fcfbf9;
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

      .binding-empty {
        padding: 12px 14px;
        border: 1px dashed var(--border);
        border-radius: 10px;
        color: var(--muted);
        background: #fcfbf9;
      }

      .ghost {
        color: var(--muted);
      }

      .small {
        color: var(--muted);
        font-size: 12px;
      }

      @media (max-width: 1080px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar { border-right: 0; border-bottom: 1px solid var(--border); }
        .section-grid { grid-template-columns: 1fr; }
        .channel-grid { grid-template-columns: 1fr; }
        .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .binding-controls { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <p class="sidebar-title">Codex to IM</p>
        <p class="sidebar-copy">本地安装、配置、测试和后台控制都在这里。</p>
        <nav class="nav">
          <a href="#overview">概览</a>
          <a href="#config">配置</a>
          <a href="#feishu">飞书</a>
          <a href="#wechat">微信</a>
          <a href="#desktop">桌面会话</a>
          <a href="#ops">运行控制</a>
          <a href="#logs">日志</a>
        </nav>
      </aside>
      <main class="main">
        <section class="topbar" id="overview">
          <div>
            <h1>本地桥接工作台</h1>
            <p>后台服务、通道配置、桌面会话共享和通道测试都走这一页。</p>
          </div>
        </section>

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
            <div class="status-value" id="homeStatus" style="font-size:14px;">-</div>
          </div>
        </section>

        <div class="stack">
          <section class="panel" id="desktop">
            <h2>最近桌面会话</h2>
            <div class="notice">
              这里列出最近在 <code>Codex Windows App</code> 中活跃过的本地会话，作为接管到飞书或微信的候选入口。
            </div>
            <div class="notice" style="margin-top: 12px;">
              最短路径：在这里找到目标 thread，然后把 <code>/thread 019d1da4</code> 这样的命令发给飞书机器人，或在下面的绑定列表里直接切换。
            </div>
            <div class="session-actions">
              <button id="refreshDesktopBtn">刷新桌面会话</button>
            </div>
            <div class="small" id="desktopSessionMeta" style="margin: 12px 0 14px;">正在加载…</div>
            <div class="session-list" id="desktopSessionsList"></div>
            <div class="message" id="desktopMessage"></div>
          </section>

          <div class="section-grid">
            <section class="panel" id="config">
              <h2>基础配置</h2>
              <div class="fields">
                <div class="field-row">
                  <label>
                    Runtime
                    <select id="runtime">
                      <option value="codex">codex</option>
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
                  默认模型
                  <input id="defaultModel" placeholder="留空则使用 runtime 默认模型" />
                </label>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="channelFeishu" type="checkbox" /> 启用飞书</label>
                  <label class="checkbox"><input id="channelWeixin" type="checkbox" /> 启用微信</label>
                  <label class="checkbox"><input id="autoApprove" type="checkbox" /> 自动批准工具权限</label>
                </div>
                <div class="checkbox-row">
                  <label class="checkbox"><input id="codexSkipGitRepoCheck" type="checkbox" /> 允许在未信任 Git 目录运行 Codex</label>
                </div>
                <div class="small">如果新建会话报 “Not inside a trusted directory”，可以打开这个选项。修改后需要重启 Bridge 才会生效。</div>
              </div>
            </section>

            <section class="panel" id="ops">
              <h2>运行控制</h2>
              <div class="actions">
                <button class="primary" id="startBridgeBtn">启动 Bridge</button>
                <button id="stopBridgeBtn">停止 Bridge</button>
                <button id="testCodexBtn">测试 Codex</button>
                <button id="refreshBtn">刷新状态</button>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">当前能力</p>
                <div class="notice">
                  已接通：保存配置、后台启停、飞书凭据测试、微信扫码、Codex 连接测试、桌面会话发现、IM 绑定查看与网页侧切换。
                </div>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">可选 Codex 集成</p>
                <div class="notice">
                  主流程不依赖这层集成。只有当你想在 Codex 里直接打开 <code>codex-to-im</code>，或者保留一个“共享当前会话到飞书”的轻入口时，才需要安装它。
                </div>
                <div class="actions" style="margin-top: 12px;">
                  <button id="installIntegrationBtn">安装可选 Codex 集成</button>
                </div>
              </div>
              <div class="small" style="margin-top: 12px;">
                包根目录：<span id="packageRoot">-</span>
              </div>
              <div class="message" id="opsMessage"></div>
            </section>
          </div>

          <div class="channel-grid">
            <section class="panel" id="feishu">
              <h2>飞书 / Lark</h2>
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
                <div class="small">需要飞书侧已开通可更新卡片的相关能力；如果权限不足，会自动回退为最终结果消息。</div>
                <div class="actions">
                  <button class="primary" id="saveConfigBtn">保存配置</button>
                  <button id="testFeishuBtn">测试飞书凭据</button>
                </div>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">当前飞书绑定</p>
                <div class="small" id="feishuBindingMeta">正在加载…</div>
                <div class="binding-list" id="feishuBindings" style="margin-top: 12px;"></div>
              </div>
              <div class="message" id="feishuMessage"></div>
            </section>

            <section class="panel" id="wechat">
              <h2>微信</h2>
              <div class="fields">
                <div class="checkbox-row">
                  <label class="checkbox"><input id="weixinMediaEnabled" type="checkbox" /> 启用图片 / 文件 / 视频入站下载</label>
                </div>
                <div class="actions">
                  <button id="weixinLoginBtn">开始微信扫码</button>
                </div>
              </div>
              <div class="panel-block">
                <p class="panel-subtitle">当前微信绑定</p>
                <div class="small" id="weixinBindingMeta">正在加载…</div>
                <div class="binding-list" id="weixinBindings" style="margin-top: 12px;"></div>
              </div>
              <div class="message" id="weixinMessage"></div>
            </section>
          </div>

          <section class="panel" id="logs">
            <h2>日志</h2>
            <div class="logs" id="logsOutput">等待加载日志…</div>
          </section>
        </div>
      </main>
    </div>

    <script>
      const state = {
        config: null,
        desktopSessions: [],
        bindings: [],
        bindingOptions: [],
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

      function formatTime(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString('zh-CN', { hour12: false });
      }

      function optionLabel(option) {
        return option.label + ' · ' + option.description;
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
          defaultModel: document.getElementById('defaultModel').value,
          codexSkipGitRepoCheck: document.getElementById('codexSkipGitRepoCheck').checked,
          enabledChannels: enabledChannelsFromForm(),
          autoApprove: document.getElementById('autoApprove').checked,
          feishuAppId: document.getElementById('feishuAppId').value,
          feishuAppSecret: document.getElementById('feishuAppSecret').value,
          feishuDomain: document.getElementById('feishuDomain').value,
          feishuAllowedUsers: document.getElementById('feishuAllowedUsers').value,
          feishuStreamingEnabled: document.getElementById('feishuStreamingEnabled').checked,
          weixinMediaEnabled: document.getElementById('weixinMediaEnabled').checked,
        };
      }

      function showMessage(id, type, message) {
        const node = document.getElementById(id);
        node.className = 'message show ' + type;
        node.textContent = message;
      }

      async function copyText(value, successMessage) {
        if (!navigator.clipboard || !value) {
          throw new Error('当前浏览器不支持复制，或没有可复制的内容。');
        }
        await navigator.clipboard.writeText(value);
        showMessage('desktopMessage', 'success', successMessage);
      }

      function renderDesktopSessions(result) {
        state.desktopSessions = result.sessions || [];
        document.getElementById('desktopSessionCount').textContent = String(state.desktopSessions.length);
        document.getElementById('desktopSessionMeta').textContent =
          '扫描目录：' + (result.root || '-') + ' · 最近 ' + state.desktopSessions.length + ' 条桌面会话';

        const list = document.getElementById('desktopSessionsList');
        if (state.desktopSessions.length === 0) {
          list.innerHTML = '<div class="notice ghost">当前没有发现桌面端会话。先在 Codex Windows App 中打开或运行一个会话，再回到这里刷新。</div>';
          return;
        }

        list.innerHTML = state.desktopSessions.map((session) => {
          const tags = [
            '<span class="session-pill ' + (session.activeEstimate ? 'active' : '') + '">' + (session.activeEstimate ? '最近活跃' : '历史会话') + '</span>',
            '<span class="session-pill">' + escapeHtml(session.originator || 'Codex Desktop') + '</span>',
            session.source ? '<span class="session-pill">' + escapeHtml(session.source) + '</span>' : '',
          ].filter(Boolean).join('');

          return ''
            + '<article class="session-card">'
            +   '<div class="session-head">'
            +     '<div class="session-title">' + escapeHtml(session.title || 'Untitled Session') + '</div>'
            +     '<div class="small">' + escapeHtml(formatTime(session.lastEventAt)) + '</div>'
            +   '</div>'
            +   '<div class="small">Thread: <code>' + escapeHtml(shortId(session.threadId)) + '</code></div>'
            +   '<div class="session-meta">' + tags + '</div>'
            +   '<div class="session-path">' + escapeHtml(session.cwd || '(no cwd)') + '</div>'
            +   '<div class="session-actions">'
            +     '<button type="button" data-action="copy-thread" data-thread-id="' + escapeHtml(session.threadId) + '">复制 Thread ID</button>'
            +     '<button type="button" data-action="copy-bind-command" data-thread-id="' + escapeHtml(session.threadId) + '">复制飞书接管命令</button>'
            +     '<button type="button" data-action="copy-cwd" data-cwd="' + escapeHtml(session.cwd || '') + '">复制工作目录</button>'
            +   '</div>'
            + '</article>';
        }).join('');
      }

      function renderChannelBindings(channelType, listId, metaId, emptyText) {
        const bindings = state.bindings.filter((item) => item.channelType === channelType);
        const list = document.getElementById(listId);
        const meta = document.getElementById(metaId);
        meta.textContent = bindings.length > 0
          ? '当前已发现 ' + bindings.length + ' 个聊天绑定，可以直接在网页切换目标会话。'
          : emptyText;

        if (bindings.length === 0) {
          list.innerHTML = '<div class="binding-empty">' + escapeHtml(emptyText) + '</div>';
          return;
        }

        list.innerHTML = bindings.map((binding) => {
          const options = state.bindingOptions.map((option) => {
            const selected = option.key === binding.currentTargetKey ? ' selected' : '';
            return '<option value="' + escapeHtml(option.key) + '"' + selected + '>' + escapeHtml(optionLabel(option)) + '</option>';
          }).join('');

          return ''
            + '<article class="binding-item" data-binding-id="' + escapeHtml(binding.id) + '">'
            +   '<div class="binding-head">'
            +     '<div class="binding-title">' + escapeHtml(binding.chatId) + '</div>'
            +     '<div class="small">' + escapeHtml(binding.mode) + '</div>'
            +   '</div>'
            +   '<div class="binding-detail">当前会话：<code>' + escapeHtml(binding.currentSessionId.slice(0, 8)) + '...</code> · ' + escapeHtml(binding.currentSessionName) + '</div>'
            +   '<div class="binding-detail">当前 thread：<code>' + escapeHtml(binding.currentThreadId || 'not-shared') + '</code></div>'
            +   '<div class="binding-detail">目录：' + escapeHtml(binding.workingDirectory || '~') + '</div>'
            +   '<div class="binding-controls">'
            +     '<select data-role="target">' + options + '</select>'
            +     '<button type="button" data-action="save-binding">切换绑定</button>'
            +   '</div>'
            + '</article>';
        }).join('');
      }

      function renderBindings(result) {
        state.bindings = result.bindings || [];
        state.bindingOptions = result.options || [];
        document.getElementById('bindingCount').textContent = String(state.bindings.length);
        renderChannelBindings(
          'feishu',
          'feishuBindings',
          'feishuBindingMeta',
          '当前还没有飞书聊天接入。先在飞书机器人里发一条消息，bridge 才会创建绑定。'
        );
        renderChannelBindings(
          'weixin',
          'weixinBindings',
          'weixinBindingMeta',
          '当前还没有微信聊天接入。先让微信账号发一条消息，bridge 才会创建绑定。'
        );
      }

      function fillForm(config) {
        state.config = config;
        document.getElementById('runtime').value = config.runtime || 'codex';
        document.getElementById('defaultMode').value = config.defaultMode || 'code';
        document.getElementById('historyMessageLimit').value = String(config.historyMessageLimit || 8);
        document.getElementById('defaultWorkDir').value = config.defaultWorkDir || '';
        document.getElementById('defaultModel').value = config.defaultModel || '';
        document.getElementById('codexSkipGitRepoCheck').checked = config.codexSkipGitRepoCheck === true;
        document.getElementById('channelFeishu').checked = (config.enabledChannels || []).includes('feishu');
        document.getElementById('channelWeixin').checked = (config.enabledChannels || []).includes('weixin');
        document.getElementById('autoApprove').checked = config.autoApprove === true;
        document.getElementById('feishuAppId').value = config.feishuAppId || '';
        document.getElementById('feishuAppSecret').value = config.feishuAppSecret || '';
        document.getElementById('feishuDomain').value = config.feishuDomain || 'https://open.feishu.cn';
        document.getElementById('feishuAllowedUsers').value = config.feishuAllowedUsers || '';
        document.getElementById('feishuStreamingEnabled').checked = config.feishuStreamingEnabled !== false;
        document.getElementById('weixinMediaEnabled').checked = config.weixinMediaEnabled === true;
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
        fillForm(config);
        document.getElementById('bridgeStatus').textContent = status.bridge.running ? 'Running' : 'Stopped';
        document.getElementById('integrationStatus').textContent = status.codexIntegrationInstalled ? '已安装' : '未安装';
        document.getElementById('runtimeStatus').textContent = config.runtime || 'codex';
        document.getElementById('homeStatus').textContent = status.home;
        document.getElementById('packageRoot').textContent = status.packageRoot;
      }

      async function loadLogs() {
        const logs = await api('/api/logs?lines=220');
        document.getElementById('logsOutput').textContent = logs.logs || '暂无日志';
      }

      async function loadDesktopSessions() {
        const result = await api('/api/desktop-sessions?limit=10');
        renderDesktopSessions(result);
      }

      async function loadBindings() {
        const result = await api('/api/bindings');
        renderBindings(result);
      }

      async function saveConfig() {
        const saved = await api('/api/config', {
          method: 'POST',
          body: JSON.stringify(formPayload()),
        });
        fillForm(saved.config);
        showMessage('feishuMessage', 'success', '配置已保存。');
        return saved;
      }

      document.getElementById('saveConfigBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          await loadStatus();
        } catch (error) {
          showMessage('feishuMessage', 'error', error.message);
        }
      });

      document.getElementById('testFeishuBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          const result = await api('/api/test/feishu', { method: 'POST' });
          showMessage('feishuMessage', result.ok ? 'success' : 'error', result.message);
        } catch (error) {
          showMessage('feishuMessage', 'error', error.message);
        }
      });

      document.getElementById('weixinLoginBtn').addEventListener('click', async () => {
        try {
          await saveConfig();
          showMessage('weixinMessage', 'success', '微信扫码流程已启动，浏览器会打开二维码页面。');
          const result = await api('/api/test/weixin', { method: 'POST' });
          showMessage('weixinMessage', result.ok ? 'success' : 'error', result.message);
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

      document.getElementById('refreshDesktopBtn').addEventListener('click', async () => {
        try {
          await loadDesktopSessions();
          showMessage('desktopMessage', 'success', '桌面会话列表已刷新。');
        } catch (error) {
          showMessage('desktopMessage', 'error', error.message);
        }
      });

      document.getElementById('desktopSessionsList').addEventListener('click', async (event) => {
        const source = event.target instanceof Element ? event.target : null;
        const target = source ? source.closest('button[data-action]') : null;
        if (!target) return;

        try {
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
        const target = source ? source.closest('button[data-action="save-binding"]') : null;
        if (!target) return;

        const item = target.closest('[data-binding-id]');
        if (!item) return;
        const select = item.querySelector('select[data-role="target"]');
        if (!select) return;

        try {
          const result = await api('/api/bindings/update', {
            method: 'POST',
            body: JSON.stringify({
              bindingId: item.dataset.bindingId,
              targetKey: select.value,
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

    if (request.method === 'GET' && url.pathname === '/') {
      html(response, renderHtml());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/ping') {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, 200, {
        bridge: getBridgeStatus(),
        ui: getUiServerStatus(),
        home: CTI_HOME,
        packageRoot: getPackageRoot(),
        codexIntegrationInstalled: isCodexIntegrationInstalled(),
        startedAt: serverStartTime,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      json(response, 200, configToPayload(loadConfig()));
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
    server.listen(port, '127.0.0.1', () => {
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
