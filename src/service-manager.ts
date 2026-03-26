import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CTI_HOME, loadRawConfigEnv } from './config.js';

export interface BridgeStatus {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

export interface UiServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..');
const runtimeDir = path.join(CTI_HOME, 'runtime');
const logsDir = path.join(CTI_HOME, 'logs');
const bridgePidFile = path.join(runtimeDir, 'bridge.pid');
const bridgeStatusFile = path.join(runtimeDir, 'status.json');
const uiStatusFile = path.join(runtimeDir, 'ui-server.json');
const uiPort = 4781;
const WINDOWS_HIDE = process.platform === 'win32' ? { windowsHide: true } : {};

function ensureDirs(): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function readPid(filePath: string): number | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getPackageRoot(): string {
  return packageRoot;
}

export function getUiServerUrl(port = uiPort): string {
  return `http://127.0.0.1:${port}`;
}

export function getCurrentUiServerUrl(): string | undefined {
  const status = readJsonFile<UiServerStatus | null>(uiStatusFile, null);
  if (!status?.port) return undefined;
  return getUiServerUrl(status.port);
}

export function getBridgeStatus(): BridgeStatus {
  const status = readJsonFile<BridgeStatus>(bridgeStatusFile, { running: false });
  const pid = readPid(bridgePidFile) ?? status.pid;
  if (!isProcessAlive(pid)) {
    return {
      ...status,
      pid,
      running: false,
    };
  }
  return {
    ...status,
    pid,
    running: status.running ?? true,
  };
}

export function getUiServerStatus(): UiServerStatus {
  const status = readJsonFile<UiServerStatus>(uiStatusFile, { running: false, port: uiPort });
  if (!isProcessAlive(status.pid)) {
    return {
      ...status,
      running: false,
      port: status.port ?? uiPort,
    };
  }
  return {
    ...status,
    running: true,
    port: status.port ?? uiPort,
  };
}

function buildDaemonEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  env.CTI_HOME = CTI_HOME;
  for (const [key, value] of loadRawConfigEnv()) {
    env[key] = value;
  }
  delete env.CLAUDECODE;
  return env;
}

async function waitForBridgeRunning(timeoutMs = 20_000): Promise<BridgeStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = getBridgeStatus();
    if (status.running) return status;
    await sleep(500);
  }
  return getBridgeStatus();
}

async function waitForUiServer(timeoutMs = 15_000): Promise<UiServerStatus> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = getUiServerStatus();
    if (status.running) {
      try {
        const response = await fetch(`${getUiServerUrl(status.port)}/api/ping`);
        if (response.ok) return status;
      } catch {
        // server not ready yet
      }
    }
    await sleep(300);
  }
  return getUiServerStatus();
}

export async function startBridge(): Promise<BridgeStatus> {
  ensureDirs();
  const current = getBridgeStatus();
  if (current.running) return current;

  const daemonEntry = path.join(packageRoot, 'dist', 'daemon.mjs');
  if (!fs.existsSync(daemonEntry)) {
    throw new Error(`Daemon bundle not found at ${daemonEntry}. Run npm run build first.`);
  }

  const stdoutFd = fs.openSync(path.join(logsDir, 'bridge-launcher.out.log'), 'a');
  const stderrFd = fs.openSync(path.join(logsDir, 'bridge-launcher.err.log'), 'a');

  const child = spawn(process.execPath, [daemonEntry], {
    cwd: packageRoot,
    detached: true,
    env: buildDaemonEnv(),
    stdio: ['ignore', stdoutFd, stderrFd],
    ...WINDOWS_HIDE,
  });
  child.unref();

  const status = await waitForBridgeRunning();
  if (!status.running) {
    throw new Error(status.lastExitReason || 'Bridge failed to report running=true.');
  }
  return status;
}

export async function stopBridge(): Promise<BridgeStatus> {
  const status = getBridgeStatus();
  if (!status.pid || !isProcessAlive(status.pid)) {
    return { ...status, running: false };
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('cmd', ['/c', 'taskkill', '/PID', String(status.pid), '/T', '/F'], {
        stdio: 'ignore',
        ...WINDOWS_HIDE,
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
  } else {
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const next = getBridgeStatus();
    if (!next.running) return next;
    await sleep(300);
  }

  return getBridgeStatus();
}

export async function restartBridge(): Promise<BridgeStatus> {
  await stopBridge();
  return await startBridge();
}

export function getBridgeLogs(lines = 200): string {
  ensureDirs();
  const filePath = path.join(logsDir, 'bridge.log');
  if (!fs.existsSync(filePath)) return '';
  const all = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

export async function ensureUiServerRunning(): Promise<UiServerStatus> {
  ensureDirs();
  const current = getUiServerStatus();
  if (current.running) return current;

  const serverEntry = path.join(packageRoot, 'dist', 'ui-server.mjs');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`UI server bundle not found at ${serverEntry}. Run npm run build first.`);
  }

  const stdoutFd = fs.openSync(path.join(logsDir, 'ui-server.out.log'), 'a');
  const stderrFd = fs.openSync(path.join(logsDir, 'ui-server.err.log'), 'a');

  const child = spawn(process.execPath, [serverEntry], {
    cwd: packageRoot,
    detached: true,
    env: {
      ...process.env,
      CTI_HOME,
    },
    stdio: ['ignore', stdoutFd, stderrFd],
    ...WINDOWS_HIDE,
  });
  child.unref();

  const status = await waitForUiServer();
  if (!status.running) {
    throw new Error('UI server failed to start.');
  }
  return status;
}

export async function stopUiServer(): Promise<UiServerStatus> {
  const status = getUiServerStatus();
  if (!status.pid || !isProcessAlive(status.pid)) {
    const next = { ...status, running: false };
    writeUiServerStatus(next);
    return next;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('cmd', ['/c', 'taskkill', '/PID', String(status.pid), '/T', '/F'], {
        stdio: 'ignore',
        ...WINDOWS_HIDE,
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
  } else {
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const next = getUiServerStatus();
    if (!next.running) {
      writeUiServerStatus({ ...next, running: false });
      return { ...next, running: false };
    }
    await sleep(300);
  }

  const next = getUiServerStatus();
  if (!next.running) {
    writeUiServerStatus({ ...next, running: false });
  }
  return next;
}

export function writeUiServerStatus(status: UiServerStatus): void {
  ensureDirs();
  fs.writeFileSync(uiStatusFile, JSON.stringify(status, null, 2), 'utf-8');
}

export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', ...WINDOWS_HIDE });
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}
