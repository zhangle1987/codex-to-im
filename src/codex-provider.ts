/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * The provider lazily imports the installed SDK at first use and throws
 * a clear error if the package is missing from the current installation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { LLMProvider, StreamChatParams } from './lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';
import type { CodexReasoningEffort, CodexSandboxMode } from './config.js';
import {
  normalizeSandboxMode,
  parseReasoningEffort,
} from './runtime-options.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Keep SDK types as `any` because we lazy-load the package at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'never': return 'never';
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function normalizeCodexErrorMessage(message: string | null | undefined): string {
  const trimmed = (message || '').trim();
  if (!trimmed) return 'Codex 执行失败，请稍后重试。';

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('timeout waiting for child process to exit')
    || lower.includes('reconnecting...')
  ) {
    return 'Codex 会话恢复失败，上一轮执行进程未正常退出。请稍后重试；如果连续失败，请新开线程或切换到 /t 0。';
  }

  return trimmed;
}

function normalizeTaskText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapTodoListItems(items: unknown): Array<{ text: string; status: 'in_progress' | 'pending' | 'completed' }> {
  if (!Array.isArray(items)) return [];
  const normalized = items
    .map((item) => ({
      text: normalizeTaskText((item as { text?: unknown })?.text),
      completed: (item as { completed?: unknown })?.completed === true,
    }))
    .filter((item) => item.text);

  let firstIncompleteSeen = false;
  return normalized.map((item) => {
    if (item.completed) {
      return { text: item.text, status: 'completed' as const };
    }
    if (!firstIncompleteSeen) {
      firstIncompleteSeen = true;
      return { text: item.text, status: 'in_progress' as const };
    }
    return { text: item.text, status: 'pending' as const };
  });
}

function extractMcpContentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as { text?: unknown; content?: unknown };
      if (typeof record.text === 'string') return record.text.trim();
      if (typeof record.content === 'string') return record.content.trim();
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(_pendingPerms?: PendingPermissions) {}

  private clearCachedThreadId(sessionId: string): void {
    this.threadIds.delete(sessionId);
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if the installation is incomplete.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is missing from this codex-to-im installation. ' +
        'Reinstall codex-to-im or run npm install in the project root.'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const sandboxMode = normalizeSandboxMode(params.sandboxMode) as CodexSandboxMode;
            const modelReasoningEffort = parseReasoningEffort(params.modelReasoningEffort) as CodexReasoningEffort | undefined;

            const threadOptions: Record<string, unknown> = {
              ...(params.forceModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              sandboxMode,
              ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
              approvalPolicy,
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                if (file.filePath && fs.existsSync(file.filePath)) {
                  parts.push({ type: 'local_image', path: file.filePath });
                  continue;
                }

                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retryFresh = false;
            const emittedToolStarts = new Set<string>();

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              let sawTerminalEvent = false;
              try {
                const { events } = await thread.runStreamed(input, {
                  signal: params.abortController?.signal,
                });

                for await (const event of events as AsyncGenerator<ThreadEvent>) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'turn.started':
                      break;

                    case 'item.started':
                    case 'item.updated':
                    case 'item.completed': {
                      const item = event.item as ThreadItem;
                      self.handleItemEvent(
                        controller,
                        item,
                        event.type === 'item.started'
                          ? 'started'
                          : event.type === 'item.updated'
                            ? 'updated'
                            : 'completed',
                        params.sessionId,
                        emittedToolStarts,
                      );
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      sawTerminalEvent = true;
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { error?: { message?: string } }).error?.message;
                      self.clearCachedThreadId(params.sessionId);
                      controller.enqueue(sseEvent('error', normalizeCodexErrorMessage(error || 'Turn failed')));
                      sawTerminalEvent = true;
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      self.clearCachedThreadId(params.sessionId);
                      controller.enqueue(sseEvent('error', normalizeCodexErrorMessage(error || 'Thread error')));
                      sawTerminalEvent = true;
                      break;
                    }

                    default: {
                      const exhaustiveEvent: never = event;
                      console.warn(
                        '[codex-provider] Unhandled thread event:',
                        stringifyUnknown(exhaustiveEvent),
                      );
                      break;
                    }
                  }

                  if (sawTerminalEvent) {
                    // Codex sometimes emits a terminal turn event but keeps the
                    // iterator open briefly; IM callers should treat the turn
                    // event as authoritative completion instead of waiting
                    // indefinitely for the underlying stream to end.
                    break;
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  self.clearCachedThreadId(params.sessionId);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                self.clearCachedThreadId(params.sessionId);
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            self.clearCachedThreadId(params.sessionId);
            try {
              controller.enqueue(sseEvent('error', normalizeCodexErrorMessage(message)));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a Codex item event to SSE events.
   */
  private handleItemEvent(
    controller: ReadableStreamDefaultController<string>,
    item: ThreadItem,
    phase: 'started' | 'updated' | 'completed',
    sessionId: string,
    emittedToolStarts: Set<string>,
  ): void {
    const itemType = item.type;
    const ensureToolUse = (toolId: string, name: string, input: unknown) => {
      if (emittedToolStarts.has(toolId)) return;
      emittedToolStarts.add(toolId);
      controller.enqueue(sseEvent('tool_use', {
        id: toolId,
        name,
        input,
      }));
    };

    switch (itemType) {
      case 'agent_message': {
        if (phase !== 'completed') break;
        const text = item.text || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = item.id || `tool-${Date.now()}`;
        const command = item.command || '';
        const output = item.aggregated_output || '';
        const exitCode = item.exit_code;
        const status = item.status;
        const isError = exitCode != null && exitCode !== 0;
        const terminal = phase === 'completed' || status === 'completed' || status === 'failed';

        ensureToolUse(toolId, 'Bash', { command });
        if (!terminal) break;

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        if (phase !== 'completed') break;
        const toolId = item.id || `tool-${Date.now()}`;
        const changes = item.changes || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        ensureToolUse(toolId, 'Edit', { files: changes });

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = item.id || `tool-${Date.now()}`;
        const server = item.server || '';
        const tool = item.tool || '';
        const args = item.arguments;
        const result = item.result;
        const error = item.error;
        const status = item.status;
        const terminal = phase === 'completed' || status === 'completed' || status === 'failed';

        const resultText = extractMcpContentText(result?.content)
          || stringifyUnknown(result?.structured_content)
          || stringifyUnknown(result?.content);

        ensureToolUse(toolId, `mcp__${server}__${tool}`, args);
        if (!terminal) break;

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'web_search': {
        const toolId = item.id || `tool-${Date.now()}`;
        const query = item.query || '';
        ensureToolUse(toolId, 'Web Search', { query });
        if (phase !== 'completed') break;
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: query || 'Search completed',
          is_error: false,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = item.text || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }

      case 'todo_list': {
        const tasks = mapTodoListItems(item.items);
        controller.enqueue(sseEvent('task_update', {
          session_id: sessionId,
          sdk_session_id: this.threadIds.get(sessionId) || undefined,
          tasks,
          todos: tasks,
        }));
        break;
      }

      case 'error': {
        this.clearCachedThreadId(sessionId);
        controller.enqueue(sseEvent('error', normalizeCodexErrorMessage(item.message || 'Codex error')));
        break;
      }

      default: {
        const exhaustiveItem: never = item;
        console.warn(
          '[codex-provider] Unhandled thread item:',
          stringifyUnknown(exhaustiveItem),
        );
        break;
      }
    }
  }

  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: ThreadItem,
  ): void {
    this.handleItemEvent(controller, item, 'completed', 'test-session', new Set());
  }
}
