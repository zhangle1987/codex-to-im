#!/usr/bin/env node

import {
  ensureUiServerRunning,
  getCurrentUiServerUrl,
  getUiServerStatus,
  getUiServerUrl,
  openBrowser,
} from './service-manager.js';

async function main(): Promise<void> {
  const command = process.argv[2] || 'open';

  switch (command) {
    case 'open': {
      const status = await ensureUiServerRunning();
      const url = getUiServerUrl(status.port);
      openBrowser(url);
      process.stdout.write(`Codex to IM is available at ${url}\n`);
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

    case 'share-feishu': {
      const status = await ensureUiServerRunning();
      const url = `${getUiServerUrl(status.port)}/#desktop`;
      openBrowser(url);
      process.stdout.write(`Opened Feishu handoff entry at ${url}\n`);
      return;
    }

    default:
      process.stdout.write('Usage: codex-to-im [open|url|share-feishu]\n');
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
