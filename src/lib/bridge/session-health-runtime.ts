import type { DesktopMirrorRecord } from '../../desktop-sessions.js';
import type { BridgeSession, BridgeStore } from './host.js';
import type { ThreadProcessProbeResult } from './session-health-process.js';
import {
  applyProcessProbeDiagnosis,
  getActiveToolStartedAt,
  buildEndStatus,
  buildProgressReason,
  computeBaseDiagnosis,
  HEALTH_PROCESS_PROBE_CACHE_MS,
  HEALTH_PROGRESS_PERSIST_THROTTLE_MS,
  parseActiveToolsJson,
  serializeActiveTools,
  shouldTrackSession,
  summarizeActiveTools,
} from './session-health-reducer.js';
import type {
  SessionEndOutcome,
  SessionHealthDiagnosis,
  SessionProgressType,
  SessionToolStatus,
} from './session-health-reducer.js';

interface SessionHealthProbeCacheEntry {
  checkedAtMs: number;
  result: ThreadProcessProbeResult;
}
export type {
  SessionEndOutcome,
  SessionHealthDiagnosis,
  SessionProgressType,
  SessionToolStatus,
} from './session-health-reducer.js';

export interface CreateSessionHealthRuntimeDeps {
  getStore(): Pick<BridgeStore, 'getSession' | 'listSessions' | 'updateSession'>;
  nowIso(): string;
  probeThreadProcess?(threadId: string): Promise<ThreadProcessProbeResult>;
}

export interface SessionHealthRuntime {
  recordInteractiveStart(sessionId: string, detail?: string): void;
  recordInteractiveProgress(sessionId: string, type: SessionProgressType, detail?: string): void;
  recordToolState(sessionId: string, toolId: string, toolName: string, status: SessionToolStatus): void;
  recordInteractiveEnd(sessionId: string, outcome: SessionEndOutcome, detail?: string): void;
  observeDesktopMirrorRecords(sessionId: string, threadId: string, records: DesktopMirrorRecord[]): void;
  reconcileSessionHealth(): void;
  diagnoseSessionHealth(sessionId: string): Promise<SessionHealthDiagnosis | null>;
  diagnoseAllActiveSessions(): Promise<SessionHealthDiagnosis[]>;
}

export function createSessionHealthRuntime(
  deps: CreateSessionHealthRuntimeDeps,
): SessionHealthRuntime {
  const lastProgressPersistAt = new Map<string, number>();
  const processProbeCache = new Map<string, SessionHealthProbeCacheEntry>();

  function updateSessionHealth(
    sessionId: string,
    updates: Partial<BridgeSession>,
    options?: { force?: boolean },
  ): void {
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const next: Partial<BridgeSession> = {};
    const typedNext = next as Record<keyof BridgeSession, BridgeSession[keyof BridgeSession] | undefined>;
    let changed = options?.force === true;

    for (const [key, value] of Object.entries(updates) as Array<[keyof BridgeSession, BridgeSession[keyof BridgeSession]]>) {
      if (session[key] !== value) {
        typedNext[key] = value;
        changed = true;
      }
    }

    if (!changed) return;
    store.updateSession(sessionId, next);
  }

  function maybePersistProgress(
    sessionId: string,
    updates: Partial<BridgeSession>,
    progressType: SessionProgressType,
  ): void {
    const nowMs = Date.now();
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const force = session.last_progress_type !== progressType
      || session.health_status !== updates.health_status
      || session.health_reason !== updates.health_reason
      || session.active_tools_json !== updates.active_tools_json
      || session.active_tool_name !== updates.active_tool_name
      || session.active_tool_started_at !== updates.active_tool_started_at;

    if (!force) {
      const lastPersistedAt = lastProgressPersistAt.get(sessionId) || 0;
      if (nowMs - lastPersistedAt < HEALTH_PROGRESS_PERSIST_THROTTLE_MS) {
        return;
      }
    }

    lastProgressPersistAt.set(sessionId, nowMs);
    updateSessionHealth(sessionId, updates);
  }

  function recordInteractiveStart(sessionId: string, detail?: string): void {
    const nowIso = deps.nowIso();
    lastProgressPersistAt.set(sessionId, Date.now());
    updateSessionHealth(sessionId, {
      health_status: 'running_active',
      health_reason: detail?.trim() || buildProgressReason('task_started'),
      last_progress_at: nowIso,
      last_progress_type: 'task_started',
      active_tools_json: undefined,
      active_tool_name: undefined,
      active_tool_started_at: undefined,
      last_tool_finished_at: undefined,
    });
  }

  function recordInteractiveProgress(sessionId: string, type: SessionProgressType, detail?: string): void {
    const nowIso = deps.nowIso();
    maybePersistProgress(sessionId, {
      health_status: type === 'permission_wait' ? 'waiting_tool' : 'running_active',
      health_reason: buildProgressReason(type, detail),
      last_progress_at: nowIso,
      last_progress_type: type,
    }, type);
  }

  function recordToolState(sessionId: string, toolId: string, toolName: string, status: SessionToolStatus): void {
    const nowIso = deps.nowIso();
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return;

    const activeTools = new Map(
      parseActiveToolsJson(session.active_tools_json).map((tool) => [tool.id, tool]),
    );

    if (status === 'running') {
      activeTools.set(toolId, {
        id: toolId,
        name: toolName || activeTools.get(toolId)?.name || 'tool',
        startedAt: activeTools.get(toolId)?.startedAt || nowIso,
      });
      const nextTools = Array.from(activeTools.values());
      const activeToolName = summarizeActiveTools(nextTools);
      updateSessionHealth(sessionId, {
        health_status: 'waiting_tool',
        health_reason: activeToolName ? `当前正在等待工具 ${activeToolName}。` : buildProgressReason('tool_running'),
        last_progress_at: nowIso,
        last_progress_type: 'tool_running',
        active_tools_json: serializeActiveTools(nextTools),
        active_tool_name: activeToolName || undefined,
        active_tool_started_at: getActiveToolStartedAt(nextTools) || undefined,
      });
      lastProgressPersistAt.set(sessionId, Date.now());
      return;
    }

    activeTools.delete(toolId);
    const progressType = status === 'error' ? 'tool_error' : 'tool_complete';
    const nextTools = Array.from(activeTools.values());
    const activeToolName = summarizeActiveTools(nextTools);
    updateSessionHealth(sessionId, {
      health_status: activeToolName ? 'waiting_tool' : 'running_active',
      health_reason: activeToolName
        ? `工具 ${toolName || 'tool'} ${status === 'error' ? '返回错误' : '执行完成'}，当前仍在等待工具 ${activeToolName}。`
        : toolName
          ? `工具 ${toolName} ${status === 'error' ? '返回错误' : '执行完成'}。`
          : buildProgressReason(progressType),
      last_progress_at: nowIso,
      last_progress_type: progressType,
      active_tools_json: serializeActiveTools(nextTools),
      active_tool_name: activeToolName || undefined,
      active_tool_started_at: getActiveToolStartedAt(nextTools) || undefined,
      last_tool_finished_at: nowIso,
    });
    lastProgressPersistAt.set(sessionId, Date.now());
  }

  function recordInteractiveEnd(sessionId: string, outcome: SessionEndOutcome, detail?: string): void {
    const nowIso = deps.nowIso();
    updateSessionHealth(sessionId, {
      health_status: buildEndStatus(outcome),
      health_reason: detail?.trim() || buildProgressReason(
        outcome === 'completed'
          ? 'task_completed'
          : outcome === 'aborted'
            ? 'task_aborted'
            : 'task_failed',
      ),
      last_progress_at: nowIso,
      last_progress_type: outcome === 'completed'
        ? 'task_completed'
        : outcome === 'aborted'
          ? 'task_aborted'
          : 'task_failed',
      active_tools_json: undefined,
      active_tool_name: undefined,
      active_tool_started_at: undefined,
      last_health_check_at: nowIso,
    }, { force: true });
    lastProgressPersistAt.set(sessionId, Date.now());
    processProbeCache.delete(sessionId);
  }

  function observeDesktopMirrorRecords(sessionId: string, _threadId: string, records: DesktopMirrorRecord[]): void {
    for (const record of records) {
      if (record.type === 'task_started') {
        recordInteractiveStart(sessionId, '检测到桌面线程开始执行。');
        continue;
      }
      if (record.type === 'task_complete') {
        recordInteractiveEnd(sessionId, 'completed', '检测到桌面线程已完成当前任务。');
        continue;
      }
      if (record.type === 'tool_started') {
        recordToolState(sessionId, record.toolId || record.signature, record.toolName || 'tool', 'running');
        continue;
      }
      if (record.type === 'tool_finished') {
        recordToolState(
          sessionId,
          record.toolId || record.signature,
          record.toolName || '',
          record.isError ? 'error' : 'complete',
        );
        continue;
      }
      if (record.type === 'message') {
        recordInteractiveProgress(
          sessionId,
          record.role === 'commentary' ? 'commentary' : 'message',
          record.role === 'commentary'
            ? '检测到桌面线程新的执行进展说明。'
            : '检测到桌面线程新的消息输出。',
        );
      }
    }
  }

  function reconcileSessionHealth(): void {
    const nowMs = Date.now();
    const store = deps.getStore();
    for (const session of store.listSessions()) {
      if (!shouldTrackSession(session)) continue;
      const diagnosis = computeBaseDiagnosis(session, nowMs);
      updateSessionHealth(session.id, {
        health_status: diagnosis.healthStatus,
        health_reason: diagnosis.healthReason,
      });
    }
  }

  async function loadProcessProbe(session: BridgeSession): Promise<ThreadProcessProbeResult | null> {
    const threadId = session.sdk_session_id?.trim();
    if (!threadId || !deps.probeThreadProcess) return null;

    const cached = processProbeCache.get(session.id);
    const nowMs = Date.now();
    if (cached && nowMs - cached.checkedAtMs < HEALTH_PROCESS_PROBE_CACHE_MS) {
      return cached.result;
    }

    const result = await deps.probeThreadProcess(threadId);
    processProbeCache.set(session.id, {
      checkedAtMs: nowMs,
      result,
    });
    return result;
  }

  async function diagnoseSessionHealth(sessionId: string): Promise<SessionHealthDiagnosis | null> {
    const store = deps.getStore();
    const session = store.getSession(sessionId);
    if (!session) return null;

    const base = computeBaseDiagnosis(session, Date.now());
    const processProbe = await loadProcessProbe(session);
    const diagnosis = applyProcessProbeDiagnosis(base, processProbe);

    updateSessionHealth(sessionId, {
      health_status: diagnosis.healthStatus,
      health_reason: diagnosis.healthReason,
      last_health_check_at: deps.nowIso(),
    });

    return diagnosis;
  }

  async function diagnoseAllActiveSessions(): Promise<SessionHealthDiagnosis[]> {
    const store = deps.getStore();
    const activeSessions = store.listSessions().filter((session) => shouldTrackSession(session));
    const diagnoses = await Promise.all(activeSessions.map((session) => diagnoseSessionHealth(session.id)));
    return diagnoses.filter((item): item is SessionHealthDiagnosis => Boolean(item));
  }

  return {
    recordInteractiveStart,
    recordInteractiveProgress,
    recordToolState,
    recordInteractiveEnd,
    observeDesktopMirrorRecords,
    reconcileSessionHealth,
    diagnoseSessionHealth,
    diagnoseAllActiveSessions,
  };
}
