import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CTI_HOME, loadConfig, loadRawConfigEnv } from './config.js';
import type { ChannelInstance } from './config.js';

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

export interface DeferredGlobalNpmUninstallLaunch {
  command: string;
  args: string[];
  npmCommand: string;
  logPath: string;
  delayMs: number;
}

export interface PackageUninstallResult {
  ui: UiServerStatus;
  bridge: BridgeStatus;
  autostart: BridgeAutostartStatus;
  npmCommand: string;
  logPath: string;
  scheduled: boolean;
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
const npmUninstallLogFile = path.join(runtimeDir, 'npm-uninstall.log');
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

function collectTrackedBridgePids(
  bridgePid: number | undefined,
  statusPid: number | undefined,
): number[] {
  const unique = new Set<number>();
  for (const pid of [bridgePid, statusPid]) {
    if (Number.isFinite(pid) && (pid as number) > 0) {
      unique.add(pid as number);
    }
  }
  return [...unique];
}

function resolveTrackedBridgePid(
  bridgePid: number | undefined,
  statusPid: number | undefined,
  isAlive: (pid?: number) => boolean = isProcessAlive,
): number | undefined {
  if (isAlive(bridgePid)) return bridgePid;
  if (isAlive(statusPid)) return statusPid;
  return bridgePid ?? statusPid;
}

function getTrackedBridgePids(status?: BridgeStatus): number[] {
  const resolvedStatus = status ?? readJsonFile<BridgeStatus>(bridgeStatusFile, { running: false });
  return collectTrackedBridgePids(readPid(bridgePidFile), resolvedStatus.pid);
}

function clearBridgePidFile(): void {
  try {
    fs.unlinkSync(bridgePidFile);
  } catch {
    // ignore missing/stale pid file cleanup errors
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

export async function ensureWindowsAdminSession(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const raw = await runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  if (raw.trim().toLowerCase() !== 'true') {
    throw new Error('请先以管理员身份打开 PowerShell 或终端，再执行开机自启动安装/卸载命令。');
  }
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

export function buildDeferredGlobalNpmUninstallLaunch(options: {
  packageName?: string;
  logPath?: string;
  delayMs?: number;
  nodePath?: string;
  npmCommand?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
} = {}): DeferredGlobalNpmUninstallLaunch {
  const packageName = options.packageName || 'codex-to-im';
  const logPath = options.logPath || npmUninstallLogFile;
  const delayMs = options.delayMs ?? 1500;
  const platform = options.platform || process.platform;
  const npmCommand = options.npmCommand || (platform === 'win32' ? 'npm.cmd' : 'npm');
  const command = options.nodePath || process.execPath;
  const cwd = options.cwd || os.homedir();
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const logPath = ${JSON.stringify(logPath)};`,
    `const npmCommand = ${JSON.stringify(npmCommand)};`,
    `const npmArgs = ['uninstall', '-g', ${JSON.stringify(packageName)}];`,
    `const childCwd = ${JSON.stringify(cwd)};`,
    `const delayMs = ${JSON.stringify(delayMs)};`,
    'const writeLog = (message) => {',
    "  try { fs.appendFileSync(logPath, String(message).endsWith('\\n') ? String(message) : String(message) + '\\n'); } catch {}",
    '};',
    'setTimeout(() => {',
    '  let fd;',
    "  try { fd = fs.openSync(logPath, 'a'); } catch (error) { writeLog(error); process.exit(1); return; }",
    "  const child = spawn(npmCommand, npmArgs, { cwd: childCwd, detached: false, stdio: ['ignore', fd, fd], windowsHide: true });",
    '  child.on(\'error\', (error) => { writeLog(error); process.exit(1); });',
    "  child.on('close', (code) => { process.exit(typeof code === 'number' ? code : 0); });",
    '}, delayMs);',
  ].join('\n');

  return {
    command,
    args: ['-e', script],
    npmCommand,
    logPath,
    delayMs,
  };
}

async function launchDeferredGlobalNpmUninstall(): Promise<DeferredGlobalNpmUninstallLaunch> {
  ensureDirs();
  const launch = buildDeferredGlobalNpmUninstallLaunch();
  // The current CLI process still lives inside the global package directory, so
  // npm uninstall has to run from a detached follow-up process after this command exits.
  fs.writeFileSync(
    launch.logPath,
    [
      `[${new Date().toISOString()}] Scheduling global uninstall.`,
      `${launch.npmCommand} uninstall -g codex-to-im`,
      '',
    ].join('\n'),
    'utf-8',
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: os.homedir(),
      detached: true,
      stdio: 'ignore',
      ...WINDOWS_HIDE,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  return launch;
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
  const pid = resolveTrackedBridgePid(readPid(bridgePidFile), status.pid);
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

function describeBridgeStartupPreflightFailure(channels: ChannelInstance[] | undefined): string | null {
  const configured = Array.isArray(channels) ? channels : [];
  if (configured.length === 0) {
    return '未配置任何通道实例。请先在 Web 控制台创建并保存至少一个飞书或微信通道，然后再启动桥接服务。';
  }

  const enabled = configured.filter((channel) => channel.enabled !== false);
  if (enabled.length === 0) {
    return '当前所有通道实例都已禁用。请先启用至少一个通道实例，然后再启动桥接服务。';
  }

  return null;
}

function describeBridgeActivationFailure(
  status: BridgeStatus,
  channels: ChannelInstance[] | undefined,
): string | null {
  const statusReason = status.lastExitReason?.trim();
  if (statusReason) return statusReason;

  const preflightFailure = describeBridgeStartupPreflightFailure(channels);
  if (preflightFailure) return preflightFailure;

  const enabled = (channels || []).filter((channel) => channel.enabled !== false);
  if (enabled.length === 0) return null;

  const labels = enabled.map((channel) => channel.alias?.trim() || channel.id).join('、');
  return `没有任何通道适配器启动成功。请检查通道配置、凭据和日志。当前已启用通道：${labels}`;
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
  const extraAlivePids = getTrackedBridgePids(current)
    .filter((pid) => pid !== current.pid && isProcessAlive(pid));
  if (current.running && extraAlivePids.length === 0) return current;
  if (current.running && extraAlivePids.length > 0) {
    await stopBridge();
  }

  const config = loadConfig();
  const preflightFailure = describeBridgeStartupPreflightFailure(config.channels);
  if (preflightFailure) {
    throw new Error(preflightFailure);
  }

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
    throw new Error(
      describeBridgeActivationFailure(status, config.channels)
      || 'Bridge failed to report running=true.',
    );
  }
  return status;
}

export async function stopBridge(): Promise<BridgeStatus> {
  const status = readJsonFile<BridgeStatus>(bridgeStatusFile, { running: false });
  const pids = getTrackedBridgePids(status).filter((pid) => isProcessAlive(pid));
  if (pids.length === 0) {
    clearBridgePidFile();
    return { ...getBridgeStatus(), running: false };
  }

  for (const pid of pids) {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('cmd', ['/c', 'taskkill', '/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          ...WINDOWS_HIDE,
        });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
      });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      clearBridgePidFile();
      return getBridgeStatus();
    }
    await sleep(300);
  }

  clearBridgePidFile();
  return getBridgeStatus();
}

export const _testOnly = {
  collectTrackedBridgePids,
  resolveTrackedBridgePid,
  describeBridgeStartupPreflightFailure,
  describeBridgeActivationFailure,
};

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
  ].join('\n');

  try {
    const raw = await runPowerShell(script);
    return {
      ...base,
      ...parsePowerShellJson<BridgeAutostartStatus>(raw),
    };
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

  await ensureWindowsAdminSession();

  const launcherPath = ensureBridgeAutostartLauncher();
  const user = getCurrentWindowsUser();
  const script = [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${escapePowerShellSingleQuoted(launcherPath)}"'`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName '${escapePowerShellSingleQuoted(bridgeAutostartTaskName)}' -Action $action -Trigger $trigger -Settings $settings -User '${escapePowerShellSingleQuoted(user)}' -Password '${escapePowerShellSingleQuoted(password)}' -RunLevel Limited -Force | Out-Null`,
  ].join('; ');

  await runPowerShell(script);
  return await getBridgeAutostartStatus();
}

export async function uninstallBridgeAutostart(): Promise<BridgeAutostartStatus> {
  if (process.platform !== 'win32') {
    return await getBridgeAutostartStatus();
  }

  await ensureWindowsAdminSession();

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

export async function uninstallCodexToImPackage(): Promise<PackageUninstallResult> {
  const autostartBefore = await getBridgeAutostartStatus();
  if (process.platform === 'win32' && autostartBefore.installed) {
    await ensureWindowsAdminSession();
  }

  const ui = await stopUiServer();
  const bridge = await stopBridge();
  const autostart = autostartBefore.installed
    ? await uninstallBridgeAutostart()
    : autostartBefore;

  if (autostart.installed) {
    throw new Error(`未能删除开机自启动任务 ${autostart.taskName}，已取消 npm 全局卸载。`);
  }

  const launch = await launchDeferredGlobalNpmUninstall();
  return {
    ui,
    bridge,
    autostart,
    npmCommand: launch.npmCommand,
    logPath: launch.logPath,
    scheduled: true,
  };
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
