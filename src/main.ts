/**
 * Daemon entry point for codex-to-im.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from './lib/bridge/context.js';
import * as bridgeManager from './lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import './lib/bridge/adapters/index.js';

import type { LLMProvider } from './lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import { JsonFileStore } from './store.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { releaseBridgeInstanceLock, tryAcquireBridgeInstanceLock } from './bridge-instance-lock.js';
import {
  writeRuntimeStatus,
  type RuntimeStatusInfo,
  type RuntimeStatusWriteOptions,
} from './runtime-status.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const runId = crypto.randomUUID();

async function resolveProvider(pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const { CodexProvider } = await import('./codex-provider.js');
  return new CodexProvider(pendingPerms, {
    transport: process.env.CTI_CODEX_TRANSPORT || 'auto',
  });
}

function writeStatus(info: RuntimeStatusInfo, options: RuntimeStatusWriteOptions = {}): boolean {
  return writeRuntimeStatus(STATUS_FILE, info, options);
}

function getRunningChannels(): string[] {
  return bridgeManager.getStatus().adapters.map((adapter) => adapter.channelType).sort();
}

function getAdapterStatuses(): ReturnType<typeof bridgeManager.getStatus>['adapters'] {
  return bridgeManager.getStatus().adapters;
}

async function main(): Promise<void> {
  const lockState = tryAcquireBridgeInstanceLock();
  if (!lockState.acquired) {
    const holderPid = lockState.holderPid;
    console.log(
      `[codex-to-im] Another bridge daemon is already running${holderPid ? ` (PID: ${holderPid})` : ''}. Exiting duplicate launcher.`,
    );
    process.exit(0);
  }

  let instanceLockHeld = true;
  const releaseInstanceLock = () => {
    if (!instanceLockHeld) return;
    releaseBridgeInstanceLock(undefined, process.pid);
    instanceLockHeld = false;
  };

  writeStatus({
    running: false,
    pid: process.pid,
    runId,
    channels: [],
    adapters: [],
  }, { expectedRunId: runId, allowRunIdTakeover: true });

  const config = loadConfig();
  setupLogger();
  console.log(`[codex-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings, { dynamicSettings: true });
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(pendingPerms);
  console.log(`[codex-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        const channels = getRunningChannels();
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels,
          adapters: getAdapterStatuses(),
        }, { expectedRunId: runId });
        console.log(`[codex-to-im] Bridge started (PID: ${process.pid}, channels: ${channels.join(', ')})`);
      },
      onBridgeAdaptersChanged: (channels) => {
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          channels,
          adapters: getAdapterStatuses(),
        }, { expectedRunId: runId });
        console.log(`[codex-to-im] Active channels updated: ${channels.join(', ') || 'none'}`);
      },
      onBridgeStop: () => {
        releaseInstanceLock();
        writeStatus({ running: false, channels: [], adapters: [] }, { expectedRunId: runId });
        console.log('[codex-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[codex-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    try {
      await bridgeManager.stop();
    } catch (error) {
      console.error('[codex-to-im] Graceful bridge stop failed:', error instanceof Error ? error.stack || error.message : error);
    } finally {
      try {
        await llm.dispose?.();
      } catch (error) {
        console.error('[codex-to-im] Failed to stop Codex provider:', error instanceof Error ? error.stack || error.message : error);
      }
      releaseInstanceLock();
      try {
        writeStatus({ running: false, lastExitReason: reason }, { expectedRunId: runId });
      } catch (error) {
        console.error('[codex-to-im] Failed to write final runtime status:', error instanceof Error ? error.message : error);
      }
      process.exit(exitCode);
    }
  };

  process.on('SIGTERM', () => { void shutdown('signal: SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('signal: SIGINT'); });
  process.on('SIGHUP', () => { void shutdown('signal: SIGHUP'); });

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[codex-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({
      running: true,
      pid: process.pid,
      runId,
      channels: getRunningChannels(),
      adapters: getAdapterStatuses(),
      lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    }, { expectedRunId: runId });
  });
  process.on('uncaughtException', (err) => {
    console.error('[codex-to-im] uncaughtException:', err.stack || err.message);
    void shutdown(`uncaughtException: ${err.message}`, 1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[codex-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    releaseInstanceLock();
    console.log(`[codex-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[codex-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  releaseBridgeInstanceLock(undefined, process.pid);
  try {
    writeStatus(
      { running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` },
      { expectedRunId: runId },
    );
  } catch { /* ignore */ }
  process.exit(1);
});
