import './test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── SSE utils tests ─────────────────────────────────────────

import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });

  it('handles newlines in data', () => {
    const result = sseEvent('text', 'line1\nline2');
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.data, 'line1\nline2');
  });
});

// ── CodexProvider tests ─────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

function handleCompletedItem(
  provider: unknown,
  controller: ReadableStreamDefaultController<string>,
  item: Record<string, unknown>,
): void {
  (provider as any).handleItemEvent(controller, item, 'completed', 'test-session', new Set());
}

describe('CodexProvider', () => {
  it('streams app-server deltas and does not duplicate the completed agent message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const appServerClient = {
      async startTurn() {
        return {
          threadId: 'app-thread-1',
          turnId: 'app-turn-1',
          events: (async function* () {
            yield { type: 'item.started', item: { type: 'agentMessage', id: 'commentary-1', text: '', phase: 'commentary' } };
            yield { type: 'agent_message.delta', itemId: 'commentary-1', delta: 'working' };
            yield { type: 'item.completed', item: { type: 'agentMessage', id: 'commentary-1', text: 'working', phase: 'commentary' } };
            yield { type: 'agent_message.delta', itemId: 'message-1', delta: 'hello' };
            yield { type: 'item.completed', item: { type: 'agentMessage', id: 'message-1', text: 'hello' } };
            yield { type: 'usage.updated', usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1, reasoningOutputTokens: 1 } };
            yield { type: 'turn.completed', status: 'completed' };
          })(),
          async interrupt() {},
        };
      },
      async close() {},
    };
    const provider = new CodexProvider(new PendingPermissions(), {
      transport: 'app-server',
      appServerClient: appServerClient as never,
    });

    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
      sessionOrigin: 'bridge',
    })));

    assert.equal(events.filter((event) => event.type === 'text').length, 1);
    assert.equal(events.find((event) => event.type === 'text')?.data, 'hello');
    assert.ok(events.some((event) => event.type === 'status' && event.data.includes('working')));
    const result = JSON.parse(events.find((event) => event.type === 'result')!.data);
    assert.equal(result.session_id, 'app-thread-1');
    assert.equal(result.turn_id, 'app-turn-1');
    assert.equal(result.usage.reasoning_output_tokens, 1);
  });

  it('falls back to SDK only when auto app-server fails before turn/start', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { AppServerPreTurnError } = await import('../codex-app-server-client.js');
    const provider = new CodexProvider(undefined, {
      transport: 'auto',
      appServerClient: {
        async startTurn() { throw new AppServerPreTurnError('not available'); },
        async close() {},
      } as never,
    });
    let sdkCalls = 0;
    (provider as any).streamChatViaSdk = () => new ReadableStream<string>({
      start(controller) {
        sdkCalls += 1;
        controller.enqueue(sseEvent('text', 'sdk fallback'));
        controller.close();
      },
    });

    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
      sessionOrigin: 'bridge',
    })));

    assert.equal(sdkCalls, 1);
    assert.equal(events.find((event) => event.type === 'text')?.data, 'sdk fallback');
  });

  it('does not rerun an accepted app-server turn through SDK after a stream failure', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const provider = new CodexProvider(undefined, {
      transport: 'auto',
      appServerClient: {
        async startTurn() {
          return {
            threadId: 'app-thread-1',
            turnId: 'app-turn-1',
            events: (async function* () {
              yield { type: 'agent_message.delta', itemId: 'message-1', delta: 'partial' };
              throw new Error('stream disconnected');
            })(),
            async interrupt() {},
          };
        },
        async close() {},
      } as never,
    });
    let sdkCalls = 0;
    (provider as any).streamChatViaSdk = () => {
      sdkCalls += 1;
      throw new Error('must not rerun');
    };

    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
      sessionOrigin: 'bridge',
    })));

    assert.equal(sdkCalls, 0);
    assert.equal(events.find((event) => event.type === 'text')?.data, 'partial');
    assert.ok(events.some((event) => event.type === 'error' && event.data.includes('stream disconnected')));
  });

  it('always uses the SDK transport for Desktop-backed sessions', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    let appServerCalls = 0;
    const provider = new CodexProvider(undefined, {
      transport: 'app-server',
      appServerClient: {
        async startTurn() {
          appServerCalls += 1;
          throw new Error('Desktop session must not reach a separate app-server');
        },
        async close() {},
      } as never,
    });
    let sdkCalls = 0;
    (provider as any).streamChatViaSdk = () => new ReadableStream<string>({
      start(controller) {
        sdkCalls += 1;
        controller.enqueue(sseEvent('text', 'desktop sdk'));
        controller.close();
      },
    });

    const events = parseSSEChunks(await collectStream(provider.streamChat({
      prompt: 'continue desktop task',
      sessionId: 'desktop-session',
      sessionOrigin: 'desktop',
      desktopThreadId: 'desktop-thread',
    })));

    assert.equal(appServerCalls, 0);
    assert.equal(sdkCalls, 1);
    assert.equal(events.find((event) => event.type === 'text')?.data, 'desktop sdk');
  });

  it('exposes app-server ownership and thread status for bridge health checks', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const provider = new CodexProvider(undefined, {
      transport: 'app-server',
      appServerClient: {
        getOwnedProcessIds: () => [4312],
        getThreadRuntimeStatus: (threadId: string) => threadId === 'loaded-thread'
          ? { status: 'active', processId: 4312 }
          : null,
        async startTurn() { throw new Error('not used'); },
        async close() {},
      } as never,
    });

    assert.deepEqual(provider.getOwnedProcessIds(), [4312]);
    assert.deepEqual(provider.getThreadRuntimeStatus('loaded-thread'), {
      transport: 'app-server',
      status: 'active',
      processId: 4312,
    });
    assert.equal(provider.getThreadRuntimeStatus('other-thread'), null);
  });

  it('maps the current app-server cache write usage field', async () => {
    const { mapCodexUsage } = await import('../codex-provider.js');
    assert.deepEqual(mapCodexUsage({
      inputTokens: 13,
      outputTokens: 5,
      cachedInputTokens: 7,
      cacheWriteInputTokens: 2,
      reasoningOutputTokens: 3,
    }), {
      input_tokens: 13,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
      reasoning_output_tokens: 3,
    });
  });

  it('emits error when SDK init fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Force ensureSDK to fail by setting sdk to a broken module
    (provider as any).sdk = { Codex: class { constructor() { throw new Error('Missing API key'); } } };
    (provider as any).codex = null;
    // Reset so ensureSDK re-runs the constructor
    (provider as any).sdk = null;
    // Override ensureSDK directly
    (provider as any).ensureSDK = async () => { throw new Error('SDK init failed: Missing API key'); };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.ok(errorEvent!.data.includes('Missing API key'), 'Error should contain the cause');
  });

  it('maps agent_message item to text SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello from Codex!',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello from Codex!');
  });

  it('maps command_execution item to tool_use + tool_result', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1.txt\nfile2.txt',
      exit_code: 0,
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Bash');
    assert.equal(toolUse.input.command, 'ls -la');

    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'cmd-1');
    assert.equal(toolResult.is_error, false);
  });

  it('marks non-zero exit code as error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'command_execution',
      id: 'cmd-2',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.is_error, true);
  });

  it('maps file_change item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'file_change',
      id: 'fc-1',
      changes: [
        { path: 'src/main.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Edit');
    const toolResult = JSON.parse(events[1].data);
    assert.ok(toolResult.content.includes('update: src/main.ts'));
  });

  it('maps mcp_tool_call item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'myserver',
      tool: 'search',
      arguments: { query: 'test' },
      result: { content: 'found 3 results' },
    });

    const events = parseSSEChunks(chunks);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'mcp__myserver__search');
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, 'found 3 results');
  });

  it('maps mcp_tool_call with structured_content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-2',
      server: 'myserver',
      tool: 'getData',
      arguments: {},
      result: { structured_content: { items: [1, 2, 3] } },
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, JSON.stringify({ items: [1, 2, 3] }));
  });

  it('maps mcp_tool_call content blocks to readable text', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-3',
      server: 'myserver',
      tool: 'summarize',
      arguments: {},
      result: {
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      },
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, '第一段\n\n第二段');
  });

  it('maps todo_list item to task_update SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).threadIds.set('test-session', 'sdk-thread-1');
    handleCompletedItem(provider, mockController, {
      type: 'todo_list',
      id: 'todo-1',
      items: [
        { text: '第一步', completed: true },
        { text: '第二步', completed: false },
        { text: '第三步', completed: false },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'task_update');
    const payload = JSON.parse(events[0].data);
    assert.equal(payload.session_id, 'test-session');
    assert.equal(payload.sdk_session_id, 'sdk-thread-1');
    assert.deepEqual(payload.tasks, [
      { text: '第一步', status: 'completed' },
      { text: '第二步', status: 'in_progress' },
      { text: '第三步', status: 'pending' },
    ]);
  });

  it('emits web_search tool_use only once across started and completed phases', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;
    const emittedToolStarts = new Set<string>();

    (provider as any).handleItemEvent(
      mockController,
      { type: 'web_search', id: 'search-1', query: 'codex sdk' },
      'started',
      'test-session',
      emittedToolStarts,
    );
    (provider as any).handleItemEvent(
      mockController,
      { type: 'web_search', id: 'search-1', query: 'codex sdk' },
      'completed',
      'test-session',
      emittedToolStarts,
    );

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool_use');
    assert.equal(events[1].type, 'tool_result');

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Web Search');
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'search-1');
    assert.equal(toolResult.content, 'codex sdk');
  });

  it('maps reasoning item to status SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'reasoning',
      id: 'reason-1',
      text: '先检查 bridge manager 的状态流转',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'status');
    assert.deepEqual(JSON.parse(events[0].data), {
      reasoning: '先检查 bridge manager 的状态流转',
    });
  });

  it('skips empty agent_message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    handleCompletedItem(provider, mockController, {
      type: 'agent_message',
      id: 'msg-2',
      text: '',
    });

    assert.equal(chunks.length, 0);
  });

  it('does not pass model by default and still attempts resume for persisted thread ids', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;
    let capturedResumeOptions: Record<string, unknown> | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string, options: Record<string, unknown>) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        capturedResumeOptions = options;
        return mockThread;
      },
      startThread: (_opts: Record<string, unknown>) => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'model-default-session',
      sdkSessionId: 'old-sdk-session-id',
      model: 'legacy-model-name',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should attempt resume for the persisted thread id');
    assert.equal(resumedThreadId, 'old-sdk-session-id');
    assert.equal(startCalls, 0, 'Should not eagerly start a fresh thread when resume is available');
    assert.ok(capturedResumeOptions, 'resumeThread options should be captured');
    assert.ok(!Object.prototype.hasOwnProperty.call(capturedResumeOptions!, 'model'), 'Model should not be forwarded by default');
  });

  it('maps reasoning output token usage from turn.completed events', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield {
            type: 'turn.completed',
            usage: {
              input_tokens: 3,
              output_tokens: 5,
              cached_input_tokens: 1,
              reasoning_output_tokens: 2,
            },
          };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const chunks = await collectStream(provider.streamChat({
      prompt: 'usage',
      sessionId: 'usage-session',
    }));
    const result = parseSSEChunks(chunks).find((event) => event.type === 'result');

    assert.ok(result);
    assert.deepEqual(JSON.parse(result.data).usage, {
      input_tokens: 3,
      output_tokens: 5,
      cache_read_input_tokens: 1,
      reasoning_output_tokens: 2,
    });
  });

  it('maps forward-compatible cache write usage fields', async () => {
    const { mapCodexUsage } = await import('../codex-provider.js');

    assert.deepEqual(mapCodexUsage({
      input_tokens: 8,
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_write_input_tokens: 2,
      reasoning_output_tokens: 1,
    }), {
      input_tokens: 8,
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      reasoning_output_tokens: 1,
    });
    assert.equal(mapCodexUsage(null), undefined);
  });

  it('passes the abort signal to runStreamed so /stop can cancel the active turn', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedTurnOptions: Record<string, unknown> | undefined;
    let resolveRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      resolveRunStarted = resolve;
    });
    const mockThread = {
      runStreamed: (_input: unknown, turnOptions?: Record<string, unknown>) => {
        capturedTurnOptions = turnOptions;
        resolveRunStarted?.();
        return {
          events: (async function* () {
            await new Promise((_, reject) => {
              const signal = turnOptions?.signal as AbortSignal | undefined;
              const abort = () => {
                const error = new Error('user aborted');
                error.name = 'AbortError';
                reject(error);
              };
              if (signal?.aborted) {
                abort();
                return;
              }
              signal?.addEventListener('abort', abort, { once: true });
            });
          })(),
        };
      },
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const abortController = new AbortController();
    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'stop-session',
      abortController,
    });

    await runStarted;
    assert.ok(capturedTurnOptions?.signal instanceof AbortSignal);
    assert.equal((capturedTurnOptions?.signal as AbortSignal).aborted, false);

    abortController.abort();
    await collectStream(stream);
    assert.equal((capturedTurnOptions?.signal as AbortSignal).aborted, true);
  });

  it('treats turn.completed as terminal even if the SDK event iterator never closes', async () => {
    const previousTimeout = process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS;
    process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS = '20';

    try {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedSignal: AbortSignal | undefined;
    const mockThread = {
      runStreamed: (_input: unknown, turnOptions?: Record<string, unknown>) => ({
        events: (async function* () {
          capturedSignal = turnOptions?.signal as AbortSignal | undefined;
          yield { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5, cached_input_tokens: 1 } };
          await new Promise((_, reject) => {
            const abort = () => {
              const error = new Error('terminal drain timeout');
              error.name = 'AbortError';
              reject(error);
            };
            if (capturedSignal?.aborted) {
              abort();
              return;
            }
            capturedSignal?.addEventListener('abort', abort, { once: true });
          });
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'terminal event should close the bridge stream',
      sessionId: 'stalled-after-complete-session',
    });

    const chunks = await Promise.race([
      collectStream(stream),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('stream did not close after turn.completed')), 500)),
    ]);
    const events = parseSSEChunks(chunks);
    const resultEvent = events.find(e => e.type === 'result');

    assert.ok(resultEvent, 'Should emit a result event');
    const result = JSON.parse(resultEvent!.data);
    assert.deepEqual(result.usage, {
      input_tokens: 3,
      output_tokens: 5,
      cache_read_input_tokens: 1,
      reasoning_output_tokens: 0,
    });
    assert.equal(capturedSignal?.aborted, true);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS;
      } else {
        process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it('reuses the in-memory Codex thread even when the stored model is legacy-looking', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).threadIds.set('sticky-codex-session', 'codex-thread-123');
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        return mockThread;
      },
      startThread: () => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'continue previous thread',
      sessionId: 'sticky-codex-session',
      sdkSessionId: 'old-sdk-session-id',
      model: 'legacy-model-name',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should resume the in-memory Codex thread');
    assert.equal(resumedThreadId, 'codex-thread-123');
    assert.equal(startCalls, 0, 'Should not start a fresh thread when an in-memory Codex thread exists');
  });

  it('passes model only when forceModel=true', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedStartOptions: Record<string, unknown> | undefined;
    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: (opts: Record<string, unknown>) => {
        capturedStartOptions = opts;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'model-forward-session',
      model: 'gpt-5-codex',
      forceModel: true,
    });
    await collectStream(stream);

    assert.equal(capturedStartOptions?.model, 'gpt-5-codex');
  });

  it('passes skipGitRepoCheck only when CTI_CODEX_SKIP_GIT_REPO_CHECK=true', async () => {
    const old = process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
    process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = 'true';
    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'skip-git-check-session',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.skipGitRepoCheck, true);
    } finally {
      if (old === undefined) {
        delete process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK;
      } else {
        process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK = old;
      }
    }
  });

  it('retries with fresh thread when resume fails before any events', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    const resumeThread = {
      runStreamed: async () => {
        throw new Error('resuming session with different model');
      },
    };
    const freshThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return freshThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'retry test',
      sessionId: 'resume-retry-session',
      sdkSessionId: 'codex-old-thread-id',
      model: 'gpt-5-codex',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    const resultEvent = events.find(e => e.type === 'result');

    assert.equal(resumeCalls, 1, 'Should attempt resume once');
    assert.equal(startCalls, 1, 'Should fall back to a fresh thread');
    assert.ok(!errorEvent, 'Retry success should not emit error');
    assert.ok(resultEvent, 'Retry success should emit result');
  });
});

// ── Image input building tests ──────────────────────────────

import fs from 'node:fs';

/** Helper: build a full FileAttachment object for tests. */
function makeFile(type: string, data: string, name = 'test-file', extra: Record<string, unknown> = {}) {
  return { id: `file-${Date.now()}`, name, type, size: data.length, data, ...extra };
}

describe('CodexProvider image input', () => {
  it('builds local_image input array for text+image', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Mock the SDK so we can capture the input passed to runStreamed
    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    // Use valid base64 (1x1 red PNG pixel)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const stream = provider.streamChat({
      prompt: 'Describe this image',
      sessionId: 'img-session',
      files: [makeFile('image/png', pngBase64, 'test.png')],
    });

    await collectStream(stream);

    assert.ok(Array.isArray(capturedInput), 'Input should be an array for image input');
    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Describe this image');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'), 'Temp file should have .png extension');
  });

  it('passes plain string when no images attached', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Hello',
      sessionId: 'no-img-session',
    });

    await collectStream(stream);

    assert.equal(typeof capturedInput, 'string', 'Input should be a plain string without images');
    assert.equal(capturedInput, 'Hello');
  });

  it('builds local_image input with multiple images, ignoring non-image files', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Compare these',
      sessionId: 'multi-img-session',
      files: [
        makeFile('image/png', 'cG5n', 'a.png'),
        makeFile('image/jpeg', 'anBn', 'b.jpg'),
        makeFile('text/plain', 'dGV4dA==', 'c.txt'),
      ],
    });

    await collectStream(stream);

    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 3, 'Should have 1 text + 2 local_image parts (non-image file excluded)');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'));
    assert.equal(parts[2].type, 'local_image');
    assert.ok(parts[2].path.endsWith('.jpg'));
  });

  it('reuses persisted local image paths when filePath is already present', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const persistedImagePath = 'D:\\codex\\Claude-to-IM-skill\\.codepilot-uploads\\persisted.png';
    const originalExistsSync = fs.existsSync;
    fs.existsSync = ((target: fs.PathLike) => String(target) === persistedImagePath || originalExistsSync(target)) as typeof fs.existsSync;

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };

    const mockCodex = {
      startThread: () => mockThread,
    };

    try {
      (provider as any).ensureSDK = async () => ({ sdk: {}, codex: mockCodex });

      const stream = provider.streamChat({
        prompt: 'Use the persisted screenshot',
        sessionId: 'persisted-img-session',
        files: [makeFile('image/png', 'cG5n', 'persisted.png', { filePath: persistedImagePath })],
      });

      await collectStream(stream);

      const parts = capturedInput as Array<Record<string, string>>;
      assert.equal(parts[1].type, 'local_image');
      assert.equal(parts[1].path, persistedImagePath);
    } finally {
      fs.existsSync = originalExistsSync;
    }
  });

  it('passes sandboxMode and normalizes legacy reasoning effort for the Codex thread', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedStartOptions: Record<string, unknown> | undefined;
    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: (opts: Record<string, unknown>) => {
        capturedStartOptions = opts;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'sandbox-reasoning-session',
      sandboxMode: 'danger-full-access',
      modelReasoningEffort: 'max' as never,
    });
    await collectStream(stream);

    assert.equal(capturedStartOptions?.sandboxMode, 'danger-full-access');
    assert.equal(capturedStartOptions?.modelReasoningEffort, 'xhigh');
  });
});

// ── Error event tests ───────────────────────────────────────

describe('CodexProvider error events', () => {
  it('reads message field from turn.failed event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-1',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Rate limit exceeded');
  });

  it('normalizes reconnect-style turn failures to a user-visible resume hint', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield {
            type: 'turn.failed',
            error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
          };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-reconnect',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const recoveryStatus = events.find(e => e.type === 'status');
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(recoveryStatus);
    assert.equal(JSON.parse(recoveryStatus!.data).error_code, 'desktop_transport_lost');
    assert.ok(errorEvent);
    assert.match(errorEvent!.data, /会话恢复失败/);
    assert.match(errorEvent!.data, /\/t 0/);
    assert.equal((provider as any).codex, null);
  });

  it('aborts and recycles the SDK client when child process cleanup times out', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    let capturedSignal: AbortSignal | undefined;

    const mockThread = {
      runStreamed: (_input: unknown, options: { signal?: AbortSignal }) => {
        capturedSignal = options.signal;
        return {
          events: (async function* () {
            throw new Error('timeout waiting for child process to exit');
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const chunks = await collectStream(provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-child-timeout',
    }));
    const events = parseSSEChunks(chunks);

    assert.equal(capturedSignal?.aborted, true);
    assert.equal((provider as any).codex, null);
    assert.equal(
      JSON.parse(events.find(e => e.type === 'status')!.data).error_code,
      'desktop_transport_lost',
    );
    assert.match(events.find(e => e.type === 'error')!.data, /会话恢复失败/);
  });

  it('recycles the SDK client and starts a fresh thread after a process recovery failure', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let startCount = 0;
    let resumeCount = 0;
    let clientCount = 1;

    const failedThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'stale-thread' };
          yield {
            type: 'turn.failed',
            error: { message: 'Reconnecting... 2/5 (timeout waiting for child process to exit)' },
          };
        })(),
      }),
    };

    const freshThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'fresh-thread' };
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
          };
        })(),
      }),
    };

    const createClient = () => ({
      startThread: () => {
        startCount += 1;
        return startCount === 1 ? failedThread : freshThread;
      },
      resumeThread: () => {
        resumeCount += 1;
        return freshThread;
      },
    });
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = createClient();
    (provider as any).ensureSDK = async () => {
      if (!(provider as any).codex) {
        clientCount += 1;
        (provider as any).codex = createClient();
      }
      return { sdk: (provider as any).sdk, codex: (provider as any).codex };
    };

    const firstStream = provider.streamChat({
      prompt: 'first',
      sessionId: 'err-session-reset',
    });
    await collectStream(firstStream);

    assert.equal((provider as any).threadIds.has('err-session-reset'), false);

    const secondStream = provider.streamChat({
      prompt: 'second',
      sessionId: 'err-session-reset',
    });
    const secondChunks = await collectStream(secondStream);
    const secondEvents = parseSSEChunks(secondChunks);
    const resultEvent = secondEvents.find(e => e.type === 'result');

    assert.equal(resumeCount, 0, 'failed in-memory thread id must not be resumed');
    assert.equal(clientCount, 2, 'process recovery should construct a new SDK client');
    assert.equal(startCount, 2, 'second request should start a fresh thread');
    assert.ok(resultEvent, 'fresh thread should complete successfully');
    assert.equal((provider as any).threadIds.get('err-session-reset'), 'fresh-thread');
  });

  it('drains the SDK stream after a terminal event and suppresses the internal abort timeout', async () => {
    const previousTimeout = process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS;
    process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS = '20';

    try {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedSignal: AbortSignal | undefined;
      const mockThread = {
        runStreamed: (_input: unknown, turnOptions?: Record<string, unknown>) => {
          capturedSignal = turnOptions?.signal as AbortSignal | undefined;
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'drain-thread' };
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
              };
              await new Promise((_, reject) => {
                const abort = () => {
                  const error = new Error('drain timeout');
                  error.name = 'AbortError';
                  reject(error);
                };
                if (capturedSignal?.aborted) {
                  abort();
                  return;
                }
                capturedSignal?.addEventListener('abort', abort, { once: true });
              });
            })(),
          };
        },
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'test',
        sessionId: 'terminal-drain-session',
      });

      const chunks = await collectStream(stream);
      const events = parseSSEChunks(chunks);
      const resultEvent = events.find(e => e.type === 'result');
      const errorEvent = events.find(e => e.type === 'error');

      assert.ok(resultEvent, 'terminal turn should still produce a result');
      assert.equal(errorEvent, undefined, 'internal drain abort must not leak as a user-visible error');
      assert.equal((provider as any).threadIds.get('terminal-drain-session'), 'drain-thread');
      assert.equal(capturedSignal?.aborted, true, 'provider should abort the lingering stream after the drain timeout');
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS;
      } else {
        process.env.CTI_CODEX_TERMINAL_DRAIN_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it('suppresses Windows process cleanup parse noise after completed assistant content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'cleanup-thread' };
          yield {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              id: 'msg-cleanup',
              text: '最终回复',
            },
          };
          throw new Error('Failed to parse item: SUCCESS: The process with PID 27224 (child process of PID 46152) has been terminated.');
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'windows-cleanup-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const textEvent = events.find(e => e.type === 'text');
    const errorEvent = events.find(e => e.type === 'error');

    assert.equal(textEvent?.data, '最终回复');
    assert.equal(errorEvent, undefined, 'cleanup parse noise must not downgrade a completed reply to error');
    assert.equal((provider as any).threadIds.get('windows-cleanup-session'), 'cleanup-thread');
  });

  it('keeps Windows process cleanup parse noise as an error before completed assistant content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'early-cleanup-thread' };
          throw new Error('Failed to parse item: SUCCESS: The process with PID 27224 (child process of PID 46152) has been terminated.');
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'early-windows-cleanup-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');

    assert.match(errorEvent?.data || '', /Failed to parse item: SUCCESS/);
    assert.equal((provider as any).threadIds.has('early-windows-cleanup-session'), false);
  });

  it('reads message field from error event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'error', message: 'Connection lost' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-2',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Connection lost');
  });

  it('falls back to default message when message field is absent', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-3',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent);
    assert.equal(errorEvent!.data, 'Turn failed');
  });
});

