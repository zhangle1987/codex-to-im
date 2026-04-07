import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { CTI_HOME } from './config.js';
import { startLoginQr, pollLoginQrStatus } from './adapters/weixin/weixin-api.js';
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from './adapters/weixin/weixin-types.js';
import { upsertWeixinAccount } from './weixin-store.js';
import type { WeixinChannelConfig } from './config.js';

type LoginStatus = 'waiting' | 'scanned' | 'confirmed' | 'failed';

interface LoginSession {
  qrcode: string;
  qrImageUrl: string;
  status: LoginStatus;
  startedAt: number;
  refreshCount: number;
}

export interface WeixinLoginWebSessionState {
  id: string;
  channelId?: string;
  status: LoginStatus;
  startedAt: number;
  refreshCount: number;
  updatedAt: number;
  qrSvg: string;
  message: string;
  accountId?: string;
}

interface WeixinLoginRuntimeSession extends LoginSession {
  id: string;
  channelId?: string;
  qrSvg: string;
  updatedAt: number;
  message: string;
  accountId?: string;
}

const MAX_REFRESHES = 3;
const QR_TTL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const WEB_SESSION_TTL_MS = 15 * 60_000;
const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const HTML_PATH = path.join(RUNTIME_DIR, 'weixin-login.html');
const webLoginSessions = new Map<string, WeixinLoginRuntimeSession>();

function ensureRuntimeDir(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildQrHtml(session: LoginSession, qrSvg: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex-to-IM WeChat Login</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
        background: linear-gradient(180deg, #f6fbf8 0%, #eef5ff 100%);
        color: #14213d;
      }
      .wrap {
        max-width: 760px;
        margin: 0 auto;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 20px;
      }
      .card {
        width: 100%;
        background: rgba(255,255,255,0.92);
        border: 1px solid rgba(20,33,61,0.08);
        border-radius: 24px;
        box-shadow: 0 20px 50px rgba(36, 82, 167, 0.12);
        padding: 28px;
      }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.6; margin: 8px 0; }
      .qr {
        display: flex;
        justify-content: center;
        margin: 28px 0;
      }
      #qrcode {
        display: flex;
        justify-content: center;
      }
      #qrcode svg {
        width: 300px;
        height: 300px;
        border-radius: 18px;
        background: white;
        border: 1px solid rgba(20,33,61,0.08);
        padding: 16px;
      }
      ol {
        margin: 18px 0 0;
        padding-left: 22px;
      }
      code {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        background: #eef3ff;
        color: #2452a7;
      }
      .muted { color: #5b6b86; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>微信扫码登录 Codex-to-IM</h1>
        <p>请用手机微信扫描下面的二维码，并在手机上确认登录授权。</p>
        <p class="muted">如果二维码过期，CLI 会自动刷新这个页面内容；如果浏览器没有更新，请手动刷新一次。</p>
        <div class="qr">
          <div id="qrcode">${qrSvg}</div>
        </div>
        <ol>
          <li>打开手机微信扫一扫</li>
          <li>扫描页面二维码</li>
          <li>在手机上确认授权</li>
          <li>回到 CLI，等待显示登录成功</li>
        </ol>
        <p class="muted">HTML 文件：<code>${escapeHtml(HTML_PATH)}</code></p>
      </div>
    </div>
  </body>
</html>
`;
}

export function buildWeixinLoginPopupHtml(sessionId: string): string {
  const escapedSessionId = escapeHtml(sessionId);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>微信扫码登录</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
        background: linear-gradient(180deg, #f6fbf8 0%, #eef5ff 100%);
        color: #14213d;
      }
      .wrap {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 28px 18px;
      }
      .card {
        width: min(100%, 420px);
        background: rgba(255,255,255,0.95);
        border: 1px solid rgba(20,33,61,0.08);
        border-radius: 24px;
        box-shadow: 0 20px 50px rgba(36, 82, 167, 0.14);
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p {
        margin: 0;
        color: #5b6b86;
        line-height: 1.6;
      }
      .status {
        margin-top: 16px;
        padding: 10px 12px;
        border-radius: 12px;
        background: #f8fafc;
        border: 1px solid rgba(20,33,61,0.08);
        font-size: 14px;
        color: #1f2937;
      }
      .status.success {
        color: #166534;
        background: #f0fdf4;
        border-color: rgba(22, 101, 52, 0.16);
      }
      .status.error {
        color: #b91c1c;
        background: #fef2f2;
        border-color: rgba(185, 28, 28, 0.16);
      }
      .qr {
        display: flex;
        justify-content: center;
        margin: 22px 0;
        min-height: 332px;
        align-items: center;
      }
      .qr svg {
        width: 300px;
        height: 300px;
        border-radius: 18px;
        background: white;
        border: 1px solid rgba(20,33,61,0.08);
        padding: 16px;
      }
      .qr-placeholder {
        width: 300px;
        height: 300px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 18px;
        border: 1px dashed rgba(20,33,61,0.18);
        color: #64748b;
        background: rgba(248, 250, 252, 0.88);
        text-align: center;
        padding: 20px;
        box-sizing: border-box;
      }
      ol {
        margin: 0;
        padding-left: 22px;
        color: #334155;
        line-height: 1.75;
      }
      .meta {
        margin-top: 16px;
        font-size: 12px;
        color: #64748b;
      }
      .actions {
        margin-top: 18px;
        display: flex;
        justify-content: flex-end;
      }
      button {
        border: 1px solid rgba(20,33,61,0.12);
        border-radius: 10px;
        background: white;
        color: #14213d;
        padding: 9px 14px;
        font: inherit;
        cursor: pointer;
      }
      button:hover {
        border-color: #2452a7;
        color: #2452a7;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>微信扫码登录</h1>
        <p>请使用手机微信扫描二维码，并在手机上完成登录确认。</p>
        <div id="status" class="status">正在加载二维码…</div>
        <div class="qr" id="qrHost">
          <div class="qr-placeholder">正在准备二维码，请稍候…</div>
        </div>
        <ol>
          <li>打开手机微信扫一扫</li>
          <li>扫描二维码</li>
          <li>在手机上确认授权</li>
          <li>看到“登录成功”后即可关闭当前窗口</li>
        </ol>
        <div class="meta" id="meta"></div>
        <div class="actions">
          <button type="button" id="closeBtn">关闭窗口</button>
        </div>
      </div>
    </div>
    <script>
      const sessionId = ${JSON.stringify(sessionId)};
      const statusNode = document.getElementById('status');
      const qrHost = document.getElementById('qrHost');
      const meta = document.getElementById('meta');
      const closeBtn = document.getElementById('closeBtn');
      let timer = null;

      function renderStatus(payload) {
        const session = payload && payload.session ? payload.session : null;
        if (!session) {
          statusNode.className = 'status error';
          statusNode.textContent = '扫码会话不存在或已过期。';
          qrHost.innerHTML = '<div class="qr-placeholder">当前二维码已失效，请回到工作台重新发起扫码。</div>';
          meta.textContent = '会话：${escapedSessionId}';
          return true;
        }

        statusNode.className = 'status';
        if (session.status === 'confirmed') statusNode.classList.add('success');
        if (session.status === 'failed') statusNode.classList.add('error');
        statusNode.textContent = session.message || '等待扫码…';

        if (session.qrSvg && session.status !== 'confirmed') {
          qrHost.innerHTML = session.qrSvg;
        } else if (session.status === 'confirmed') {
          qrHost.innerHTML = '<div class="qr-placeholder">当前账号已绑定成功，可以关闭当前窗口。</div>';
        } else {
          qrHost.innerHTML = '<div class="qr-placeholder">二维码暂不可用，请稍后重试。</div>';
        }

        meta.textContent = '会话：' + session.id + ' · 已刷新 ' + session.refreshCount + ' 次';

        if (window.opener && window.location.origin) {
          try {
            window.opener.postMessage({
              source: 'codex-to-im-weixin-login',
              sessionId: session.id,
              status: session.status,
              accountId: session.accountId || '',
            }, window.location.origin);
          } catch {}
        }

        return session.status === 'confirmed' || session.status === 'failed';
      }

      async function tick() {
        try {
          const response = await fetch('/api/channels/weixin-login/' + encodeURIComponent(sessionId), {
            headers: { 'Content-Type': 'application/json' },
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || '加载微信扫码状态失败');
          }
          if (renderStatus(data) && timer) {
            clearInterval(timer);
            timer = null;
          }
        } catch (error) {
          statusNode.className = 'status error';
          statusNode.textContent = error && error.message ? error.message : '加载微信扫码状态失败';
          qrHost.innerHTML = '<div class="qr-placeholder">无法读取扫码状态，请稍后重试。</div>';
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      }

      closeBtn.addEventListener('click', () => window.close());
      tick();
      timer = window.setInterval(tick, 2000);
    </script>
  </body>
</html>`;
}

async function writeQrHtml(session: LoginSession): Promise<void> {
  ensureRuntimeDir();
  const qrSvg = await buildQrSvg(session.qrImageUrl);
  fs.writeFileSync(HTML_PATH, buildQrHtml(session, qrSvg), 'utf-8');
}

function openQrHtml(): boolean {
  try {
    if (process.platform === 'darwin') {
      const child = spawn('open', [HTML_PATH], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', HTML_PATH], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    }
    const child = spawn('xdg-open', [HTML_PATH], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function normalizeAccountId(rawAccountId: string): string {
  return rawAccountId.replace(/[@.]/g, '-');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildQrSvg(qrImageUrl: string): Promise<string> {
  return await QRCode.toString(qrImageUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 300,
  });
}

function pruneWebLoginSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of webLoginSessions) {
    if (now - session.updatedAt > WEB_SESSION_TTL_MS) {
      webLoginSessions.delete(sessionId);
    }
  }
}

function toWebSessionState(session: WeixinLoginRuntimeSession): WeixinLoginWebSessionState {
  return {
    id: session.id,
    channelId: session.channelId,
    status: session.status,
    startedAt: session.startedAt,
    refreshCount: session.refreshCount,
    updatedAt: session.updatedAt,
    qrSvg: session.qrSvg,
    message: session.message,
    accountId: session.accountId,
  };
}

function updateWebSession(
  sessionId: string,
  updater: (current: WeixinLoginRuntimeSession) => WeixinLoginRuntimeSession,
): WeixinLoginRuntimeSession | null {
  const current = webLoginSessions.get(sessionId);
  if (!current) return null;
  const next = updater(current);
  next.updatedAt = Date.now();
  webLoginSessions.set(sessionId, next);
  return next;
}

async function createSession(refreshCount: number, baseUrl?: string): Promise<LoginSession> {
  const response = await startLoginQr(baseUrl);
  if (!response.qrcode || !response.qrcode_img_content) {
    throw new Error('Failed to get QR code from WeChat server');
  }
  return {
    qrcode: response.qrcode,
    qrImageUrl: response.qrcode_img_content,
    status: 'waiting',
    startedAt: Date.now(),
    refreshCount,
  };
}

async function createRefreshedSession(previous: LoginSession, baseUrl?: string): Promise<LoginSession> {
  if (previous.refreshCount >= MAX_REFRESHES) {
    throw new Error('QR code expired too many times. Please run the login helper again.');
  }
  return await createSession(previous.refreshCount + 1, baseUrl);
}

async function refreshCliSession(previous: LoginSession, baseUrl?: string): Promise<LoginSession> {
  const next = await createRefreshedSession(previous, baseUrl);
  await writeQrHtml(next);
  openQrHtml();
  console.log(`[weixin-login] QR code refreshed (${next.refreshCount}/${MAX_REFRESHES})`);
  return next;
}

function persistConfirmedLogin(
  response: {
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
    bot_token?: string;
  },
  config: WeixinChannelConfig = {},
): { accountId: string } {
  if (!response.bot_token || !response.ilink_bot_id) {
    throw new Error('QR login confirmed, but WeChat did not return bot credentials.');
  }

  const accountId = normalizeAccountId(response.ilink_bot_id);
  upsertWeixinAccount({
    accountId,
    userId: response.ilink_user_id || '',
    baseUrl: config.baseUrl || response.baseurl || DEFAULT_BASE_URL,
    cdnBaseUrl: config.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
    token: response.bot_token,
    name: accountId,
    enabled: true,
  });
  return { accountId };
}

async function runWeixinLoginWebSession(
  sessionId: string,
  config: WeixinChannelConfig,
  onConfirmed?: (accountId: string) => Promise<void> | void,
): Promise<void> {
  let lastStatus: LoginStatus = 'waiting';

  try {
    while (true) {
      const active = webLoginSessions.get(sessionId);
      if (!active) return;

      if (Date.now() - active.startedAt > QR_TTL_MS) {
        const next = await createRefreshedSession(active, config.baseUrl);
        const qrSvg = await buildQrSvg(next.qrImageUrl);
        updateWebSession(sessionId, (current) => ({
          ...current,
          ...next,
          qrSvg,
          message: `二维码已刷新（${next.refreshCount}/${MAX_REFRESHES}），请使用新的二维码扫码。`,
        }));
        lastStatus = 'waiting';
        continue;
      }

      const response = await pollLoginQrStatus(active.qrcode, config.baseUrl);
      switch (response.status) {
        case 'wait':
          if (lastStatus !== 'waiting') {
            updateWebSession(sessionId, (current) => ({
              ...current,
              status: 'waiting',
              message: '等待扫码…',
            }));
            lastStatus = 'waiting';
          }
          break;
        case 'scaned':
          if (lastStatus !== 'scanned') {
            updateWebSession(sessionId, (current) => ({
              ...current,
              status: 'scanned',
              message: '二维码已扫码，请在手机上确认登录。',
            }));
            lastStatus = 'scanned';
          }
          break;
        case 'confirmed': {
          const persisted = persistConfirmedLogin(response, config);
          if (onConfirmed) {
            await onConfirmed(persisted.accountId);
          }
          updateWebSession(sessionId, (current) => ({
            ...current,
            status: 'confirmed',
            accountId: persisted.accountId,
            message: `微信扫码成功，账号 ${persisted.accountId} 已保存。`,
          }));
          return;
        }
        case 'expired': {
          const next = await createRefreshedSession(active, config.baseUrl);
          const qrSvg = await buildQrSvg(next.qrImageUrl);
          updateWebSession(sessionId, (current) => ({
            ...current,
            ...next,
            qrSvg,
            message: `二维码已过期，已自动刷新（${next.refreshCount}/${MAX_REFRESHES}）。`,
          }));
          lastStatus = 'waiting';
          continue;
        }
        default:
          break;
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    updateWebSession(sessionId, (current) => ({
      ...current,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function startWeixinLoginWebSession(options: {
  channelId?: string;
  config?: WeixinChannelConfig;
  onConfirmed?: (accountId: string) => Promise<void> | void;
} = {}): Promise<WeixinLoginWebSessionState> {
  pruneWebLoginSessions();
  ensureRuntimeDir();

  const config = options.config || {};
  const seed = await createSession(0, config.baseUrl);
  const sessionId = crypto.randomUUID();
  const qrSvg = await buildQrSvg(seed.qrImageUrl);
  const session: WeixinLoginRuntimeSession = {
    id: sessionId,
    channelId: options.channelId,
    ...seed,
    qrSvg,
    updatedAt: Date.now(),
    message: '等待扫码…',
  };

  webLoginSessions.set(sessionId, session);
  void runWeixinLoginWebSession(sessionId, config, options.onConfirmed);
  return toWebSessionState(session);
}

export function getWeixinLoginWebSession(sessionId: string): WeixinLoginWebSessionState | undefined {
  pruneWebLoginSessions();
  const session = webLoginSessions.get(sessionId);
  return session ? toWebSessionState(session) : undefined;
}

export async function runWeixinLogin(config: WeixinChannelConfig = {}): Promise<{ accountId: string; htmlPath: string }> {
  ensureRuntimeDir();
  let session = await createSession(0, config.baseUrl);
  await writeQrHtml(session);
  const opened = openQrHtml();

  console.log('[weixin-login] WeChat QR login started');
  console.log(`[weixin-login] QR page: ${HTML_PATH}`);
  if (!opened) {
    console.log('[weixin-login] Auto-open failed. Open the HTML file above manually in your browser.');
  }

  let lastStatus: LoginStatus = session.status;

  while (true) {
    if (Date.now() - session.startedAt > QR_TTL_MS) {
      session = await refreshCliSession(session, config.baseUrl);
      lastStatus = session.status;
    }

    const response = await pollLoginQrStatus(session.qrcode, config.baseUrl);
    switch (response.status) {
      case 'wait':
        session.status = 'waiting';
        break;
      case 'scaned':
        session.status = 'scanned';
        break;
      case 'confirmed': {
        session.status = 'confirmed';
        const persisted = persistConfirmedLogin(response, config);
        const accountId = persisted.accountId;
        console.log(`[weixin-login] Login successful. Saved linked account ${accountId}`);
        console.log('[weixin-login] You can now enable the `weixin` channel and start the bridge.');
        return { accountId, htmlPath: HTML_PATH };
      }
      case 'expired':
        session = await refreshCliSession(session, config.baseUrl);
        lastStatus = session.status;
        continue;
      default:
        session.status = 'waiting';
        break;
    }

    if (session.status !== lastStatus) {
      if (session.status === 'scanned') {
        console.log('[weixin-login] QR scanned. Please confirm the login in WeChat.');
      } else if (session.status === 'waiting') {
        console.log('[weixin-login] Waiting for QR scan...');
      }
      lastStatus = session.status;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

const isMainModule = (() => {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname);
})();

if (isMainModule) {
  runWeixinLogin().catch((err) => {
    console.error('[weixin-login] Failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
