import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _testOnly, buildDeferredGlobalNpmUninstallLaunch } from '../service-manager.js';
import { tryAcquireBridgeInstanceLock } from '../bridge-instance-lock.js';

describe('buildDeferredGlobalNpmUninstallLaunch', () => {
  it('uses npm.cmd on Windows launchers', () => {
    const launch = buildDeferredGlobalNpmUninstallLaunch({
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      logPath: 'C:\\Users\\tester\\.codex-to-im\\runtime\\npm-uninstall.log',
      cwd: 'C:\\Users\\tester',
    });

    assert.equal(launch.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(launch.npmCommand, 'npm.cmd');
    assert.equal(launch.args[0], '-e');
    assert.match(launch.args[1], /"npm\.cmd"/);
    assert.match(launch.args[1], /"C:\\\\Users\\\\tester"/);
    assert.match(launch.args[1], /"C:\\\\Users\\\\tester\\\\\.codex-to-im\\\\runtime\\\\npm-uninstall\.log"/);
    assert.match(launch.args[1], /\['uninstall', '-g', "codex-to-im"\]/);
  });

  it('uses npm on non-Windows launchers', () => {
    const launch = buildDeferredGlobalNpmUninstallLaunch({
      platform: 'linux',
      nodePath: '/usr/bin/node',
      logPath: '/tmp/codex-to-im-uninstall.log',
      cwd: '/tmp',
      delayMs: 2500,
    });

    assert.equal(launch.command, '/usr/bin/node');
    assert.equal(launch.npmCommand, 'npm');
    assert.equal(launch.delayMs, 2500);
    assert.equal(launch.args[0], '-e');
    assert.match(launch.args[1], /"npm"/);
    assert.match(launch.args[1], /"\/tmp"/);
    assert.match(launch.args[1], /"\/tmp\/codex-to-im-uninstall\.log"/);
    assert.match(launch.args[1], /const delayMs = 2500;/);
  });
});

describe('service-manager bridge pid resolution', () => {
  it('falls back to a live status pid when bridge.pid is stale', () => {
    const pid = _testOnly.resolveTrackedBridgePid(24020, 10516, undefined, (candidate) => candidate === 10516);
    assert.equal(pid, 10516);
  });

  it('prefers a live bridge.pid over a live status pid', () => {
    const pid = _testOnly.resolveTrackedBridgePid(11420, 10516, undefined, () => true);
    assert.equal(pid, 11420);
  });

  it('deduplicates tracked bridge pids', () => {
    assert.deepEqual(_testOnly.collectTrackedBridgePids(11420, 11420, 11420), [11420]);
    assert.deepEqual(_testOnly.collectTrackedBridgePids(11420, 10516, 10516), [11420, 10516]);
  });

  it('falls back to a live instance lock pid when bridge.pid and status pid are stale', () => {
    const pid = _testOnly.resolveTrackedBridgePid(24020, 10516, 32001, (candidate) => candidate === 32001);
    assert.equal(pid, 32001);
  });
});

describe('service-manager bridge startup failure messaging', () => {
  it('reports a missing channel configuration before spawning the bridge', () => {
    assert.equal(
      _testOnly.describeBridgeStartupPreflightFailure([]),
      '未配置任何通道实例。请先在 Web 控制台创建并保存至少一个飞书或微信通道，然后再启动桥接服务。',
    );
  });

  it('reports when all configured channels are disabled', () => {
    assert.equal(
      _testOnly.describeBridgeStartupPreflightFailure([
        {
          id: 'feishu-default',
          alias: '开开1号',
          provider: 'feishu',
          enabled: false,
          createdAt: '2026-04-07T01:00:00.000Z',
          updatedAt: '2026-04-07T01:00:00.000Z',
          config: {},
        },
      ]),
      '当前所有通道实例都已禁用。请先启用至少一个通道实例，然后再启动桥接服务。',
    );
  });

  it('falls back to enabled channel labels when the bridge still fails to activate', () => {
    assert.equal(
      _testOnly.describeBridgeActivationFailure(
        { running: false },
        [
          {
            id: 'feishu-default',
            alias: '开开1号',
            provider: 'feishu',
            enabled: true,
            createdAt: '2026-04-07T01:00:00.000Z',
            updatedAt: '2026-04-07T01:00:00.000Z',
            config: {},
          },
          {
            id: 'weixin-default',
            alias: '微信一号',
            provider: 'weixin',
            enabled: true,
            createdAt: '2026-04-07T01:00:00.000Z',
            updatedAt: '2026-04-07T01:00:00.000Z',
            config: {},
          },
        ],
      ),
      '没有任何通道适配器启动成功。请检查通道配置、凭据和日志。当前已启用通道：开开1号、微信一号',
    );
  });

  it('prefers a daemon-provided lastExitReason when available', () => {
    assert.equal(
      _testOnly.describeBridgeActivationFailure(
        { running: false, lastExitReason: 'fatal: boom' },
        [],
      ),
      'fatal: boom',
    );
  });
});

describe('service-manager bridge startup locking', () => {
  it('acquires a fresh startup lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');

    const result = _testOnly.tryAcquireBridgeStartLock({
      filePath: lockPath,
      ownerPid: 32001,
      nowMs: Date.parse('2026-04-10T10:00:00.000Z'),
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    });
  });

  it('blocks on a live startup lock holder', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    }), 'utf-8');

    const result = _testOnly.tryAcquireBridgeStartLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-10T10:00:05.000Z'),
      isAlive: (pid) => pid === 32001,
    });

    assert.deepEqual(result, { acquired: false, holderPid: 32001 });
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    });
  });

  it('replaces a stale startup lock when the holder is gone', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    }), 'utf-8');

    const result = _testOnly.tryAcquireBridgeStartLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-10T10:00:10.000Z'),
      isAlive: () => false,
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32002,
      createdAt: '2026-04-10T10:00:10.000Z',
    });
  });

  it('does not release another process startup lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-lock-'));
    const lockPath = path.join(tempDir, 'bridge.start.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    }), 'utf-8');

    _testOnly.releaseBridgeStartLock(lockPath, 32002);

    assert.equal(fs.existsSync(lockPath), true);
    assert.deepEqual(_testOnly.readBridgeStartLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-10T10:00:00.000Z',
    });
  });
});

describe('bridge instance locking', () => {
  it('blocks a second daemon while the first holder is alive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-instance-lock-'));
    const lockPath = path.join(tempDir, 'bridge.instance.lock');

    const first = tryAcquireBridgeInstanceLock({
      filePath: lockPath,
      ownerPid: 32001,
      nowMs: Date.parse('2026-04-24T12:00:00.000Z'),
    });
    const second = tryAcquireBridgeInstanceLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-24T12:00:10.000Z'),
      isAlive: (pid) => pid === 32001,
    });

    assert.equal(first.acquired, true);
    assert.deepEqual(second, { acquired: false, holderPid: 32001 });
    assert.deepEqual(_testOnly.readBridgeInstanceLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    });
  });

  it('replaces a stale instance lock when the holder is gone', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-instance-lock-'));
    const lockPath = path.join(tempDir, 'bridge.instance.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    }), 'utf-8');

    const result = tryAcquireBridgeInstanceLock({
      filePath: lockPath,
      ownerPid: 32002,
      nowMs: Date.parse('2026-04-24T12:00:10.000Z'),
      isAlive: () => false,
    });

    assert.equal(result.acquired, true);
    assert.deepEqual(_testOnly.readBridgeInstanceLock(lockPath), {
      pid: 32002,
      createdAt: '2026-04-24T12:00:10.000Z',
    });
  });

  it('does not clear a live instance lock owned by another process', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-instance-lock-'));
    const lockPath = path.join(tempDir, 'bridge.instance.lock');
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    }), 'utf-8');

    _testOnly.clearStaleBridgeInstanceLock(lockPath, (pid) => pid === 32001);

    assert.equal(fs.existsSync(lockPath), true);
    assert.deepEqual(_testOnly.readBridgeInstanceLock(lockPath), {
      pid: 32001,
      createdAt: '2026-04-24T12:00:00.000Z',
    });
  });
});
