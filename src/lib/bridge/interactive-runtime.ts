import type { BridgeSession, BridgeStore } from './host.js';
import type { InteractiveTaskState } from './interactive-message-runner.js';
import { deliverBridgeNotice } from './feedback-delivery.js';

export interface BridgeInteractiveRuntimeState {
  activeTasks: Map<string, InteractiveTaskState>;
  queuedCounts: Map<string, number>;
  sessionLocks: Map<string, Promise<void>>;
}

export interface CreateInteractiveRuntimeOptions {
  idleReminderMs: number;
}

export interface CreateInteractiveRuntimeDeps {
  getStore(): Pick<BridgeStore, 'getSession' | 'listSessions' | 'updateSession'>;
  nowIso(): string;
}

export interface InteractiveRuntime {
  getActiveTask(sessionId: string): InteractiveTaskState | undefined;
  getQueuedCount(sessionId: string): number;
  registerInteractiveTask(task: InteractiveTaskState): void;
  isCurrentInteractiveTask(sessionId: string, taskId: string): boolean;
  touchInteractiveTask(sessionId: string, taskId: string): void;
  releaseInteractiveTask(sessionId: string, taskId: string): void;
  syncSessionRuntimeState(sessionId: string): void;
  reconcileIdleInteractiveTasks(): Promise<void>;
  resetPersistedInteractiveRuntimeState(): void;
  processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void>;
}

function buildInteractiveIdleReminderNotice(): string {
  return [
    '提醒：这轮任务仍在运行，但已经超过 10 分钟没有新的执行输出。',
    '系统不会自动终止它；如果你仍在对应线程，可发送 `/stop` 主动停止；如果已经切到别的线程，需要先切回对应线程。',
  ].join('\n');
}

export function createInteractiveRuntime(
  getState: () => BridgeInteractiveRuntimeState,
  options: CreateInteractiveRuntimeOptions,
  deps: CreateInteractiveRuntimeDeps,
): InteractiveRuntime {
  function getQueuedCount(sessionId: string): number {
    return getState().queuedCounts.get(sessionId) || 0;
  }

  function getActiveTask(sessionId: string): InteractiveTaskState | undefined {
    return getState().activeTasks.get(sessionId);
  }

  function syncSessionRuntimeState(sessionId: string): void {
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const queuedCount = getQueuedCount(sessionId);
    const isRunning = getState().activeTasks.has(sessionId);
    const runtimeStatus: BridgeSession['runtime_status'] = queuedCount > 0
      ? 'queued'
      : isRunning
        ? 'running'
        : 'idle';

    if (
      session.queued_count === queuedCount
      && session.runtime_status === runtimeStatus
    ) {
      return;
    }

    store.updateSession(sessionId, {
      queued_count: queuedCount,
      runtime_status: runtimeStatus,
      last_runtime_update_at: deps.nowIso(),
    });
  }

  function registerInteractiveTask(task: InteractiveTaskState): void {
    getState().activeTasks.set(task.sessionId, task);
    syncSessionRuntimeState(task.sessionId);
  }

  function isCurrentInteractiveTask(sessionId: string, taskId: string): boolean {
    return getState().activeTasks.get(sessionId)?.id === taskId;
  }

  function touchInteractiveTask(sessionId: string, taskId: string): void {
    const task = getState().activeTasks.get(sessionId);
    if (task?.id !== taskId) return;
    task.lastActivityAt = Date.now();
    task.idleReminderSent = false;
  }

  function releaseInteractiveTask(sessionId: string, taskId: string): void {
    const state = getState();
    const current = state.activeTasks.get(sessionId);
    if (current?.id !== taskId) return;
    state.activeTasks.delete(sessionId);
    syncSessionRuntimeState(sessionId);
  }

  async function remindIdleInteractiveTask(task: InteractiveTaskState): Promise<void> {
    if (!isCurrentInteractiveTask(task.sessionId, task.id) || task.idleReminderSent) return;
    task.idleReminderSent = true;

    try {
      await deliverBridgeNotice(task.adapter, task.address, buildInteractiveIdleReminderNotice(), {
        sessionId: task.sessionId,
        replyToMessageId: task.requestMessageId,
      });
    } catch {
      // best effort reminder
    }
  }

  async function reconcileIdleInteractiveTasks(): Promise<void> {
    const now = Date.now();
    const tasks = Array.from(getState().activeTasks.values());
    for (const task of tasks) {
      if (task.idleReminderSent) continue;
      if (now - task.lastActivityAt < options.idleReminderMs) continue;
      await remindIdleInteractiveTask(task);
    }
  }

  function resetPersistedInteractiveRuntimeState(): void {
    const store = deps.getStore();
    for (const session of store.listSessions()) {
      const queuedCount = session.queued_count && session.queued_count > 0
        ? session.queued_count
        : 0;
      if (queuedCount === 0 && session.runtime_status !== 'running' && session.runtime_status !== 'queued') {
        continue;
      }
      store.updateSession(session.id, {
        queued_count: 0,
        runtime_status: 'idle',
        last_runtime_update_at: deps.nowIso(),
      });
    }
  }

  function incrementQueuedCount(sessionId: string): void {
    const state = getState();
    state.queuedCounts.set(sessionId, getQueuedCount(sessionId) + 1);
    syncSessionRuntimeState(sessionId);
  }

  function decrementQueuedCount(sessionId: string): void {
    const state = getState();
    const next = Math.max(0, getQueuedCount(sessionId) - 1);
    if (next > 0) {
      state.queuedCounts.set(sessionId, next);
    } else {
      state.queuedCounts.delete(sessionId);
    }
    syncSessionRuntimeState(sessionId);
  }

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const state = getState();
    const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
    const queued = state.sessionLocks.has(sessionId);
    if (queued) {
      incrementQueuedCount(sessionId);
    }
    const wrapped = async () => {
      if (queued) {
        decrementQueuedCount(sessionId);
      }
      await fn();
    };
    const current = prev.then(wrapped, wrapped);
    state.sessionLocks.set(sessionId, current);
    current.finally(() => {
      if (state.sessionLocks.get(sessionId) === current) {
        state.sessionLocks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return {
    getActiveTask,
    getQueuedCount,
    registerInteractiveTask,
    isCurrentInteractiveTask,
    touchInteractiveTask,
    releaseInteractiveTask,
    syncSessionRuntimeState,
    reconcileIdleInteractiveTasks,
    resetPersistedInteractiveRuntimeState,
    processWithSessionLock,
  };
}
