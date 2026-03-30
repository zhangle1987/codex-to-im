import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeferredGlobalNpmUninstallLaunch } from '../service-manager.js';

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
