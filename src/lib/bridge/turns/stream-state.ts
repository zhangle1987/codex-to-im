export interface StreamState {
  startedAtMs: number;
  lastActivityAtMs: number;
  lastContentResponseAtMs: number | null;
  statusNote: string | null;
  lastStatusText: string | null;
  lastStatusAtMs: number;
}

export interface StreamStatusTimingConfig {
  idleStartMs: number;
  heartbeatMs: number;
}

export function createStreamState(startedAtMs: number): StreamState {
  const safeStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  return {
    startedAtMs: safeStartedAtMs,
    lastActivityAtMs: safeStartedAtMs,
    lastContentResponseAtMs: null,
    statusNote: null,
    lastStatusText: null,
    lastStatusAtMs: 0,
  };
}

export function recordStreamActivity(state: StreamState, nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  state.lastActivityAtMs = Math.max(state.lastActivityAtMs, nowMs);
}

export function recordStreamContentResponse(state: StreamState, nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  recordStreamActivity(state, nowMs);
  state.lastContentResponseAtMs = nowMs;
}

export function updateStreamStatusNote(
  state: StreamState,
  note: string | null | undefined,
  nowMs: number,
): void {
  state.statusNote = (note || '').trim() || null;
  if (state.statusNote) {
    recordStreamActivity(state, nowMs);
  }
}

export function formatRuntimeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
  return parts.join('');
}

export function formatStreamRuntimeStatus(
  elapsedMs: number,
  lastContentResponseAgeMs?: number | null,
  statusNote?: string | null,
): string {
  const parts = [elapsedMs < 1000 ? '处理中' : `已运行 ${formatRuntimeDuration(elapsedMs)}`];
  if (typeof lastContentResponseAgeMs === 'number' && lastContentResponseAgeMs >= 0) {
    parts.push(`上次响应距今 ${formatRuntimeDuration(lastContentResponseAgeMs)}`);
  }
  const runtimeText = parts.join('，');
  const note = (statusNote || '').trim();
  return note ? `当前步骤：${note}\n${runtimeText}` : runtimeText;
}

export function getStreamLastContentResponseAgeMs(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs'>,
  nowMs: number,
  options: { fallbackToStart?: boolean } = {},
): number | null {
  const fallbackToStart = options.fallbackToStart !== false;
  const base = state.lastContentResponseAtMs ?? (fallbackToStart ? state.startedAtMs : null);
  if (base == null || !Number.isFinite(base) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - base);
}

export function shouldShowStreamLastContentResponseAge(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs'>,
  nowMs: number,
  config: StreamStatusTimingConfig,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs < Math.max(0, config.idleStartMs)) return false;
  const ageMs = getStreamLastContentResponseAgeMs(state, nowMs);
  return ageMs != null && ageMs >= Math.max(1_000, config.heartbeatMs);
}

export function buildStreamRuntimeStatus(
  state: Pick<StreamState, 'startedAtMs' | 'lastContentResponseAtMs' | 'statusNote'>,
  nowMs: number,
  options: {
    includeLastContentResponseAge?: boolean;
  } = {},
): string {
  return formatStreamRuntimeStatus(
    Math.max(0, nowMs - state.startedAtMs),
    options.includeLastContentResponseAge
      ? getStreamLastContentResponseAgeMs(state, nowMs)
      : null,
    state.statusNote,
  );
}
