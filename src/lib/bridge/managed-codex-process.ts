import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const PROCESS_STOP_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_WAIT_MS = 5_000;

export interface ManagedCodexExecProcessIdentity {
  threadId: string;
  pid: number;
  parentPid: number;
  createdAt: string;
}

export interface ManagedCodexProcessSnapshot {
  pid: number;
  parentPid: number;
  createdAt: string;
  name: string;
  commandLine: string;
}

export type ManagedCodexProcessInspection =
  | { status: 'found'; process: ManagedCodexProcessSnapshot }
  | { status: 'not_found' }
  | { status: 'unsupported'; error: string }
  | { status: 'error'; error: string };

export type ManagedCodexProcessStopResult =
  | { status: 'stopped' }
  | { status: 'not_running' }
  | { status: 'unsafe'; error: string }
  | { status: 'unsupported'; error: string }
  | { status: 'failed'; error: string };

export interface StopManagedCodexExecProcessDeps {
  inspectProcess?(pid: number): Promise<ManagedCodexProcessInspection>;
  terminateProcessTree?(pid: number): Promise<void>;
  sleep?(delayMs: number): Promise<void>;
  nowMs?(): number;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSnapshot(raw: unknown): ManagedCodexProcessSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const pid = Number(record.ProcessId);
  const parentPid = Number(record.ParentProcessId);
  const createdAt = typeof record.CreationDate === 'string' ? record.CreationDate.trim() : '';
  const name = typeof record.Name === 'string' ? record.Name.trim() : '';
  const commandLine = typeof record.CommandLine === 'string' ? record.CommandLine.trim() : '';
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid <= 0) {
    return null;
  }
  if (!createdAt || !name || !commandLine) return null;
  return { pid, parentPid, createdAt, name, commandLine };
}

function parseSnapshots(stdout: string): ManagedCodexProcessSnapshot[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .map((record) => normalizeSnapshot(record))
    .filter((record): record is ManagedCodexProcessSnapshot => Boolean(record));
}

export function isManagedCodexExecProcess(
  processSnapshot: ManagedCodexProcessSnapshot,
  expected: Pick<ManagedCodexExecProcessIdentity, 'threadId' | 'parentPid'>,
): boolean {
  if (processSnapshot.name.toLowerCase() !== 'codex.exe') return false;
  if (processSnapshot.parentPid !== expected.parentPid) return false;

  const commandLine = processSnapshot.commandLine;
  if (!/(?:^|\s)exec(?=\s|$)/i.test(commandLine)) return false;
  const threadId = escapeRegex(expected.threadId.trim());
  if (!threadId) return false;
  const resumePattern = new RegExp(
    `(?:^|\\s)resume\\s+(?:"${threadId}"|${threadId})(?=\\s|$)`,
    'i',
  );
  return resumePattern.test(commandLine);
}

export async function captureManagedCodexExecProcess(
  threadId: string,
  ownerPid = process.pid,
): Promise<ManagedCodexExecProcessIdentity | null> {
  const normalizedThreadId = threadId.trim();
  if (process.platform !== 'win32' || !normalizedThreadId || !Number.isInteger(ownerPid) || ownerPid <= 0) {
    return null;
  }

  const escapedThreadId = escapePowerShellSingleQuoted(normalizedThreadId);
  const script = [
    `$threadId = '${escapedThreadId}'`,
    '$escaped = [regex]::Escape($threadId)',
    `$ownerPid = ${ownerPid}`,
    '$procs = Get-CimInstance Win32_Process | Where-Object {',
    "  $_.Name -ieq 'codex.exe' -and [int]$_.ParentProcessId -eq $ownerPid -and $_.CommandLine -match $escaped",
    '} | Select-Object ProcessId, ParentProcessId, CreationDate, Name, CommandLine',
    "if ($null -eq $procs) { '' } else { $procs | ConvertTo-Json -Compress }",
  ].join('; ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        encoding: 'utf8',
      },
    );
    const snapshot = parseSnapshots(stdout).find((candidate) => isManagedCodexExecProcess(candidate, {
      threadId: normalizedThreadId,
      parentPid: ownerPid,
    }));
    return snapshot ? {
      threadId: normalizedThreadId,
      pid: snapshot.pid,
      parentPid: snapshot.parentPid,
      createdAt: snapshot.createdAt,
    } : null;
  } catch {
    return null;
  }
}

export async function inspectManagedCodexProcess(
  pid: number,
): Promise<ManagedCodexProcessInspection> {
  if (process.platform !== 'win32') {
    return { status: 'unsupported', error: 'Managed Desktop task stopping is currently supported only on Windows.' };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 'error', error: 'Invalid Codex process id.' };
  }

  const script = [
    `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -First 1 ProcessId, ParentProcessId, CreationDate, Name, CommandLine`,
    "if ($null -eq $proc) { '' } else { $proc | ConvertTo-Json -Compress }",
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        encoding: 'utf8',
      },
    );
    const snapshot = parseSnapshots(stdout)[0];
    return snapshot ? { status: 'found', process: snapshot } : { status: 'not_found' };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync(
    'taskkill.exe',
    ['/PID', String(pid), '/T', '/F'],
    {
      windowsHide: true,
      timeout: PROCESS_STOP_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    },
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function stopManagedCodexExecProcess(
  identity: ManagedCodexExecProcessIdentity,
  deps: StopManagedCodexExecProcessDeps = {},
): Promise<ManagedCodexProcessStopResult> {
  const inspectProcess = deps.inspectProcess ?? inspectManagedCodexProcess;
  const terminateProcessTree = deps.terminateProcessTree ?? terminateWindowsProcessTree;
  const sleepFn = deps.sleep ?? sleep;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const initial = await inspectProcess(identity.pid);
  if (initial.status === 'not_found') return { status: 'not_running' };
  if (initial.status === 'unsupported') return initial;
  if (initial.status === 'error') return { status: 'failed', error: initial.error };
  if (
    initial.process.createdAt !== identity.createdAt
    || !isManagedCodexExecProcess(initial.process, identity)
  ) {
    return {
      status: 'unsafe',
      error: 'The recorded process identity no longer matches the bridge-owned Codex exec process.',
    };
  }

  try {
    await terminateProcessTree(identity.pid);
  } catch (error) {
    const afterFailure = await inspectProcess(identity.pid);
    if (afterFailure.status === 'not_found') return { status: 'stopped' };
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }

  const deadline = nowMs() + PROCESS_EXIT_WAIT_MS;
  while (nowMs() < deadline) {
    const inspection = await inspectProcess(identity.pid);
    if (inspection.status === 'not_found') return { status: 'stopped' };
    if (inspection.status === 'found') {
      if (
        inspection.process.createdAt !== identity.createdAt
        || !isManagedCodexExecProcess(inspection.process, identity)
      ) {
        return { status: 'stopped' };
      }
    } else if (inspection.status === 'unsupported') {
      return inspection;
    } else {
      return { status: 'failed', error: inspection.error };
    }
    await sleepFn(100);
  }
  return { status: 'failed', error: 'Codex process did not exit before the stop timeout.' };
}
