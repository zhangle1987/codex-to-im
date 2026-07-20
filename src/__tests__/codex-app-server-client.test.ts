import './test-setup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AppServerPreTurnError,
  AppServerTurnStartUncertainError,
  CodexAppServerClient,
  type CodexAppServerTurnParams,
} from '../codex-app-server-client.js';
import { PendingPermissions } from '../permission-gateway.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeAppServer(
  extraHandler: string,
  options: { respondToResume?: boolean } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-appserver-test-'));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, 'server.cjs');
  fs.writeFileSync(scriptPath, `
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let threadStartCount = 0;
let threadResumeCount = 0;
let threadUnsubscribeCount = 0;
let turnCount = 0;
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake', codexHome: '.', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (message.method === 'thread/start') {
    threadStartCount += 1;
    send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    return;
  }
  if (message.method === 'thread/resume') {
    threadResumeCount += 1;
    ${options.respondToResume === false
      ? ''
      : "send({ id: message.id, result: { thread: { id: message.params.threadId } } });"}
    return;
  }
  if (message.method === 'thread/unsubscribe') {
    threadUnsubscribeCount += 1;
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    return;
  }
  ${extraHandler}
});
`, 'utf8');
  return scriptPath;
}

async function collectEvents(client: CodexAppServerClient): Promise<unknown[]> {
  return collectTurnEvents(client, { prompt: 'hello' });
}

async function collectTurnEvents(
  client: CodexAppServerClient,
  params: CodexAppServerTurnParams,
): Promise<unknown[]> {
  const turn = await client.startTurn(params);
  const events: unknown[] = [];
  for await (const event of turn.events) events.push(event);
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms`);
}

describe('CodexAppServerClient', () => {
  it('runs a turn over the app-server JSONL protocol', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => {
          send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'hello' } });
          send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'hello' } } });
          send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3 } } } });
          send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
        }, 5);
        return;
      }
    `);
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 5_000,
    });

    try {
      const events = await collectEvents(client) as Array<{ type?: string; delta?: string }>;
      assert.equal(events[0]?.type, 'agent_message.delta');
      assert.equal(events[0]?.delta, 'hello');
      assert.ok(events.some((event) => event.type === 'usage.updated'));
      assert.equal(events.at(-1)?.type, 'turn.completed');
    } finally {
      await client.close();
    }
  });

  it('routes approval requests through PendingPermissions', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'echo ok' } }), 5);
        return;
      }
      if (message.id === 'approval-1' && !message.method) {
        if (message.result?.decision !== 'accept') process.exit(9);
        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
      }
    `);
    const pending = new PendingPermissions();
    const client = new CodexAppServerClient(pending, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 5_000,
    });

    try {
      const turn = await client.startTurn({ prompt: 'hello' });
      const events: Array<{ type: string; requestId?: string }> = [];
      for await (const event of turn.events) {
        events.push(event as { type: string; requestId?: string });
        if (event.type === 'permission.request') {
          assert.ok(pending.resolve(event.requestId, { behavior: 'allow' }));
        }
      }
      assert.ok(events.some((event) => event.type === 'permission.request'));
      assert.equal(events.at(-1)?.type, 'turn.completed');
    } finally {
      pending.denyAll();
      await client.close();
    }
  });

  it('does not classify a dispatched turn/start timeout as safe for SDK fallback', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        return;
      }
    `);
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 1_000,
    });

    try {
      await assert.rejects(
        client.startTurn({ prompt: 'must run at most once' }),
        (error: unknown) => {
          assert.ok(error instanceof AppServerTurnStartUncertainError);
          assert.equal(error instanceof AppServerPreTurnError, false);
          return true;
        },
      );
      await waitFor(() => client.getOwnedProcessIds().length === 0);
    } finally {
      await client.close();
    }
  });

  it('releases an ambiguously resumed thread before reporting a safe pre-turn fallback', async () => {
    const scriptPath = createFakeAppServer('', { respondToResume: false });
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 1_000,
    });

    try {
      await assert.rejects(
        client.startTurn({ savedThreadId: 'persisted-thread', prompt: 'resume safely' }),
        (error: unknown) => {
          assert.ok(error instanceof AppServerPreTurnError);
          assert.equal(error instanceof AppServerTurnStartUncertainError, false);
          return true;
        },
      );
      assert.deepEqual(client.getOwnedProcessIds(), []);
    } finally {
      await client.close();
    }
  });

  it('starts another turn directly while the thread remains subscribed', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        const turnId = 'turn-' + (++turnCount);
        send({ id: message.id, result: { turn: { id: turnId } } });
        setTimeout(() => {
          send({ method: 'item/completed', params: {
            threadId: 'thread-1',
            turnId,
            item: { type: 'agentMessage', id: 'msg-' + turnId, text: 'resume=' + threadResumeCount },
          } });
          send({ method: 'turn/completed', params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'completed', error: null },
          } });
        }, 5);
        return;
      }
    `);
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 5_000,
      threadIdleReleaseMs: -1,
    });

    try {
      await collectEvents(client);
      const events = await collectTurnEvents(client, { savedThreadId: 'thread-1', prompt: 'again' }) as Array<{
        type?: string;
        item?: { text?: string };
      }>;
      assert.equal(events.find((event) => event.type === 'item.completed')?.item?.text, 'resume=0');
      assert.equal(client.getThreadRuntimeStatus('thread-1')?.status, 'idle');
    } finally {
      await client.close();
    }
  });

  it('unsubscribes an idle thread and resumes it without loading turn history', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        if (threadResumeCount > 0 && message.params.threadId !== 'thread-1') process.exit(11);
        const turnId = 'turn-' + (++turnCount);
        send({ id: message.id, result: { turn: { id: turnId } } });
        setTimeout(() => {
          send({ method: 'item/completed', params: {
            threadId: 'thread-1',
            turnId,
            item: {
              type: 'agentMessage',
              id: 'msg-' + turnId,
              text: 'resume=' + threadResumeCount + ';unsubscribe=' + threadUnsubscribeCount,
            },
          } });
          send({ method: 'turn/completed', params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'completed', error: null },
          } });
        }, 5);
        return;
      }
    `);
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 5_000,
      threadIdleReleaseMs: 20,
    });

    try {
      await collectEvents(client);
      await waitFor(() => client.getThreadRuntimeStatus('thread-1') === null);
      const events = await collectTurnEvents(client, { savedThreadId: 'thread-1', prompt: 'resume' }) as Array<{
        type?: string;
        item?: { text?: string };
      }>;
      assert.equal(
        events.find((event) => event.type === 'item.completed')?.item?.text,
        'resume=1;unsubscribe=1',
      );
    } finally {
      await client.close();
    }
  });

  it('finishes an interrupted stream when app-server never emits a terminal notification', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        return;
      }
    `);
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 5_000,
      interruptGraceMs: 30,
      threadIdleReleaseMs: -1,
    });

    try {
      const turn = await client.startTurn({ prompt: 'stop me' });
      await turn.interrupt();
      const events: Array<{ type: string; status?: string }> = [];
      for await (const event of turn.events) events.push(event as { type: string; status?: string });
      assert.deepEqual(events.at(-1), {
        type: 'turn.completed',
        status: 'interrupted',
        errorMessage: 'Codex app-server did not confirm interruption before the timeout.',
      });
      await waitFor(() => client.getOwnedProcessIds().length === 0);
    } finally {
      await client.close();
    }
  });

  it('terminates an active stream when the thread enters systemError', async () => {
    const scriptPath = createFakeAppServer(`
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => send({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1', status: { type: 'systemError' } },
        }), 5);
        return;
      }
    `);
    const client = new CodexAppServerClient(undefined, {
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      requestTimeoutMs: 5_000,
      threadIdleReleaseMs: -1,
    });

    try {
      const events = await collectEvents(client) as Array<{
        type: string;
        status?: string;
        errorMessage?: string;
      }>;
      assert.deepEqual(events.at(-1), {
        type: 'turn.completed',
        status: 'failed',
        errorMessage: 'Codex app-server reported a system error for this thread.',
      });
      assert.equal(client.getThreadRuntimeStatus('thread-1')?.status, 'system_error');
    } finally {
      await client.close();
    }
  });
});
