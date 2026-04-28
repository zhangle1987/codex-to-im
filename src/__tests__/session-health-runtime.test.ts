import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { createSessionHealthRuntime } from '../lib/bridge/session-health-runtime.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

describe('session-health-runtime', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('marks a long-running missing tool process as suspected_detached', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Detached', 'test-model', undefined, 'D:\\workspace\\health-detached', 'code');
    store.updateSession(session.id, { runtime_status: 'running' });

    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => new Date().toISOString(),
      probeThreadProcess: async (threadId) => ({
        threadId,
        status: 'not_found',
        supported: true,
        checkedAt: '2026-04-13T12:30:00.000Z',
      }),
    });

    runtime.recordInteractiveStart(session.id);
    runtime.recordToolState(session.id, 'call-1', 'shell_command', 'running');
    store.updateSession(session.id, {
      sdk_session_id: '019d861c-0e5b-7792-9303-2aa082a28093',
      last_progress_at: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
      active_tool_started_at: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
    });

    const diagnosis = await runtime.diagnoseSessionHealth(session.id);
    assert.ok(diagnosis);
    assert.equal(diagnosis?.healthStatus, 'suspected_detached');
    assert.equal(diagnosis?.processProbe?.status, 'not_found');
  });

  it('does not persist session metadata when diagnosing session health', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Read Only', 'test-model', undefined, 'D:\\workspace\\health-readonly', 'code');
    const before = store.getSession(session.id);
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:05:00.000Z',
    });

    const diagnosis = await runtime.diagnoseSessionHealth(session.id);
    assert.ok(diagnosis);
    assert.equal(diagnosis?.checkedAt, null);

    const refreshed = store.getSession(session.id);
    assert.deepEqual(refreshed, before);
  });

  it('does not touch updated_at when reconciling derived health state', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Reconcile Read Only', 'test-model', undefined, 'D:\\workspace\\health-reconcile', 'code');
    store.updateSession(session.id, {
      runtime_status: 'running',
      last_progress_at: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
      last_progress_type: 'message',
    }, { touch: false });
    const originalUpdatedAt = store.getSession(session.id)?.updated_at;
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:05:00.000Z',
    });

    runtime.reconcileSessionHealth();

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.health_status, 'suspected_stall');
    assert.equal(refreshed?.updated_at, originalUpdatedAt);
  });

  it('keeps a long-running live thread in slow_observed instead of detached', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Alive', 'test-model', undefined, 'D:\\workspace\\health-alive', 'code');
    store.updateSession(session.id, { runtime_status: 'running' });

    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => new Date().toISOString(),
      probeThreadProcess: async (threadId) => ({
        threadId,
        status: 'alive',
        supported: true,
        checkedAt: '2026-04-13T12:30:00.000Z',
        pid: 31340,
      }),
    });

    runtime.recordInteractiveStart(session.id);
    store.updateSession(session.id, {
      sdk_session_id: '019d861c-0e5b-7792-9303-2aa082a28093',
      last_progress_at: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
      last_progress_type: 'message',
    });

    const diagnosis = await runtime.diagnoseSessionHealth(session.id);
    assert.ok(diagnosis);
    assert.equal(diagnosis?.healthStatus, 'slow_observed');
    assert.equal(diagnosis?.processProbe?.pid, 31340);
  });

  it('marks a session as suspected_stream_ui_stall when progress continues but stream UI stops refreshing', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Stream UI Stall', 'test-model', undefined, 'D:\\workspace\\health-stream-ui', 'code');
    store.updateSession(session.id, { runtime_status: 'running' });

    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => new Date().toISOString(),
    });

    runtime.recordInteractiveStart(session.id);
    runtime.recordStructuredStreamUi(session.id, {
      active: true,
      lastAttemptAt: Date.now() - (3 * 60 * 1000),
      lastUpdateAt: Date.now() - (3 * 60 * 1000),
      lastErrorAt: Date.now() - (2 * 60 * 1000),
      lastError: 'timeout after 15000ms',
      consecutiveFailures: 2,
      flushInFlight: false,
    });
    store.updateSession(session.id, {
      last_progress_at: new Date().toISOString(),
      last_progress_type: 'tool_complete',
    });

    const diagnosis = await runtime.diagnoseSessionHealth(session.id);
    assert.ok(diagnosis);
    assert.equal(diagnosis?.healthStatus, 'suspected_stream_ui_stall');
    assert.match(diagnosis?.healthReason || '', /流式 UI/);
  });

  it('clears stream UI runtime fields when the session reaches a terminal state', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Stream UI End', 'test-model', undefined, 'D:\\workspace\\health-stream-ui-end', 'code');
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:30:00.000Z',
    });

    runtime.recordInteractiveStart(session.id);
    runtime.recordStructuredStreamUi(session.id, {
      active: true,
      lastAttemptAt: Date.parse('2026-04-13T12:29:50.000Z'),
      lastUpdateAt: Date.parse('2026-04-13T12:29:51.000Z'),
      lastErrorAt: Date.parse('2026-04-13T12:29:52.000Z'),
      lastError: 'timeout after 15000ms',
      consecutiveFailures: 2,
      flushInFlight: true,
      flushInFlightSince: Date.parse('2026-04-13T12:29:49.000Z'),
    });

    runtime.recordInteractiveEnd(session.id, 'completed');

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.health_status, 'completed');
    assert.equal(refreshed?.stream_ui_flush_started_at, undefined);
    assert.equal(refreshed?.last_stream_ui_attempt_at, undefined);
    assert.equal(refreshed?.last_stream_ui_update_at, undefined);
    assert.equal(refreshed?.last_stream_ui_error_at, undefined);
    assert.equal(refreshed?.last_stream_ui_error, undefined);
    assert.equal(refreshed?.stream_ui_consecutive_failures, undefined);
  });

  it('updates completion state from mirrored desktop records', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Mirror', 'test-model', undefined, 'D:\\workspace\\health-mirror', 'code');
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:30:00.000Z',
    });

    runtime.observeDesktopMirrorRecords(session.id, 'thread-1', [
      {
        signature: 'task-start',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-13T12:00:00.000Z',
      },
      {
        signature: 'tool-start',
        type: 'tool_started',
        content: '',
        timestamp: '2026-04-13T12:01:00.000Z',
        toolId: 'call-1',
        toolName: 'shell_command',
      },
      {
        signature: 'tool-finish',
        type: 'tool_finished',
        content: 'Exit code: 0',
        timestamp: '2026-04-13T12:02:00.000Z',
        toolId: 'call-1',
      },
      {
        signature: 'task-complete',
        type: 'task_complete',
        content: 'done',
        timestamp: '2026-04-13T12:03:00.000Z',
      },
    ]);

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.health_status, 'completed');
    assert.match(refreshed?.health_reason || '', /桌面线程已完成/);
  });

  it('treats mirror reasoning and plan updates as active progress', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Mirror Progress', 'test-model', undefined, 'D:\\workspace\\health-mirror-progress', 'code');
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:30:00.000Z',
    });

    runtime.observeDesktopMirrorRecords(session.id, 'thread-1', [
      {
        signature: 'task-start',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-13T12:00:00.000Z',
      },
      {
        signature: 'reasoning-1',
        type: 'reasoning',
        content: '先检查镜像状态',
        timestamp: '2026-04-13T12:01:00.000Z',
      },
      {
        signature: 'plan-1',
        type: 'plan_update',
        content: '',
        timestamp: '2026-04-13T12:02:00.000Z',
        tasks: [
          { text: '检查镜像状态', status: 'completed' },
          { text: '补交界测试', status: 'in_progress' },
          { text: '回归验证', status: 'pending' },
        ],
      },
    ]);

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.health_status, 'running_active');
    assert.equal(refreshed?.last_progress_type, 'plan_update');
    assert.match(refreshed?.health_reason || '', /任务计划/);
    assert.match(refreshed?.health_reason || '', /执行中 1 项/);
  });

  it('updates aborted state from mirrored desktop records', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Mirror Abort', 'test-model', undefined, 'D:\\workspace\\health-mirror-abort', 'code');
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:30:00.000Z',
    });

    runtime.observeDesktopMirrorRecords(session.id, 'thread-1', [
      {
        signature: 'task-start',
        type: 'task_started',
        content: '',
        timestamp: '2026-04-13T12:00:00.000Z',
      },
      {
        signature: 'task-abort',
        type: 'task_aborted',
        content: 'user interrupted',
        timestamp: '2026-04-13T12:01:00.000Z',
      },
    ]);

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.health_status, 'aborted');
    assert.equal(refreshed?.last_progress_type, 'task_aborted');
    assert.match(refreshed?.health_reason || '', /已停止/);
  });

  it('keeps waiting_tool while another active tool is still running', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('Health Multi Tool', 'test-model', undefined, 'D:\\workspace\\health-multi', 'code');
    const runtime = createSessionHealthRuntime({
      getStore: () => store,
      nowIso: () => '2026-04-13T12:30:00.000Z',
    });

    runtime.recordInteractiveStart(session.id);
    runtime.recordToolState(session.id, 'call-1', 'shell_command', 'running');
    runtime.recordToolState(session.id, 'call-2', 'apply_patch', 'running');
    runtime.recordToolState(session.id, 'call-1', 'shell_command', 'complete');

    const refreshed = store.getSession(session.id);
    assert.equal(refreshed?.health_status, 'waiting_tool');
    assert.equal(refreshed?.active_tool_name, 'apply_patch');
    assert.match(refreshed?.health_reason || '', /仍在等待工具 apply_patch/);

    runtime.recordToolState(session.id, 'call-2', 'apply_patch', 'complete');
    const settled = store.getSession(session.id);
    assert.equal(settled?.health_status, 'running_active');
    assert.equal(settled?.active_tool_name, undefined);
    assert.equal(settled?.active_tools_json, undefined);
  });
});
