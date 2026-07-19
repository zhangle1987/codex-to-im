/**
 * Conversation Engine — processes inbound IM messages through the configured LLM provider.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding, OutboundAttachment, TaskProgressInfo } from './types.js';
import type {
  BridgeSession,
  FileAttachment,
  MessageContentBlock,
  SSEEvent,
  TokenUsage,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';
import {
  collectFinalResponseArtifacts,
  dedupeOutboundAttachments,
} from './turns/final-response-artifacts.js';
import {
  normalizeReasoningEffort,
  normalizeSandboxMode,
  type RuntimeReasoningEffort,
} from '../../runtime-options.js';
import { consumeSseEvents } from './sse-stream-decoder.js';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;
export type OnTaskEvent = (tasks: TaskProgressInfo[]) => void;
export type OnStatusNote = (note: string | null) => void;

export type ConversationErrorCode = 'session_busy';

const MAX_INBOUND_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES = 120 * 1024 * 1024;

export function validateInboundAttachmentSizes(
  files: FileAttachment[] | undefined,
  maxFileBytes = MAX_INBOUND_ATTACHMENT_BYTES,
  maxTotalBytes = MAX_INBOUND_ATTACHMENTS_TOTAL_BYTES,
): string | null {
  if (!files || files.length === 0) return null;

  let totalBytes = 0;
  for (const file of files) {
    const encodedSize = typeof file.data === 'string'
      ? Buffer.byteLength(file.data, 'base64')
      : 0;
    const fileSize = Math.max(0, Number(file.size) || 0, encodedSize);
    if (fileSize > maxFileBytes) {
      return `Attachment "${file.name}" is too large (${fileSize} bytes; max ${maxFileBytes} bytes).`;
    }
    totalBytes += fileSize;
    if (totalBytes > maxTotalBytes) {
      return `Attachments are too large in total (${totalBytes} bytes; max ${maxTotalBytes} bytes).`;
    }
  }
  return null;
}

export interface ConversationResult {
  responseText: string;
  outboundAttachments: OutboundAttachment[];
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  errorCode?: ConversationErrorCode;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

const DEFAULT_DESKTOP_BUSY_RETRY_DELAYS_MS = [
  5_000,
  10_000,
  15_000,
  30_000,
  30_000,
];

export function isSessionBusyErrorMessage(message: string | null | undefined): boolean {
  return (message || '').toLowerCase().includes('session is busy processing another request');
}

function isDesktopBackedSessionForBusyRetry(session: BridgeSession | null): boolean {
  if (session?.thread_origin !== 'desktop') return false;
  return Boolean(session.desktop_thread_id || session.sdk_session_id || session.codex_thread_id);
}

function getDesktopBusyRetryDelaysMs(): number[] {
  const configured = process.env.CTI_DESKTOP_BUSY_RETRY_DELAYS_MS;
  if (!configured?.trim()) return DEFAULT_DESKTOP_BUSY_RETRY_DELAYS_MS;

  const delays = configured
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return delays.length > 0 ? delays : DEFAULT_DESKTOP_BUSY_RETRY_DELAYS_MS;
}

function isRetryableDesktopBusyResult(result: ConversationResult): boolean {
  return result.hasError
    && (result.errorCode === 'session_busy' || isSessionBusyErrorMessage(result.errorMessage))
    && !result.responseText.trim()
    && result.outboundAttachments.length === 0
    && result.permissionRequests.length === 0;
}

function formatDesktopBusyRetryNote(attempt: number, maxAttempts: number, delayMs: number): string {
  const delaySeconds = Math.ceil(delayMs / 1000);
  const delayText = delaySeconds > 0 ? `${delaySeconds} 秒后` : '马上';
  return `Codex Desktop thread 仍在处理上一轮请求，${delayText}重试（${attempt}/${maxAttempts}）。`;
}

function buildDesktopBusyExhaustedMessage(originalMessage: string): string {
  const detail = originalMessage?.trim();
  return detail
    ? `Codex Desktop thread 仍在处理上一轮请求，请稍后重试。原始错误：${detail}`
    : 'Codex Desktop thread 仍在处理上一轮请求，请稍后重试。';
}

function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (completed: boolean) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveReasoningEffort(
  store: ReturnType<typeof getBridgeContext>['store'],
  session: BridgeSession | null,
): RuntimeReasoningEffort {
  return normalizeReasoningEffort(
    session?.reasoning_effort || store.getSetting('bridge_codex_reasoning_effort'),
  );
}

interface PersistedAttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  filePath: string;
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function buildLocalAttachmentPromptSupplement(files: PersistedAttachmentMeta[]): string {
  const nonImageFiles = files.filter((file) => !file.type.startsWith('image/'));
  if (nonImageFiles.length === 0) return '';

  const hasVideo = nonImageFiles.some((file) => file.type.startsWith('video/'));
  const lines = [
    'Attached local files:',
    'The user included non-image attachments. They have already been downloaded locally.',
    'If they are relevant, inspect them directly from disk using the available local tools.',
  ];

  if (hasVideo) {
    lines.push('For video files, inspect metadata first and extract frames or audio only when needed.');
  }

  lines.push('');
  for (const [index, file] of nonImageFiles.entries()) {
    lines.push(
      `${index + 1}. ${file.name} (${file.type || 'application/octet-stream'}, ${formatAttachmentSize(file.size)})`,
    );
    lines.push(`   path: ${file.filePath}`);
  }

  return lines.join('\n');
}

export function buildConversationPromptText(text: string, files: PersistedAttachmentMeta[] = []): string {
  const attachmentSupplement = buildLocalAttachmentPromptSupplement(files);
  if (!attachmentSupplement) return text;
  return text.trim() ? `${text}\n\n${attachmentSupplement}` : attachmentSupplement;
}

/**
 * Process an inbound message: send to the LLM provider, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  onTaskEvent?: OnTaskEvent,
  onStatusNote?: OnStatusNote,
  onPromptPrepared?: (promptText: string) => void,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.codepilotSessionId;

  const attachmentValidationError = validateInboundAttachmentSizes(files);
  if (attachmentValidationError) {
    return {
      responseText: '',
      outboundAttachments: [],
      tokenUsage: null,
      hasError: true,
      errorMessage: attachmentValidationError,
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      outboundAttachments: [],
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      errorCode: 'session_busy',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);
    const workDir = binding.workingDirectory || session?.working_directory || '';
    const sandboxMode = normalizeSandboxMode(store.getSetting('bridge_codex_sandbox_mode'));
    const modelReasoningEffort = resolveReasoningEffort(store, session);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    let llmFiles = files;
    let persistedFileMeta: PersistedAttachmentMeta[] = [];
    if (files && files.length > 0) {
      if (workDir) {
        const createdFilePaths: string[] = [];
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${crypto.randomUUID()}-${safeName || 'attachment.bin'}`);
            const buffer = Buffer.from(f.data, 'base64');
            if (buffer.length > MAX_INBOUND_ATTACHMENT_BYTES) {
              throw new Error(`Attachment "${f.name}" exceeds the maximum size after decoding`);
            }
            fs.writeFileSync(filePath, buffer);
            createdFilePaths.push(filePath);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          persistedFileMeta = fileMeta;
          llmFiles = files.map((file) => {
            const persisted = fileMeta.find((item) => item.id === file.id);
            return persisted ? { ...file, size: persisted.size, filePath: persisted.filePath } : file;
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          for (const filePath of createdFilePaths) {
            try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
          }
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} attachment(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} attachment(s) attached] ${text}`;
      }
    }
    store.addMessage(sessionId, 'user', savedContent);

    const promptText = buildConversationPromptText(text, persistedFileMeta);
    onPromptPrepared?.(promptText);
    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const desktopBusyRetryDelaysMs = isDesktopBackedSessionForBusyRetry(session)
      ? getDesktopBusyRetryDelaysMs()
      : [];
    let desktopBusyRetryCount = 0;

    while (true) {
      const stream = llm.streamChat({
        prompt: promptText,
        sessionId,
        sdkSessionId: binding.sdkSessionId || undefined,
        model: effectiveModel,
        forceModel: !binding.sdkSessionId && Boolean(effectiveModel),
        sandboxMode,
        modelReasoningEffort,
        systemPrompt: session?.system_prompt || undefined,
        workingDirectory: workDir || undefined,
        abortController,
        permissionMode,
        provider: resolvedProvider,
        conversationHistory: historyMsgs,
        files: llmFiles,
        onRuntimeStatusChange: (status: string) => {
          try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
        },
      });

      // Consume the stream server-side (replicate collectStreamResponse pattern).
      // Permission requests are forwarded immediately via the callback during streaming
      // because the stream blocks until the permission is resolved.
      const result = await consumeStream(
        stream,
        sessionId,
        onPermissionRequest,
        onPartialText,
        onToolEvent,
        onTaskEvent,
        onStatusNote,
      );

      if (!isRetryableDesktopBusyResult(result) || desktopBusyRetryDelaysMs.length === 0) {
        return result;
      }

      if (desktopBusyRetryCount >= desktopBusyRetryDelaysMs.length) {
        return {
          ...result,
          errorMessage: buildDesktopBusyExhaustedMessage(result.errorMessage),
        };
      }

      const delayMs = desktopBusyRetryDelaysMs[desktopBusyRetryCount];
      desktopBusyRetryCount += 1;
      onStatusNote?.(formatDesktopBusyRetryNote(
        desktopBusyRetryCount,
        desktopBusyRetryDelaysMs.length,
        delayMs,
      ));

      const shouldRetry = await waitForRetryDelay(delayMs, abortController.signal);
      if (!shouldRetry) {
        return {
          ...result,
          errorMessage: 'Task stopped by user',
          errorCode: undefined,
        };
      }
    }
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  onTaskEvent?: OnTaskEvent,
  onStatusNote?: OnStatusNote,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let errorCode: ConversationErrorCode | undefined;
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;

  const finalizeConsumedContent = (): {
    responseText: string;
    outboundAttachments: OutboundAttachment[];
  } => {
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
      currentText = '';
    }

    const outboundAttachments: OutboundAttachment[] = [];
    for (const block of contentBlocks) {
      if (block.type !== 'text') continue;
      const parsed = collectFinalResponseArtifacts(block.text);
      block.text = parsed.text;
      outboundAttachments.push(...parsed.attachments);
    }

    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (block) => block.type === 'tool_use' || block.type === 'tool_result',
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((block): block is Extract<MessageContentBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    return {
      responseText: contentBlocks
        .filter((block): block is Extract<MessageContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim(),
      outboundAttachments: dedupeOutboundAttachments(outboundAttachments),
    };
  };

  try {
    await consumeSseEvents(stream, async (event: SSEEvent) => {
      switch (event.type) {
        case 'text':
          currentText += event.data;
          if (onPartialText) {
            previewText += event.data;
            try { onPartialText(previewText); } catch { /* non-critical */ }
          }
          break;

        case 'tool_use': {
          if (currentText.trim()) {
            contentBlocks.push({ type: 'text', text: currentText });
            currentText = '';
          }
          try {
            const toolData = JSON.parse(event.data);
            contentBlocks.push({
              type: 'tool_use',
              id: toolData.id,
              name: toolData.name,
              input: toolData.input,
            });
            if (onToolEvent) {
              try { onToolEvent(toolData.id, toolData.name, 'running'); } catch { /* non-critical */ }
            }
          } catch { /* skip */ }
          break;
        }

        case 'tool_result': {
          try {
            const resultData = JSON.parse(event.data);
            const newBlock = {
              type: 'tool_result' as const,
              tool_use_id: resultData.tool_use_id,
              content: resultData.content,
              is_error: resultData.is_error || false,
            };
            if (seenToolResultIds.has(resultData.tool_use_id)) {
              const idx = contentBlocks.findIndex(
                (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
              );
              if (idx >= 0) contentBlocks[idx] = newBlock;
            } else {
              seenToolResultIds.add(resultData.tool_use_id);
              contentBlocks.push(newBlock);
            }
            if (onToolEvent) {
              try {
                onToolEvent(
                  resultData.tool_use_id,
                  '',
                  resultData.is_error ? 'error' : 'complete',
                );
              } catch { /* non-critical */ }
            }
          } catch { /* skip */ }
          break;
        }

        case 'permission_request': {
          try {
            const permData = JSON.parse(event.data);
            const perm: PermissionRequestInfo = {
              permissionRequestId: permData.permissionRequestId,
              toolName: permData.toolName,
              toolInput: permData.toolInput,
              suggestions: permData.suggestions,
            };
            permissionRequests.push(perm);
            if (onPermissionRequest) {
              onPermissionRequest(perm).catch((err) => {
                console.error('[conversation-engine] Failed to forward permission request:', err);
              });
            }
          } catch { /* skip */ }
          break;
        }

        case 'status': {
          try {
            const statusData = JSON.parse(event.data);
            if (statusData.session_id) {
              capturedSdkSessionId = statusData.session_id;
              store.updateSdkSessionId(sessionId, statusData.session_id);
            }
            if (statusData.model) {
              store.updateSessionModel(sessionId, statusData.model);
            }
            if (typeof statusData.reasoning === 'string' && onStatusNote) {
              try { onStatusNote(statusData.reasoning); } catch { /* non-critical */ }
            }
          } catch { /* skip */ }
          break;
        }

        case 'task_update': {
          try {
            const taskData = JSON.parse(event.data);
            const tasks = Array.isArray(taskData.tasks)
              ? taskData.tasks
              : (Array.isArray(taskData.todos) ? taskData.todos : null);
            if (tasks) {
              store.syncSdkTasks(sessionId, tasks);
              if (onTaskEvent) {
                try { onTaskEvent(tasks as TaskProgressInfo[]); } catch { /* non-critical */ }
              }
            }
          } catch { /* skip */ }
          break;
        }

        case 'error':
          hasError = true;
          errorMessage = event.data || 'Unknown error';
          if (isSessionBusyErrorMessage(errorMessage)) {
            errorCode = 'session_busy';
          }
          break;

        case 'result': {
          try {
            const resultData = JSON.parse(event.data);
            if (resultData.usage) tokenUsage = resultData.usage;
            if (resultData.is_error) hasError = true;
            if (resultData.session_id) {
              capturedSdkSessionId = resultData.session_id;
              store.updateSdkSessionId(sessionId, resultData.session_id);
            }
          } catch { /* skip */ }
          break;
        }

        // tool_output, tool_timeout, mode_changed, done — ignored for bridge
      }
    });

    const finalizedContent = finalizeConsumedContent();

    return {
      responseText: finalizedContent.responseText,
      outboundAttachments: finalizedContent.outboundAttachments,
      tokenUsage,
      hasError,
      errorMessage,
      errorCode,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    const finalizedContent = finalizeConsumedContent();

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';
    const fallbackErrorMessage = isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error');

    return {
      responseText: finalizedContent.responseText,
      outboundAttachments: finalizedContent.outboundAttachments,
      tokenUsage,
      hasError: true,
      errorMessage: fallbackErrorMessage,
      errorCode: isSessionBusyErrorMessage(fallbackErrorMessage) ? 'session_busy' : undefined,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}
