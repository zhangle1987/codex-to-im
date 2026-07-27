import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import type { BridgeSession, BridgeStore } from './host.js';
import {
  captureManagedCodexExecProcess,
  inspectManagedCodexProcess,
  isManagedCodexExecProcess,
  stopManagedCodexExecProcess,
  type ManagedCodexExecProcessIdentity,
  type ManagedCodexProcessInspection,
  type ManagedCodexProcessStopResult,
} from './managed-codex-process.js';

export interface DesktopHandoffTaskRegistration {
  sessionId: string;
  taskId: string;
  threadId: string;
  turnId: string;
}

export interface DesktopHandoffTaskDescriptor extends DesktopHandoffTaskRegistration {
  ownerPid: number;
  registeredAt: string;
  active: boolean;
  processIdentity: ManagedCodexExecProcessIdentity | null;
}

export type DesktopHandoffTaskStopResult =
  | { status: 'stopped'; task: DesktopHandoffTaskDescriptor }
  | { status: 'not_running'; task?: DesktopHandoffTaskDescriptor }
  | { status: 'unavailable'; task: DesktopHandoffTaskDescriptor; error: string }
  | { status: 'failed'; task: DesktopHandoffTaskDescriptor; error: string };

export interface DesktopHandoffControl {
  prepareTask(task: DesktopHandoffTaskRegistration): Promise<boolean>;
  activateTask(sessionId: string, taskId: string): Promise<boolean>;
  releaseTask(sessionId: string, taskId?: string): void;
  hasTask(sessionId: string): boolean;
  reconcilePersistedTasks(): Promise<number>;
  stopTask(sessionId: string): Promise<DesktopHandoffTaskStopResult>;
  observeRecords(sessionId: string, threadId: string, records: DesktopMirrorRecord[]): void;
}

export interface CreateDesktopHandoffControlDeps {
  getStore(): Pick<BridgeStore, 'getSession' | 'listSessions' | 'updateSession'>;
  captureProcess?(threadId: string, ownerPid: number): Promise<ManagedCodexExecProcessIdentity | null>;
  inspectProcess?(pid: number): Promise<ManagedCodexProcessInspection>;
  stopProcess?(identity: ManagedCodexExecProcessIdentity): Promise<ManagedCodexProcessStopResult>;
  nowIso?(): string;
  ownerPid?: number;
}

function clearHandoffFields(): Partial<BridgeSession> {
  return {
    desktop_handoff_task_id: undefined,
    desktop_handoff_thread_id: undefined,
    desktop_handoff_turn_id: undefined,
    desktop_handoff_owner_pid: undefined,
    desktop_handoff_process_pid: undefined,
    desktop_handoff_process_parent_pid: undefined,
    desktop_handoff_process_created_at: undefined,
    desktop_handoff_registered_at: undefined,
    desktop_handoff_active: undefined,
  };
}

function readTask(session: BridgeSession | null): DesktopHandoffTaskDescriptor | null {
  const sessionId = session?.id || '';
  const taskId = session?.desktop_handoff_task_id?.trim() || '';
  const threadId = session?.desktop_handoff_thread_id?.trim() || '';
  const turnId = session?.desktop_handoff_turn_id?.trim() || '';
  const registeredAt = session?.desktop_handoff_registered_at?.trim() || '';
  const ownerPid = Number(session?.desktop_handoff_owner_pid);
  if (!sessionId || !taskId || !threadId || !turnId || !registeredAt) return null;
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;

  const pid = Number(session?.desktop_handoff_process_pid);
  const parentPid = Number(session?.desktop_handoff_process_parent_pid);
  const createdAt = session?.desktop_handoff_process_created_at?.trim() || '';
  const hasProcessIdentity = Number.isInteger(pid)
    && pid > 0
    && Number.isInteger(parentPid)
    && parentPid > 0
    && Boolean(createdAt);

  return {
    sessionId,
    taskId,
    threadId,
    turnId,
    ownerPid,
    registeredAt,
    active: session?.desktop_handoff_active === true,
    processIdentity: hasProcessIdentity ? {
      threadId,
      pid,
      parentPid,
      createdAt,
    } : null,
  };
}

function isTerminalRecord(record: DesktopMirrorRecord): boolean {
  return record.type === 'task_complete' || record.type === 'task_aborted';
}

export function createDesktopHandoffControl(
  deps: CreateDesktopHandoffControlDeps,
): DesktopHandoffControl {
  const captureProcess = deps.captureProcess ?? captureManagedCodexExecProcess;
  const inspectProcess = deps.inspectProcess ?? inspectManagedCodexProcess;
  const stopProcess = deps.stopProcess ?? stopManagedCodexExecProcess;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const ownerPid = deps.ownerPid ?? process.pid;

  function releaseTask(sessionId: string, taskId?: string): void {
    const store = deps.getStore();
    const current = readTask(store.getSession(sessionId));
    if (!current) return;
    if (taskId && current.taskId !== taskId) return;
    store.updateSession(sessionId, clearHandoffFields(), { touch: false });
  }

  async function prepareTask(task: DesktopHandoffTaskRegistration): Promise<boolean> {
    const store = deps.getStore();
    const session = store.getSession(task.sessionId);
    if (!session) return false;
    const registeredAt = nowIso();
    store.updateSession(task.sessionId, {
      ...clearHandoffFields(),
      desktop_handoff_task_id: task.taskId,
      desktop_handoff_thread_id: task.threadId,
      desktop_handoff_turn_id: task.turnId,
      desktop_handoff_owner_pid: ownerPid,
      desktop_handoff_registered_at: registeredAt,
      desktop_handoff_active: false,
    }, { touch: false });

    let identity: ManagedCodexExecProcessIdentity | null = null;
    try {
      identity = await captureProcess(task.threadId, ownerPid);
    } catch (error) {
      console.warn(
        `[desktop-handoff] Failed to capture Codex exec process for ${task.threadId}:`,
        error instanceof Error ? error.message : error,
      );
    }
    if (!identity) return false;

    const current = readTask(store.getSession(task.sessionId));
    if (!current || current.taskId !== task.taskId || current.turnId !== task.turnId) return false;
    store.updateSession(task.sessionId, {
      desktop_handoff_process_pid: identity.pid,
      desktop_handoff_process_parent_pid: identity.parentPid,
      desktop_handoff_process_created_at: identity.createdAt,
    }, { touch: false });
    return true;
  }

  function hasTask(sessionId: string): boolean {
    return readTask(deps.getStore().getSession(sessionId))?.active === true;
  }

  async function inspectTaskProcess(
    task: DesktopHandoffTaskDescriptor,
  ): Promise<'running' | 'gone' | 'unknown'> {
    const identity = task.processIdentity;
    if (!identity) return 'gone';

    let inspection: ManagedCodexProcessInspection;
    try {
      inspection = await inspectProcess(identity.pid);
    } catch (error) {
      console.warn(
        `[desktop-handoff] Failed to inspect Codex exec process ${identity.pid}:`,
        error instanceof Error ? error.message : error,
      );
      return 'unknown';
    }
    if (inspection.status === 'not_found') return 'gone';
    if (inspection.status !== 'found') {
      console.warn(
        `[desktop-handoff] Codex exec process ${identity.pid} inspection was inconclusive:`,
        inspection.error,
      );
      return 'unknown';
    }
    if (
      inspection.process.createdAt !== identity.createdAt
      || !isManagedCodexExecProcess(inspection.process, identity)
    ) {
      return 'gone';
    }
    return 'running';
  }

  async function activateTask(sessionId: string, taskId: string): Promise<boolean> {
    const store = deps.getStore();
    const current = readTask(store.getSession(sessionId));
    if (!current || current.taskId !== taskId) return false;
    const processStatus = await inspectTaskProcess(current);
    if (processStatus !== 'running') {
      releaseTask(sessionId, taskId);
      console.warn(
        `[desktop-handoff] Refused handoff for ${current.threadId}/${current.turnId}: `
        + `bridge-owned Codex exec process is ${processStatus}.`,
      );
      return false;
    }
    store.updateSession(sessionId, { desktop_handoff_active: true }, { touch: false });
    return true;
  }

  async function reconcilePersistedTasks(): Promise<number> {
    const store = deps.getStore();
    let released = 0;
    for (const session of store.listSessions()) {
      const task = readTask(session);
      if (!task) continue;
      if (!task.active || !task.processIdentity) {
        releaseTask(task.sessionId, task.taskId);
        released += 1;
        continue;
      }
      const processStatus = await inspectTaskProcess(task);
      if (processStatus === 'gone') {
        releaseTask(task.sessionId, task.taskId);
        released += 1;
      }
    }
    return released;
  }

  async function stopTask(sessionId: string): Promise<DesktopHandoffTaskStopResult> {
    const store = deps.getStore();
    let task = readTask(store.getSession(sessionId));
    if (!task || !task.active) return { status: 'not_running' };

    if (!task.processIdentity) {
      let identity: ManagedCodexExecProcessIdentity | null = null;
      try {
        identity = await captureProcess(task.threadId, task.ownerPid);
      } catch (error) {
        return {
          status: 'failed',
          task,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!identity) {
        return {
          status: 'unavailable',
          task,
          error: '未找到可验证为 bridge 自有的 Codex exec 进程。',
        };
      }
      store.updateSession(sessionId, {
        desktop_handoff_process_pid: identity.pid,
        desktop_handoff_process_parent_pid: identity.parentPid,
        desktop_handoff_process_created_at: identity.createdAt,
      }, { touch: false });
      task = { ...task, processIdentity: identity };
    }

    const processIdentity = task.processIdentity;
    if (!processIdentity) {
      return { status: 'unavailable', task, error: '未能保存可验证的 Codex exec 进程身份。' };
    }

    let stopped: ManagedCodexProcessStopResult;
    try {
      stopped = await stopProcess(processIdentity);
    } catch (error) {
      return {
        status: 'failed',
        task,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (stopped.status === 'stopped') {
      releaseTask(sessionId, task.taskId);
      return { status: 'stopped', task };
    }
    if (stopped.status === 'not_running') {
      releaseTask(sessionId, task.taskId);
      return { status: 'not_running', task };
    }
    if (stopped.status === 'unsafe') {
      releaseTask(sessionId, task.taskId);
      return { status: 'unavailable', task, error: stopped.error };
    }
    if (stopped.status === 'unsupported') {
      return { status: 'unavailable', task, error: stopped.error };
    }
    return { status: 'failed', task, error: stopped.error };
  }

  function observeRecords(
    sessionId: string,
    threadId: string,
    records: DesktopMirrorRecord[],
  ): void {
    if (records.length === 0) return;
    const task = readTask(deps.getStore().getSession(sessionId));
    if (!task || task.threadId !== threadId) return;
    if (records.some((record) => (
      record.turnId === task.turnId && isTerminalRecord(record)
    ))) {
      releaseTask(sessionId, task.taskId);
    }
  }

  return {
    prepareTask,
    activateTask,
    releaseTask,
    hasTask,
    reconcilePersistedTasks,
    stopTask,
    observeRecords,
  };
}
