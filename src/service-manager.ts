import fs from 'node:fs';
import os from 'node:os';
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
  adapters?: Array<{
    channelType: string;
    channelProvider?: string;
    channelAlias?: string;
    running: boolean;
    connectedAt: string | null;
    lastMessageAt: string | null;
    error: string | null;
  }>;
  lastExitReason?: string;
}

export interface UiServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
}

export interface BridgeAutostartStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  mode: 'startup';
  taskName: string;
  runAsUser?: string;
  state?: string;
  launcherPath?: string;
  error?: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..');
const runtimeDir = path.join(CTI_HOME, 'runtime');
const logsDir = path.join(CTI_HOME, 'logs');
const bridgePidFile = path.join(runtimeDir, 'bridge.pid');
const bridgeStatusFile = path.join(runtimeDir, 'status.json');
const uiStatusFile = path.join(runtimeDir, 'ui-server.json');
const uiPort = 4781;
const bridgeAutostartTaskName = 'CodexToIMBridge';
const bridgeAutostartLauncherFile = path.join(runtimeDir, 'bridge-autostart.ps1');
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

function getCurrentWindowsUser(): string {
  const user = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...WINDOWS_HIDE,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function runPowerShell(script: string): Promise<string> {
  const result = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  );
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || 'PowerShell command failed.').trim());
  }
  return result.stdout.trim();
}

function ensureBridgeAutostartLauncher(): string {
  ensureDirs();
  const content = [
    "$ErrorActionPreference = 'Stop'",
    `$env:CTI_HOME = '${escapePowerShellSingleQuoted(CTI_HOME)}'`,
    "$cmd = Get-Command 'codex-to-im.cmd' -ErrorAction SilentlyContinue",
    "if (-not $cmd) { $cmd = Get-Command 'codex-to-im' -ErrorAction SilentlyContinue }",
    "$node = (Get-Command 'node' -ErrorAction Stop).Source",
    'if ($cmd) {',
    '  & $cmd.Source start',
    '  exit $LASTEXITCODE',
    '}',
    "$npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue",
    "if (-not $npm) { $npm = Get-Command 'npm' -ErrorAction SilentlyContinue }",
    'if ($npm) {',
    '  try {',
    '    $globalRoot = (& $npm.Source root -g 2>$null).Trim()',
    '    if ($globalRoot) {',
    "      $cliPath = Join-Path (Join-Path $globalRoot 'codex-to-im') 'dist\\cli.mjs'",
    '      if (Test-Path $cliPath) {',
    '        & $node $cliPath start',
    '        exit $LASTEXITCODE',
    '      }',
    '    }',
    '  } catch { }',
    '}',
    `& $node '${escapePowerShellSingleQuoted(path.join(packageRoot, 'dist', 'cli.mjs'))}' start`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');

  fs.writeFileSync(bridgeAutostartLauncherFile, content, 'utf-8');
  return bridgeAutostartLauncherFile;
}

function parsePowerShellJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
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
    running: true,
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

export async function getBridgeAutostartStatus(): Promise<BridgeAutostartStatus> {
  const base: BridgeAutostartStatus = {
    supported: process.platform === 'win32',
    installed: false,
    enabled: false,
    mode: 'startup',
    taskName: bridgeAutostartTaskName,
    runAsUser: process.platform === 'win32' ? getCurrentWindowsUser() : undefined,
    launcherPath: bridgeAutostartLauncherFile,
  };
  if (process.platform !== 'win32') {
    return {
      ...base,
      error: '当前只支持 Windows 自动启动。',
    };
  }

  const script = [
    `$task = Get-ScheduledTask -TaskName '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}' -ErrorAction SilentlyContinue`,
    'if (-not $task) {',
    '  [pscustomobject]@{',
    '    supported = $true',
    '    installed = $false',
    '    enabled = $false',
    `    mode = 'startup'`,
    `    taskName = '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}'`,
    `    launcherPath = '${escapePowerShellSingleQuoted(bridgeAutostartLauncherFile)}'`,
    '  } | ConvertTo-Json -Compress',
    '  exit 0',
    '}',
    `$info = Get-ScheduledTaskInfo -TaskName '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}' -ErrorAction SilentlyContinue`,
    '[pscustomobject]@{',
    '  supported = $true',
    '  installed = $true',
    '  enabled = [bool]$task.Settings.Enabled',
    `  mode = 'startup'`,
    `  taskName = '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}'`,
    `  launcherPath = '${escapePowerShellSingleQuoted(bridgeAutostartLauncherFile)}'`,
    '  runAsUser = $task.Principal.UserId',
    '  state = [string]$task.State',
    '} | ConvertTo-Json -Compress',
  ].join('; ');

  try {
    const raw = await runPowerShell(script);
    return parsePowerShellJson<BridgeAutostartStatus>(raw);
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installBridgeAutostart(password: string): Promise<BridgeAutostartStatus> {
  if (process.platform !== 'win32') {
    throw new Error('当前只支持 Windows 自动启动。');
  }
  if (!password) {
    throw new Error('当前 Windows 登录密码不能为空。');
  }

  const launcherPath = ensureBridgeAutostartLauncher();
  const user = getCurrentWindowsUser();
  const script = [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${escapePowerShellSingleQuoted(launcherPath)}"'`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}' -Action $action -Trigger $trigger -Settings $settings -User '${escapePowerShellSingleQuoted(user)}' -Password '${escapePowerShellSingleQuoted(password)}' -RunLevel Highest -Force | Out-Null`,
  ].join('; ');

  await runPowerShell(script);
  return await getBridgeAutostartStatus();
}

export async function uninstallBridgeAutostart(): Promise<BridgeAutostartStatus> {
  if (process.platform !== 'win32') {
    return await getBridgeAutostartStatus();
  }

  const script = [
    `$task = Get-ScheduledTask -TaskName '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}' -ErrorAction SilentlyContinue`,
    'if ($task) {',
    `  Unregister-ScheduledTask -TaskName '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}' -Confirm:$false`,
    '}',
  ].join('; ');

  await runPowerShell(script);
  try {
    if (fs.existsSync(bridgeAutostartLauncherFile)) {
      fs.unlinkSync(bridgeAutostartLauncherFile);
    }
  } catch {
    // ignore launcher cleanup failure
  }
  return await getBridgeAutostartStatus();
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

export async function installCodexIntegration(): Promise<{ targetDir: string; method: 'junction' | 'copy' | 'existing' }> {
  const sourceSkill = path.join(packageRoot, 'SKILL.md');
  if (!fs.existsSync(sourceSkill)) {
    throw new Error(`SKILL.md not found at ${sourceSkill}`);
  }

  const skillsDir = path.join(os.homedir(), '.codex', 'skills');
  const targetDir = path.join(skillsDir, 'codex-to-im');
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(targetDir)) {
    return { targetDir, method: 'existing' };
  }

  try {
    fs.symlinkSync(packageRoot, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
    return { targetDir, method: 'junction' };
  } catch {
    fs.cpSync(packageRoot, targetDir, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(packageRoot, source);
        if (!relative) return true;
        if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) return false;
        if (relative === 'node_modules' || relative.startsWith(`node_modules${path.sep}`)) return false;
        return true;
      },
    });
    return { targetDir, method: 'copy' };
  }
}

export function isCodexIntegrationInstalled(): boolean {
  const targetDir = path.join(os.homedir(), '.codex', 'skills', 'codex-to-im');
  return fs.existsSync(path.join(targetDir, 'SKILL.md'));
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
