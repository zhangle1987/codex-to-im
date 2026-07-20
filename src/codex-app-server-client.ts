import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { PendingPermissions, PermissionResult } from './permission-gateway.js';

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export type CodexAppServerEvent =
  | { type: 'item.started' | 'item.completed'; item: Record<string, unknown> }
  | { type: 'agent_message.delta'; itemId: string; delta: string }
  | { type: 'reasoning.delta'; itemId: string; delta: string }
  | { type: 'plan.updated'; plan: Array<{ step: string; status: string }> }
  | { type: 'usage.updated'; usage: Record<string, unknown> }
  | { type: 'model.updated'; model: string }
  | { type: 'permission.request'; requestId: string; toolName: string; toolInput: Record<string, unknown>; suggestions?: unknown[] }
  | { type: 'warning'; message: string }
  | { type: 'turn.completed'; status: string; errorMessage?: string };

export interface CodexAppServerTurnParams {
  savedThreadId?: string;
  prompt: string;
  imagePaths?: string[];
  model?: string;
  forceModel?: boolean;
  modelReasoningEffort?: string;
  workingDirectory?: string;
  sandboxMode?: string;
  permissionMode?: string;
  systemPrompt?: string;
  skipGitRepoCheck?: boolean;
  abortSignal?: AbortSignal;
}

export interface CodexAppServerTurn {
  threadId: string;
  turnId: string;
  events: AsyncIterable<CodexAppServerEvent>;
  interrupt(): Promise<void>;
}

export interface CodexAppServerClientOptions {
  executablePath?: string;
  executableArgs?: string[];
  requestTimeoutMs?: number;
  interruptGraceMs?: number;
  threadIdleReleaseMs?: number;
  spawnProcess?: typeof spawn;
}

export type CodexAppServerThreadStatus = 'idle' | 'active' | 'system_error' | 'not_loaded' | 'unknown';

export interface CodexAppServerThreadRuntime {
  status: CodexAppServerThreadStatus;
  processId?: number;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  queue: AsyncEventQueue<CodexAppServerEvent>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  interruptTimer?: ReturnType<typeof setTimeout>;
  permissionRequestIds: Set<string>;
}

interface StartingTurn {
  threadId: string;
  messages: JsonRpcMessage[];
  queue: AsyncEventQueue<CodexAppServerEvent>;
  permissionRequestIds: Set<string>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_GRACE_MS = 15_000;
const DEFAULT_THREAD_IDLE_RELEASE_MS = 10 * 60_000;
const STDERR_TAIL_LIMIT = 16_384;
const localRequire = createRequire(import.meta.url);

const PLATFORM_TARGETS: Record<string, { packageName: string; triple: string }> = {
  'linux:x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux:arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin:x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin:arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32:x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32:arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve(result: IteratorResult<T>): void; reject(error: Error): void }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

export class AppServerPreTurnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppServerPreTurnError';
  }
}

export class AppServerTurnStartUncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppServerTurnStartUncertainError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function abortError(): Error {
  const error = new Error('Task stopped by user');
  error.name = 'AbortError';
  return error;
}

function mapApprovalPolicy(permissionMode?: string): 'never' | 'on-request' {
  return permissionMode === 'never' ? 'never' : 'on-request';
}

function mapSandboxMode(value?: string): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (value === 'read-only' || value === 'danger-full-access') return value;
  return 'workspace-write';
}

function getThreadId(params: Record<string, unknown>): string {
  return asString(params.threadId ?? params.thread_id);
}

function getTurnId(params: Record<string, unknown>): string {
  return asString(params.turnId ?? params.turn_id ?? asRecord(params.turn).id);
}

function getItemId(params: Record<string, unknown>): string {
  return asString(params.itemId ?? params.item_id);
}

function getThreadStatus(value: unknown): CodexAppServerThreadStatus {
  const type = asString(asRecord(value).type);
  if (type === 'idle' || type === 'active' || type === 'notLoaded') {
    return type === 'notLoaded' ? 'not_loaded' : type;
  }
  if (type === 'systemError') return 'system_error';
  return 'unknown';
}

export function resolveBundledCodexExecutable(): string {
  const target = PLATFORM_TARGETS[`${process.platform}:${process.arch}`];
  if (!target) {
    throw new Error(`Unsupported Codex platform: ${process.platform} (${process.arch})`);
  }

  let codexPackageJson = '';
  try {
    codexPackageJson = localRequire.resolve('@openai/codex/package.json');
  } catch {
    const sdkEntry = localRequire.resolve('@openai/codex-sdk');
    codexPackageJson = createRequire(sdkEntry).resolve('@openai/codex/package.json');
  }

  const codexRequire = createRequire(codexPackageJson);
  let vendorRoot = path.join(path.dirname(codexPackageJson), 'vendor');
  try {
    const platformPackageJson = codexRequire.resolve(`${target.packageName}/package.json`);
    vendorRoot = path.join(path.dirname(platformPackageJson), 'vendor');
  } catch {
    // Some package managers place the platform payload in @openai/codex/vendor.
  }

  const executablePath = path.join(
    vendorRoot,
    target.triple,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Bundled Codex executable is missing: ${executablePath}`);
  }
  return executablePath;
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startupPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private generation = 0;
  private stdoutBuffer = '';
  private stderrTail = '';
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private activeTurns = new Map<string, ActiveTurn>();
  private startingTurns = new Map<string, StartingTurn>();
  private approvalPermissionIds = new Map<string, string>();
  private unknownMethods = new Set<string>();
  private subscribedThreadIds = new Set<string>();
  private threadStatuses = new Map<string, CodexAppServerThreadStatus>();
  private threadReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recyclePromise: Promise<void> | null = null;

  constructor(
    private readonly pendingPermissions?: PendingPermissions,
    private readonly options: CodexAppServerClientOptions = {},
  ) {}

  getOwnedProcessIds(): number[] {
    const pid = this.child?.pid;
    return typeof pid === 'number' && pid > 0 ? [pid] : [];
  }

  getThreadRuntimeStatus(threadId: string): CodexAppServerThreadRuntime | null {
    if (!this.subscribedThreadIds.has(threadId) && !this.threadStatuses.has(threadId)) return null;
    return {
      status: this.threadStatuses.get(threadId) || 'unknown',
      ...(this.child?.pid ? { processId: this.child.pid } : {}),
    };
  }

  async startTurn(params: CodexAppServerTurnParams): Promise<CodexAppServerTurn> {
    if (params.abortSignal?.aborted) throw abortError();

    let turnStartDispatched = false;
    let threadResolutionStarted = false;
    try {
      await this.ensureStarted();
      threadResolutionStarted = true;
      const threadId = await this.resolveThread(params);
      if (params.abortSignal?.aborted) {
        this.scheduleThreadRelease(threadId);
        throw abortError();
      }
      this.clearThreadReleaseTimer(threadId);
      const starting: StartingTurn = {
        threadId,
        messages: [],
        queue: new AsyncEventQueue<CodexAppServerEvent>(),
        permissionRequestIds: new Set<string>(),
      };
      this.startingTurns.set(threadId, starting);

      let response: Record<string, unknown>;
      try {
        response = asRecord(await this.sendRequest('turn/start', {
          threadId,
          clientUserMessageId: crypto.randomUUID(),
          input: [
            { type: 'text', text: params.prompt, text_elements: [] },
            ...(params.imagePaths || []).map((imagePath) => ({ type: 'localImage', path: imagePath })),
          ],
          ...(params.workingDirectory ? { cwd: params.workingDirectory } : {}),
          ...(params.forceModel && params.model ? { model: params.model } : {}),
          ...(params.modelReasoningEffort ? { effort: params.modelReasoningEffort } : {}),
          approvalPolicy: mapApprovalPolicy(params.permissionMode),
        }, () => {
          turnStartDispatched = true;
        }));
      } catch (error) {
        this.startingTurns.delete(threadId);
        this.cancelPermissions(starting, 'Turn failed before startup completed');
        starting.queue.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }

      const turn = asRecord(response.turn);
      const turnId = asString(turn.id);
      if (!turnId) {
        this.startingTurns.delete(threadId);
        const error = new Error('turn/start returned no turn id');
        this.cancelPermissions(starting, error.message);
        starting.queue.fail(error);
        throw error;
      }

      const active: ActiveTurn = {
        threadId,
        turnId,
        queue: starting.queue,
        abortSignal: params.abortSignal,
        permissionRequestIds: starting.permissionRequestIds,
      };
      this.activeTurns.set(turnId, active);
      this.threadStatuses.set(threadId, 'active');
      this.startingTurns.delete(threadId);
      for (const message of starting.messages) this.routeTurnMessage(active, message);

      if (params.abortSignal && this.activeTurns.has(turnId)) {
        active.abortListener = () => { void this.interruptTurn(threadId, turnId); };
        if (params.abortSignal.aborted) {
          void this.interruptTurn(threadId, turnId);
        } else {
          params.abortSignal.addEventListener('abort', active.abortListener, { once: true });
        }
      }

      return {
        threadId,
        turnId,
        events: active.queue,
        interrupt: () => this.interruptTurn(threadId, turnId),
      };
    } catch (error) {
      if (
        error instanceof AppServerPreTurnError
        || error instanceof AppServerTurnStartUncertainError
        || (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (turnStartDispatched) {
        await this.recycleChild(`turn/start result is unknown for thread ${params.savedThreadId || 'new'}`);
        throw new AppServerTurnStartUncertainError(
          `Codex app-server turn/start was dispatched but its result is unknown: ${detail}`,
          { cause: error },
        );
      }
      if (threadResolutionStarted) {
        await this.recycleChild(`thread preparation failed before turn/start: ${detail}`);
      }
      throw new AppServerPreTurnError(`Codex app-server could not start the turn: ${detail}`, { cause: error });
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const error = new Error('Codex app-server client closed');
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const active of this.activeTurns.values()) {
      if (active.interruptTimer) clearTimeout(active.interruptTimer);
      this.cancelPermissions(active, error.message);
      active.queue.fail(error);
    }
    this.activeTurns.clear();
    for (const starting of this.startingTurns.values()) {
      this.cancelPermissions(starting, error.message);
      starting.queue.fail(error);
    }
    this.startingTurns.clear();
    this.approvalPermissionIds.clear();
    this.clearAllThreadReleaseTimers();
    this.subscribedThreadIds.clear();
    this.threadStatuses.clear();
    this.startupPromise = null;
    if (child.exitCode !== null) {
      if (this.child === child) this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', finish);
        resolve();
      };
      const timer = setTimeout(finish, 2_000);
      child.once('exit', finish);
      try { child.stdin.end(); } catch { /* best effort */ }
      try { child.kill(); } catch { finish(); }
    });
    if (this.child === child) this.child = null;
  }

  private async resolveThread(params: CodexAppServerTurnParams): Promise<string> {
    const common = {
      ...(params.forceModel && params.model ? { model: params.model } : {}),
      ...(params.workingDirectory ? { cwd: params.workingDirectory } : {}),
      approvalPolicy: mapApprovalPolicy(params.permissionMode),
      sandbox: mapSandboxMode(params.sandboxMode),
      ...(params.systemPrompt ? { developerInstructions: params.systemPrompt } : {}),
      ...(params.skipGitRepoCheck ? { config: { skip_git_repo_check: true } } : {}),
    };

    if (params.savedThreadId) {
      if (this.subscribedThreadIds.has(params.savedThreadId)) {
        if (this.threadStatuses.get(params.savedThreadId) !== 'system_error') {
          return params.savedThreadId;
        }
        this.forgetThread(params.savedThreadId);
      }
      const resumed = asRecord(await this.sendRequest('thread/resume', {
        threadId: params.savedThreadId,
        excludeTurns: true,
        ...common,
      }));
      const resumedThread = asRecord(resumed.thread);
      const resumedThreadId = asString(resumedThread.id);
      if (!resumedThreadId) throw new Error('thread/resume returned no thread id');
      this.markThreadSubscribed(resumedThreadId, getThreadStatus(resumedThread.status));
      return resumedThreadId;
    }

    const started = asRecord(await this.sendRequest('thread/start', {
      ...common,
      threadSource: 'codex-to-im',
    }));
    const startedThread = asRecord(started.thread);
    const threadId = asString(startedThread.id);
    if (!threadId) throw new Error('thread/start returned no thread id');
    this.markThreadSubscribed(threadId, getThreadStatus(startedThread.status));
    return threadId;
  }

  private async ensureStarted(): Promise<void> {
    if (this.recyclePromise) await this.recyclePromise;
    if (this.child && this.child.exitCode === null && this.startupPromise) {
      return this.startupPromise;
    }
    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = (async () => {
      let executablePath: string;
      try {
        executablePath = this.options.executablePath || resolveBundledCodexExecutable();
      } catch (error) {
        throw new AppServerPreTurnError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }

      const env = { ...process.env };
      const apiKey = process.env.CTI_CODEX_API_KEY || process.env.CODEX_API_KEY;
      if (apiKey) env.OPENAI_API_KEY = apiKey;
      if (process.env.CTI_CODEX_BASE_URL) env.OPENAI_BASE_URL = process.env.CTI_CODEX_BASE_URL;

      const spawnProcess = this.options.spawnProcess || spawn;
      const child = spawnProcess(executablePath, this.options.executableArgs || ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      this.generation += 1;
      this.stdoutBuffer = '';
      this.stderrTail = '';

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
      });
      child.on('exit', (code, signal) => this.handleExit(child, code, signal));

      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => {
          child.off('spawn', onSpawn);
          child.off('error', onError);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });

      child.on('error', (error) => {
        if (this.child !== child) return;
        console.warn('[codex-app-server] Child process error:', error.message);
        try { child.kill(); } catch { /* best effort */ }
      });
      child.stdin.on('error', (error) => {
        if (this.child !== child) return;
        console.warn('[codex-app-server] stdin error:', error.message);
        try { child.kill(); } catch { /* best effort */ }
      });

      await this.sendRequest('initialize', {
        clientInfo: { name: 'codex-to-im', title: 'Codex to IM', version: '1' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.sendNotification('initialized', {});
    })().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.startupPromise = null;
      try { this.child?.kill(); } catch { /* best effort */ }
      this.child = null;
      throw error instanceof AppServerPreTurnError
        ? error
        : new AppServerPreTurnError(`Codex app-server initialization failed: ${detail}`, { cause: error });
    });

    return this.startupPromise;
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    onDispatched?: () => void,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextRequestId++;
    const timeoutMs = Math.max(10, this.options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, { method, resolve, reject, timer });
      try {
        this.writeMessage({ id, method, params });
        onDispatched?.();
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeMessage({ method, params });
  }

  private writeMessage(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new Error('Codex app-server stdin is unavailable');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (error) {
        console.warn('[codex-app-server] Ignored invalid protocol line:', error instanceof Error ? error.message : error);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.message || `JSON-RPC error ${message.error.code ?? ''}`.trim();
        pending.reject(new Error(`${pending.method} failed: ${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    if (message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }

    const params = asRecord(message.params);
    if (message.method === 'thread/started') {
      const thread = asRecord(params.thread);
      const threadId = asString(thread.id);
      if (threadId) this.markThreadSubscribed(threadId, getThreadStatus(thread.status));
      return;
    }
    if (message.method === 'thread/status/changed') {
      const threadId = getThreadId(params);
      const status = getThreadStatus(params.status);
      if (threadId && (status === 'system_error' || status === 'not_loaded')) {
        const active = this.findActiveTurnByThreadId(threadId);
        if (active) {
          active.queue.push({
            type: 'turn.completed',
            status: 'failed',
            errorMessage: status === 'system_error'
              ? 'Codex app-server reported a system error for this thread.'
              : 'Codex app-server unloaded this thread before the turn completed.',
          });
          this.finishTurn(active, {
            threadStatus: status,
            releaseThread: status === 'system_error',
          });
        }
        if (status === 'not_loaded') this.forgetThread(threadId);
        else this.threadStatuses.set(threadId, status);
      } else if (threadId) {
        this.threadStatuses.set(threadId, status);
      }
      return;
    }
    if (message.method === 'thread/closed') {
      const threadId = getThreadId(params);
      if (threadId) {
        const active = this.findActiveTurnByThreadId(threadId);
        if (active) {
          active.queue.push({
            type: 'turn.completed',
            status: 'failed',
            errorMessage: 'Codex app-server closed the thread before the turn completed.',
          });
          this.finishTurn(active, { threadStatus: 'not_loaded', releaseThread: false });
        }
        this.forgetThread(threadId);
      }
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      const protocolRequestId = String(params.requestId ?? '');
      const permissionRequestId = this.approvalPermissionIds.get(protocolRequestId);
      if (permissionRequestId) {
        this.approvalPermissionIds.delete(protocolRequestId);
        this.pendingPermissions?.resolve(permissionRequestId, {
          behavior: 'deny',
          message: 'Permission request was resolved by Codex',
        });
      }
      return;
    }
    const turnId = getTurnId(params);
    const threadId = getThreadId(params);
    const active = turnId
      ? this.activeTurns.get(turnId)
      : threadId
        ? this.findActiveTurnByThreadId(threadId)
        : undefined;
    if (active) {
      this.routeTurnMessage(active, message);
      return;
    }

    const starting = threadId ? this.startingTurns.get(threadId) : undefined;
    if (starting) starting.messages.push(message);
  }

  private routeTurnMessage(active: ActiveTurn, message: JsonRpcMessage): void {
    const method = message.method || '';
    const params = asRecord(message.params);
    const messageTurnId = getTurnId(params);
    if (messageTurnId && messageTurnId !== active.turnId) return;

    switch (method) {
      case 'item/started':
      case 'item/completed':
        active.queue.push({
          type: method === 'item/started' ? 'item.started' : 'item.completed',
          item: asRecord(params.item),
        });
        return;
      case 'item/agentMessage/delta':
        active.queue.push({ type: 'agent_message.delta', itemId: getItemId(params), delta: asString(params.delta) });
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        active.queue.push({ type: 'reasoning.delta', itemId: getItemId(params), delta: asString(params.delta) });
        return;
      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan)
          ? params.plan.map((entry) => {
              const record = asRecord(entry);
              return { step: asString(record.step), status: asString(record.status) };
            }).filter((entry) => entry.step)
          : [];
        active.queue.push({ type: 'plan.updated', plan });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const tokenUsage = asRecord(params.tokenUsage);
        active.queue.push({ type: 'usage.updated', usage: asRecord(tokenUsage.last) });
        return;
      }
      case 'model/rerouted': {
        const model = asString(params.toModel ?? params.model);
        if (model) active.queue.push({ type: 'model.updated', model });
        return;
      }
      case 'error': {
        const error = asRecord(params.error);
        const messageText = asString(error.message);
        if (messageText && params.willRetry === true) {
          active.queue.push({ type: 'warning', message: messageText });
        }
        return;
      }
      case 'turn/completed': {
        const turn = asRecord(params.turn);
        const error = asRecord(turn.error);
        active.queue.push({
          type: 'turn.completed',
          status: asString(turn.status) || 'completed',
          ...(asString(error.message) ? { errorMessage: asString(error.message) } : {}),
        });
        this.finishTurn(active);
        return;
      }
      case 'warning': {
        const messageText = asString(params.message);
        if (messageText) active.queue.push({ type: 'warning', message: messageText });
        return;
      }
      default:
        if (method && getTurnId(params) && !this.unknownMethods.has(method)) {
          this.unknownMethods.add(method);
          console.warn(`[codex-app-server] Unhandled turn notification: ${method}`);
        }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id!;
    const method = message.method || '';
    const params = asRecord(message.params);
    try {
      if (
        method === 'item/commandExecution/requestApproval'
        || method === 'item/fileChange/requestApproval'
        || method === 'item/permissions/requestApproval'
        || method === 'execCommandApproval'
        || method === 'applyPatchApproval'
      ) {
        const result = await this.requestApproval(id, method, params);
        this.writeMessage({ id, result });
        return;
      }
      if (method === 'item/tool/requestUserInput') {
        const owner = this.getRequestOwner(params);
        owner?.queue.push({
          type: 'warning',
          message: 'Codex requested interactive input, but this IM bridge cannot answer structured questions yet.',
        });
        this.writeMessage({ id, result: { answers: {} } });
        return;
      }
      if (method === 'mcpServer/elicitation/request') {
        const owner = this.getRequestOwner(params);
        owner?.queue.push({
          type: 'warning',
          message: 'An MCP server requested interactive input; the request was declined by the IM bridge.',
        });
        this.writeMessage({ id, result: { action: 'decline', content: null, _meta: null } });
        return;
      }
      this.writeMessage({ id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
    } catch (error) {
      try {
        this.writeMessage({
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      } catch {
        // The transport may have closed while the user was deciding an approval.
      }
    }
  }

  private async requestApproval(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestId = `app-server:${this.generation}:${String(id)}`;
    const turnId = getTurnId(params);
    const active = turnId ? this.activeTurns.get(turnId) : undefined;
    const starting = this.startingTurns.get(getThreadId(params));
    const owner = active || starting;
    const toolName = method.includes('fileChange') || method === 'applyPatchApproval'
      ? 'apply_patch'
      : method.includes('permissions')
        ? 'request_permissions'
        : 'Bash';
    const suggestions = [params.reason, params.proposedExecpolicyAmendment, params.proposedNetworkPolicyAmendments]
      .filter((value) => value != null);

    const resolutionPromise = this.pendingPermissions
      ? this.pendingPermissions.waitFor(requestId)
      : Promise.resolve<PermissionResult>({ behavior: 'deny', message: 'Permission gateway unavailable' });
    this.approvalPermissionIds.set(String(id), requestId);
    owner?.permissionRequestIds.add(requestId);
    owner?.queue.push({
      type: 'permission.request',
      requestId,
      toolName,
      toolInput: params,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    });
    const resolution = await resolutionPromise;
    this.approvalPermissionIds.delete(String(id));
    owner?.permissionRequestIds.delete(requestId);
    const allowed = resolution.behavior === 'allow';

    if (method === 'item/permissions/requestApproval') {
      const requested = asRecord(params.permissions);
      const granted: Record<string, unknown> = {};
      if (allowed && requested.network) granted.network = requested.network;
      if (allowed && requested.fileSystem) granted.fileSystem = requested.fileSystem;
      return { permissions: granted, scope: 'turn' };
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: allowed ? 'approved' : 'denied' };
    }
    return { decision: allowed ? 'accept' : 'decline' };
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const active = this.activeTurns.get(turnId);
    if (active && !active.interruptTimer) {
      const graceMs = Math.max(10, this.options.interruptGraceMs || DEFAULT_INTERRUPT_GRACE_MS);
      active.interruptTimer = setTimeout(() => {
        active.interruptTimer = undefined;
        if (this.activeTurns.get(turnId) !== active) return;
        active.queue.push({
          type: 'turn.completed',
          status: 'interrupted',
          errorMessage: 'Codex app-server did not confirm interruption before the timeout.',
        });
        this.finishTurn(active);
        void this.recycleChild(`interrupt timeout for turn ${turnId}`);
      }, graceMs);
      active.interruptTimer.unref?.();
    }
    try {
      await this.sendRequest('turn/interrupt', { threadId, turnId });
    } catch (error) {
      console.warn('[codex-app-server] Failed to interrupt turn:', error instanceof Error ? error.message : error);
    }
  }

  private finishTurn(
    active: ActiveTurn,
    options: {
      threadStatus?: CodexAppServerThreadStatus;
      releaseThread?: boolean;
    } = {},
  ): void {
    this.activeTurns.delete(active.turnId);
    this.threadStatuses.set(active.threadId, options.threadStatus || 'idle');
    if (active.interruptTimer) {
      clearTimeout(active.interruptTimer);
      active.interruptTimer = undefined;
    }
    this.cancelPermissions(active, 'Turn completed before the permission request was resolved');
    if (active.abortSignal && active.abortListener) {
      active.abortSignal.removeEventListener('abort', active.abortListener);
    }
    active.queue.close();
    if (options.releaseThread === false) this.clearThreadReleaseTimer(active.threadId);
    else this.scheduleThreadRelease(active.threadId);
  }

  private findActiveTurnByThreadId(threadId: string): ActiveTurn | undefined {
    for (const active of this.activeTurns.values()) {
      if (active.threadId === threadId) return active;
    }
    return undefined;
  }

  private getRequestOwner(params: Record<string, unknown>): ActiveTurn | StartingTurn | undefined {
    const turnId = getTurnId(params);
    if (turnId) return this.activeTurns.get(turnId);
    const threadId = getThreadId(params);
    if (!threadId) return undefined;
    return this.findActiveTurnByThreadId(threadId) || this.startingTurns.get(threadId);
  }

  private markThreadSubscribed(threadId: string, status: CodexAppServerThreadStatus): void {
    this.subscribedThreadIds.add(threadId);
    this.threadStatuses.set(threadId, status === 'unknown' ? 'idle' : status);
    this.clearThreadReleaseTimer(threadId);
  }

  private forgetThread(threadId: string): void {
    this.clearThreadReleaseTimer(threadId);
    this.subscribedThreadIds.delete(threadId);
    this.threadStatuses.delete(threadId);
  }

  private scheduleThreadRelease(threadId: string): void {
    this.clearThreadReleaseTimer(threadId);
    const idleMs = this.options.threadIdleReleaseMs ?? DEFAULT_THREAD_IDLE_RELEASE_MS;
    if (!Number.isFinite(idleMs) || idleMs < 0) return;
    const timer = setTimeout(() => {
      this.threadReleaseTimers.delete(threadId);
      void this.unsubscribeThread(threadId);
    }, Math.max(1, idleMs));
    timer.unref?.();
    this.threadReleaseTimers.set(threadId, timer);
  }

  private clearThreadReleaseTimer(threadId: string): void {
    const timer = this.threadReleaseTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.threadReleaseTimers.delete(threadId);
  }

  private clearAllThreadReleaseTimers(): void {
    for (const timer of this.threadReleaseTimers.values()) clearTimeout(timer);
    this.threadReleaseTimers.clear();
  }

  private async unsubscribeThread(threadId: string): Promise<void> {
    if (!this.subscribedThreadIds.has(threadId) || this.findActiveTurnByThreadId(threadId)) return;
    try {
      await this.sendRequest('thread/unsubscribe', { threadId });
      this.forgetThread(threadId);
    } catch (error) {
      console.warn(
        `[codex-app-server] Failed to release idle thread ${threadId}:`,
        error instanceof Error ? error.message : error,
      );
      if (this.child) this.scheduleThreadRelease(threadId);
    }
  }

  private cancelPermissions(
    owner: Pick<ActiveTurn, 'permissionRequestIds'>,
    message: string,
  ): void {
    for (const requestId of owner.permissionRequestIds) {
      this.pendingPermissions?.resolve(requestId, { behavior: 'deny', message });
    }
    owner.permissionRequestIds.clear();
  }

  private recycleChild(reason: string): Promise<void> {
    const child = this.child;
    if (this.recyclePromise) return this.recyclePromise;
    if (!child || child.exitCode !== null) return Promise.resolve();
    console.warn(`[codex-app-server] Recycling app-server: ${reason}`);
    this.recyclePromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', finish);
        this.recyclePromise = null;
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.child === child) this.handleExit(child, null, 'SIGKILL');
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        finish();
      }, 2_000);
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); }
    });
    return this.recyclePromise;
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.child = null;
    this.startupPromise = null;
    this.clearAllThreadReleaseTimers();
    this.subscribedThreadIds.clear();
    this.threadStatuses.clear();
    const detail = this.stderrTail.trim();
    const error = new Error(
      `Codex app-server exited (${signal || (code ?? 'unknown')})${detail ? `: ${detail}` : ''}`,
    );
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const active of this.activeTurns.values()) {
      if (active.interruptTimer) clearTimeout(active.interruptTimer);
      this.cancelPermissions(active, 'Codex app-server exited');
      active.queue.fail(error);
    }
    this.activeTurns.clear();
    for (const starting of this.startingTurns.values()) {
      this.cancelPermissions(starting, 'Codex app-server exited');
      starting.queue.fail(error);
    }
    this.startingTurns.clear();
    this.approvalPermissionIds.clear();
  }
}
