#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process';

import {
  ensureUiServerRunning,
  ensureWindowsAdminSession,
  getBridgeAutostartStatus,
  getBridgeStatus,
  getCurrentUiServerUrl,
  getUiServerStatus,
  getUiServerUrl,
  installBridgeAutostart,
  uninstallBridgeAutostart,
  openBrowser,
  startBridge,
  stopBridge,
  stopUiServer,
  uninstallCodexToImPackage,
} from './service-manager.js';

async function promptHidden(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('当前终端不支持隐藏输入，请在可交互终端中执行。');
  }

  output.write(question);
  input.resume();
  input.setEncoding('utf8');
  input.setRawMode?.(true);

  return await new Promise<string>((resolve, reject) => {
    let value = '';

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('已取消。'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0008' || ch === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
    };

    input.on('data', onData);
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'open';

  switch (command) {
    case 'start': {
      const status = await startBridge();
      process.stdout.write(`Bridge started. PID: ${status.pid || '-'}\n`);
      return;
    }

    case 'open': {
      const status = await ensureUiServerRunning();
      const url = getUiServerUrl(status.port);
      openBrowser(url);
      try {
        await startBridge();
        process.stdout.write(`Codex to IM is available at ${url}\n`);
      } catch (error) {
        process.stdout.write(`Codex to IM UI is available at ${url}\n`);
        process.stderr.write(
          `Bridge failed to start. Open the UI and check logs/config first: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
      return;
    }

    case 'url': {
      const status = getUiServerStatus();
      const url = getCurrentUiServerUrl();
      if (status.running && url) {
        process.stdout.write(`${url}\n`);
        return;
      }
      if (url) {
        process.stdout.write(`UI server is not running. Last known URL: ${url}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write('UI server is not running and no known URL is available.\n');
      process.exitCode = 1;
      return;
    }

    case 'stop': {
      const ui = await stopUiServer();
      const bridge = await stopBridge();
      process.stdout.write(
        `Stopped services. UI running=${ui.running ? 'yes' : 'no'}, Bridge running=${bridge.running ? 'yes' : 'no'}\n`
      );
      return;
    }

    case 'uninstall': {
      const result = await uninstallCodexToImPackage();
      process.stdout.write(
        [
          `Stopped services. UI running=${result.ui.running ? 'yes' : 'no'}, Bridge running=${result.bridge.running ? 'yes' : 'no'}`,
          result.autostart.installed ? `Bridge autostart still installed: ${result.autostart.taskName}` : 'Bridge autostart removed.',
          `Global npm uninstall scheduled via ${result.npmCommand}.`,
          `Log: ${result.logPath}`,
          '当前命令退出后，后台会继续执行全局卸载。',
        ].join('\n') + '\n',
      );
      return;
    }

    case 'status': {
      const ui = getUiServerStatus();
      const bridge = getBridgeStatus();
      const url = getCurrentUiServerUrl();
      const autostart = await getBridgeAutostartStatus();
      process.stdout.write(
        [
          `UI: ${ui.running ? 'running' : 'stopped'}${url ? ` (${url})` : ''}`,
          `Bridge: ${bridge.running ? 'running' : 'stopped'}`,
          `Bridge Autostart: ${autostart.installed ? (autostart.enabled ? 'enabled' : 'disabled') : 'not installed'}`,
        ].join('\n') + '\n'
      );
      return;
    }

    case 'autostart': {
      const subcommand = process.argv[3] || 'status';
      switch (subcommand) {
        case 'status': {
          const status = await getBridgeAutostartStatus();
          process.stdout.write(
            [
              `Supported: ${status.supported ? 'yes' : 'no'}`,
              `Installed: ${status.installed ? 'yes' : 'no'}`,
              `Enabled: ${status.enabled ? 'yes' : 'no'}`,
              `Mode: ${status.mode}`,
              `Task: ${status.taskName}`,
              status.runAsUser ? `Run As: ${status.runAsUser}` : undefined,
              status.state ? `State: ${status.state}` : undefined,
              status.error ? `Error: ${status.error}` : undefined,
            ].filter(Boolean).join('\n') + '\n',
          );
          return;
        }
        case 'install': {
          await ensureWindowsAdminSession();
          const password = await promptHidden('请输入当前 Windows 登录密码（用于创建开机启动任务）: ');
          const status = await installBridgeAutostart(password);
          process.stdout.write(`Bridge autostart installed. Task: ${status.taskName}\n`);
          return;
        }
        case 'uninstall': {
          const status = await uninstallBridgeAutostart();
          process.stdout.write(
            status.installed
              ? `Bridge autostart task still exists: ${status.taskName}\n`
              : 'Bridge autostart removed.\n',
          );
          return;
        }
        default:
          process.stdout.write('Usage: codex-to-im autostart [status|install|uninstall]\n');
          return;
      }
    }

    default:
      process.stdout.write('Usage: codex-to-im [start|open|url|stop|status|autostart|uninstall]\n');
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
