import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { BaseChannelAdapter } from '../lib/bridge/channel-adapter.js';
import type { InboundMessage, OutboundAttachment, OutboundMessage, SendResult } from '../lib/bridge/types.js';
import * as router from '../lib/bridge/channel-router.js';
import { formatInteractiveRuntimeStatus, runInteractiveMessage, type InteractiveTaskState } from '../lib/bridge/interactive-message-runner.js';
import type { ActiveBridgeTurn } from '../lib/bridge/turns/turn-types.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

class FakeFeishuStreamingAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu-default';
  readonly provider = 'feishu';
  readonly streamedTexts: string[] = [];
  readonly streamedStatuses: string[] = [];
  readonly streamEnds: Array<{ status: 'completed' | 'interrupted' | 'error'; text: string }> = [];
  readonly messageStarts: Array<{ chatId: string; streamKey?: string }> = [];
  readonly messageEnds: Array<{ chatId: string; streamKey?: string }> = [];
  readonly sentMessages: OutboundMessage[] = [];
  streamEndResult = false;
  private streamUiActive = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return { ok: true, messageId: 'sent-1' };
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  supportsStructuredStreamingUi(): boolean {
    return true;
  }

  hasActiveStreamingUi(): boolean {
    return this.streamUiActive;
  }

  onMessageStart(chatId: string, streamKey?: string): void {
    this.messageStarts.push({ chatId, streamKey });
  }

  onMessageEnd(chatId: string, streamKey?: string): void {
    this.messageEnds.push({ chatId, streamKey });
  }

  onStreamText(_chatId: string, fullText: string): void {
    this.streamUiActive = true;
    this.streamedTexts.push(fullText);
  }

  onStreamStatus(_chatId: string, statusText: string): void {
    this.streamUiActive = true;
    this.streamedStatuses.push(statusText);
  }

  async onStreamEnd(
    _chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
  ): Promise<boolean> {
    this.streamEnds.push({ status, text: responseText });
    return this.streamEndResult;
  }
}

function createManualIntervalClock(start = 0) {
  let now = start;
  let nextId = 1;
  const intervals = new Map<number, { callback: () => void; intervalMs: number; nextAt: number }>();

  return {
    now: () => now,
    setInterval(callback: () => void, intervalMs: number): number {
      const id = nextId++;
      intervals.set(id, {
        callback,
        intervalMs,
        nextAt: now + intervalMs,
      });
      return id;
    },
    clearInterval(handle: unknown): void {
      intervals.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, interval] of Array.from(intervals.entries())) {
          if (interval.nextAt > now) continue;
          interval.nextAt += interval.intervalMs;
          interval.callback();
          if (!intervals.has(id)) continue;
          fired = true;
        }
      }
    },
    activeCount(): number {
      return intervals.size;
    },
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('interactive-message-runner', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });
  });

  it('formats the persistent runtime status text', () => {
    assert.equal(formatInteractiveRuntimeStatus(0), '处理中');
    assert.equal(formatInteractiveRuntimeStatus(65_000), '已运行 1分5秒');
    assert.equal(formatInteractiveRuntimeStatus(3_661_000, 10_000), '已运行 1小时1分1秒，上次响应距今 10秒');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 70_000), '已运行 1秒，上次响应距今 1分10秒');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_600_000), '已运行 1秒，上次响应距今 1小时');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_610_000), '已运行 1秒，上次响应距今 1小时10秒');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_720_000), '已运行 1秒，上次响应距今 1小时2分');
    assert.equal(formatInteractiveRuntimeStatus(1_000, 3_730_000), '已运行 1秒，上次响应距今 1小时2分10秒');
  });

  it('records a failed health outcome when the final response cannot be delivered', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-delivery-failure',
      userId: 'user-delivery-failure',
    } as const;
    router.createBinding(address, 'D:\\workspace\\delivery-failure');

    const tasks = new Map<string, InteractiveTaskState>();
    const healthEnds: Array<{ outcome: string; detail?: string }> = [];

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-delivery-failure',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) { tasks.set(task.sessionId, task); },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) { return tasks.get(sessionId)?.id === taskId; },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd(_sessionId, outcome, detail) { healthEnds.push({ outcome, detail }); },
        beginMirrorSuppression() { return 'suppression-delivery-failure'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (tasks.get(sessionId)?.id === taskId) tasks.delete(sessionId);
        },
        async deliverResponse() { return { ok: false, error: 'channel unavailable' }; },
        persistSdkSessionUpdate() {},
        processMessageImpl: async () => ({
          responseText: '最终回复',
          outboundAttachments: [],
          tokenUsage: null,
          hasError: false,
          errorMessage: '',
          permissionRequests: [],
          sdkSessionId: 'sdk-delivery-failure',
        }),
      },
    );

    assert.equal(healthEnds.length, 1);
    assert.equal(healthEnds[0]?.outcome, 'failed');
    assert.match(healthEnds[0]?.detail || '', /channel unavailable/);
  });

  it('keeps runtime visible and adds last response age after 10 seconds without a response', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-heartbeat',
      userId: 'user-heartbeat',
    } as const;
    router.createBinding(address, 'D:\\workspace\\heartbeat');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const deliveredTexts: string[] = [];

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-1'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          assert.equal(adapter.streamedStatuses[0], '处理中');
          assert.equal(adapter.streamedStatuses.at(-1), '处理中');

          clock.advance(5_000);
          assert.equal(adapter.streamedStatuses.at(-1), '处理中');

          clock.advance(5_000);
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 10秒，上次响应距今 10秒');

          onPartialText?.('第一段输出\n第二段输出');
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 10秒');

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    assert.deepEqual(deliveredTexts, ['最终回复']);
    assert.equal(adapter.streamEnds.length, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.equal(clock.activeCount(), 0);

    const statusCountAfterFinish = adapter.streamedStatuses.length;
    clock.advance(10_000);
    assert.equal(adapter.streamedStatuses.length, statusCountAfterFinish);
    assert.equal(adapter.messageStarts.length, 1);
    assert.equal(adapter.messageEnds.length, 1);
  });

  it('keeps last response age visible when tool progress updates the status area', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-tool-status-age',
      userId: 'user-tool-status-age',
    } as const;
    router.createBinding(address, 'D:\\workspace\\tool-status-age');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-tool-status-age-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-tool-status-age'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText, onToolEvent) => {
          onPartialText?.('第一段输出');
          clock.advance(10_000);
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 10秒，上次响应距今 10秒');

          clock.advance(5_000);
          onToolEvent?.('tool-1', 'Bash', 'running');
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 15秒，上次响应距今 15秒');

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    assert.equal(clock.activeCount(), 0);
  });

  it('finalizes a hanging task from an external terminal desktop event', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-external-terminal',
      userId: 'user-external-terminal',
    } as const;
    router.createBinding(address, 'D:\\workspace\\external-terminal');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const processStarted = createDeferred<void>();
    const processCleaned = createDeferred<void>();
    let capturedAbortSignal: AbortSignal | undefined;
    const deliveredTexts: string[] = [];
    const healthEnds: Array<{ outcome: string; detail?: string }> = [];

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-external-terminal-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd(_sessionId, outcome, detail) {
          healthEnds.push({ outcome, detail });
        },
        beginMirrorSuppression() { return 'suppression-external-terminal'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, abortSignal, _files, onPartialText) => {
          capturedAbortSignal = abortSignal;
          onPartialText?.('第一段输出');
          processStarted.resolve();
          await new Promise<void>((resolve) => {
            const finish = () => setTimeout(resolve, 0);
            if (abortSignal?.aborted) {
              finish();
            } else {
              abortSignal?.addEventListener('abort', finish, { once: true });
            }
          });
          processCleaned.resolve();
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Task stopped by user',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await processStarted.promise;
    const sessionId = Array.from(taskStateMap.keys())[0];
    assert.ok(sessionId);
    const task = taskStateMap.get(sessionId);
    assert.ok(task?.finalizeFromExternalTerminal);

    const finalized = await task.finalizeFromExternalTerminal(
      'completed',
      '检测到桌面线程已完成当前任务。',
      '桌面最终回复',
    );
    await runPromise;
    await processCleaned.promise;

    assert.equal(finalized, false);
    assert.equal(capturedAbortSignal?.aborted, true);
    assert.deepEqual(adapter.streamEnds, [{ status: 'completed', text: '桌面最终回复' }]);
    assert.deepEqual(deliveredTexts, ['桌面最终回复']);
    assert.deepEqual(healthEnds, [{
      outcome: 'completed',
      detail: '检测到桌面线程已完成当前任务。',
    }]);
    assert.equal(taskStateMap.size, 0);
    assert.equal(clock.activeCount(), 0);
    assert.equal(adapter.messageStarts.length, 1);
    assert.equal(adapter.messageEnds.length, 1);

    const statusCountAfterFinish = adapter.streamedStatuses.length;
    clock.advance(10_000);
    assert.equal(adapter.streamedStatuses.length, statusCountAfterFinish);
  });

  it('sends outbound artifacts when an external terminal event finalizes the stream card', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-external-terminal-artifact',
      userId: 'user-external-terminal-artifact',
    } as const;
    router.createBinding(address, 'D:\\workspace\\external-terminal-artifact');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const processStarted = createDeferred<void>();
    const processCleaned = createDeferred<void>();
    const delivered: Array<{ text: string; attachments: OutboundAttachment[] }> = [];

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-external-terminal-artifact-1',
        address,
        text: 'send image',
        timestamp: clock.now(),
      },
      'send image',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-external-terminal-artifact'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText, _sessionId, _replyTo, attachments = []) {
          delivered.push({ text: responseText, attachments });
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, abortSignal, _files, onPartialText) => {
          onPartialText?.('正在生成截图');
          processStarted.resolve();
          await new Promise<void>((resolve) => {
            const finish = () => setTimeout(resolve, 0);
            if (abortSignal?.aborted) {
              finish();
            } else {
              abortSignal?.addEventListener('abort', finish, { once: true });
            }
          });
          processCleaned.resolve();
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Task stopped by user',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await processStarted.promise;
    const sessionId = Array.from(taskStateMap.keys())[0];
    assert.ok(sessionId);
    const task = taskStateMap.get(sessionId);
    assert.ok(task?.finalizeFromExternalTerminal);

    const finalized = await task.finalizeFromExternalTerminal(
      'completed',
      '检测到桌面线程已完成当前任务。',
      [
        '桌面最终回复',
        '',
        '<cti-send>{"type":"image","path":"D:\\\\workspace\\\\out.png","caption":"截图"}</cti-send>',
      ].join('\n'),
    );
    await runPromise;
    await processCleaned.promise;

    assert.equal(finalized, true);
    assert.deepEqual(adapter.streamEnds, [{ status: 'completed', text: '桌面最终回复' }]);
    assert.deepEqual(delivered, [{
      text: '',
      attachments: [{
        kind: 'image',
        path: 'D:\\workspace\\out.png',
        caption: '截图',
        name: undefined,
      }],
    }]);
    assert.doesNotMatch(adapter.streamEnds[0]?.text || '', /cti-send/);
    assert.equal(taskStateMap.size, 0);
    assert.equal(clock.activeCount(), 0);
  });

  it('merges desktop terminal artifacts when the SDK stream finishes first', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-sdk-first-terminal-artifact',
      userId: 'user-sdk-first-terminal-artifact',
    } as const;
    router.bindToSdkSession(address, 'desktop-thread-sdk-first-terminal-artifact', {
      workingDirectory: 'D:\\workspace\\sdk-first-terminal-artifact',
      displayName: 'Desktop artifact thread',
    });

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const delivered: Array<{ text: string; attachments: OutboundAttachment[] }> = [];
    const terminalFinalizeResult = createDeferred<boolean>();
    let capturedAbortSignal: AbortSignal | undefined;

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-sdk-first-terminal-artifact-1',
        address,
        text: 'send image',
        timestamp: Date.now(),
      },
      'send image',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return ''; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText, _sessionId, _replyTo, attachments = []) {
          delivered.push({ text: responseText, attachments });
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          abortSignal,
          _files,
          onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          onPromptPrepared,
        ) => {
          capturedAbortSignal = abortSignal;
          onPromptPrepared?.('send image');
          onPartialText?.('SDK 流回复');
          setTimeout(() => {
            const task = Array.from(taskStateMap.values())[0];
            if (!task?.finalizeFromExternalTerminal) {
              terminalFinalizeResult.reject(new Error('missing active task'));
              return;
            }
            task.finalizeFromExternalTerminal(
              'completed',
              '检测到桌面线程已完成当前任务。',
              [
                '桌面最终回复',
                '',
                '<cti-send>{"type":"image","path":"D:\\\\workspace\\\\out.png","caption":"截图"}</cti-send>',
              ].join('\n'),
            ).then(terminalFinalizeResult.resolve, terminalFinalizeResult.reject);
          }, 0);
          return {
            responseText: 'SDK 流回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: 'desktop-thread-sdk-first-terminal-artifact',
          };
        },
        desktopTerminalFinalizationTimeoutMs: 50,
      },
    );

    assert.equal(await terminalFinalizeResult.promise, true);
    assert.equal(capturedAbortSignal?.aborted, false);
    assert.deepEqual(adapter.streamEnds, [{ status: 'completed', text: '桌面最终回复' }]);
    assert.deepEqual(delivered, [{
      text: '',
      attachments: [{
        kind: 'image',
        path: 'D:\\workspace\\out.png',
        caption: '截图',
        name: undefined,
      }],
    }]);
    assert.equal(taskStateMap.size, 0);
  });

  it('hands an accepted Desktop turn to mirror when the SDK transport is lost', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-desktop-transport-handoff',
      userId: 'user-desktop-transport-handoff',
    } as const;
    router.bindToSdkSession(address, 'desktop-thread-transport-handoff', {
      workingDirectory: 'D:\\workspace\\transport-handoff',
      displayName: 'Desktop transport handoff',
    });

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const handedOff: string[] = [];
    const settled: string[] = [];
    const aborted: string[] = [];
    const healthEnds: string[] = [];
    const preparedHandoffs: Array<{ sessionId: string; taskId: string; threadId: string; turnId: string }> = [];
    const activatedHandoffs: string[] = [];
    const releasedHandoffs: string[] = [];
    let bridgeTurn: ActiveBridgeTurn | undefined;

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-transport-handoff-1',
        address,
        text: 'continue desktop task',
        timestamp: Date.now(),
      },
      'continue desktop task',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        registerBridgeTurn(turn) {
          bridgeTurn = turn;
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd(_sessionId, outcome) {
          healthEnds.push(outcome);
        },
        beginMirrorSuppression() { return 'suppression-transport-handoff'; },
        abortMirrorSuppression(_sessionId, suppressionId) {
          aborted.push(suppressionId || '');
        },
        handoffMirrorSuppression(_sessionId, suppressionId) {
          handedOff.push(suppressionId || '');
        },
        settleMirrorSuppression(_sessionId, suppressionId) {
          settled.push(suppressionId || '');
        },
        async prepareDesktopHandoffTask(task) {
          preparedHandoffs.push(task);
          return true;
        },
        activateDesktopHandoffTask(_sessionId, taskId) {
          activatedHandoffs.push(taskId);
          return true;
        },
        releaseDesktopHandoffTask(_sessionId, taskId) {
          releasedHandoffs.push(taskId);
        },
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistSdkSessionUpdate() {},
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          _onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          onPromptPrepared,
        ) => {
          onPromptPrepared?.('continue desktop task');
          bridgeTurn?.onDesktopTurnAssociated?.('desktop-turn-transport-handoff');
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Codex 会话恢复失败，上一轮执行进程未正常退出。',
            errorCode: 'desktop_transport_lost',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        desktopTerminalFinalizationTimeoutMs: 1,
      },
    );

    assert.deepEqual(handedOff, ['suppression-transport-handoff']);
    assert.deepEqual(settled, []);
    assert.deepEqual(aborted, []);
    assert.deepEqual(healthEnds, []);
    assert.equal(preparedHandoffs.length, 1);
    assert.equal(preparedHandoffs[0]?.threadId, 'desktop-thread-transport-handoff');
    assert.equal(preparedHandoffs[0]?.turnId, 'desktop-turn-transport-handoff');
    assert.equal(activatedHandoffs.length, 1);
    assert.deepEqual(releasedHandoffs, []);
    assert.equal(adapter.streamEnds.length, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'interrupted');
    assert.match(adapter.streamEnds[0]?.text || '', /已自动切换为桌面镜像接管/);
    assert.match(adapter.streamEnds[0]?.text || '', /发送 \/stop/);
    assert.equal(taskStateMap.size, 0);
  });

  it('does not hand off to mirror when the Desktop transport-loss wait is stopped from IM', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    adapter.streamEndResult = true;
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-desktop-transport-stop',
      userId: 'user-desktop-transport-stop',
    } as const;
    router.bindToSdkSession(address, 'desktop-thread-transport-stop', {
      workingDirectory: 'D:\\workspace\\transport-stop',
      displayName: 'Desktop transport stop',
    });

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const handedOff: string[] = [];
    const aborted: string[] = [];
    const releasedHandoffs: string[] = [];
    let bridgeTurn: ActiveBridgeTurn | undefined;
    let stopPromise: Promise<boolean> | null = null;

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-transport-stop-1',
        address,
        text: 'continue then stop',
        timestamp: Date.now(),
      },
      'continue then stop',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        registerBridgeTurn(turn) {
          bridgeTurn = turn;
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-transport-stop'; },
        abortMirrorSuppression(_sessionId, suppressionId) {
          aborted.push(suppressionId || '');
        },
        handoffMirrorSuppression(_sessionId, suppressionId) {
          handedOff.push(suppressionId || '');
        },
        settleMirrorSuppression() {},
        async prepareDesktopHandoffTask() { return true; },
        activateDesktopHandoffTask() { return true; },
        releaseDesktopHandoffTask(_sessionId, taskId) {
          releasedHandoffs.push(taskId);
        },
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistSdkSessionUpdate() {},
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          _onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          onPromptPrepared,
        ) => {
          onPromptPrepared?.('continue then stop');
          bridgeTurn?.onDesktopTurnAssociated?.('desktop-turn-transport-stop');
          setTimeout(() => {
            const task = [...taskStateMap.values()][0];
            stopPromise = task?.forceStop?.('用户执行 /stop，请求停止当前任务。') || null;
          }, 0);
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Codex 会话恢复失败，上一轮执行进程未正常退出。',
            errorCode: 'desktop_transport_lost',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        desktopTerminalFinalizationTimeoutMs: 100,
      },
    );

    await stopPromise;
    assert.deepEqual(handedOff, []);
    assert.deepEqual(aborted, ['suppression-transport-stop']);
    assert.equal(releasedHandoffs.length, 1);
    assert.equal(adapter.streamEnds.length, 1);
    assert.equal(adapter.streamEnds[0]?.status, 'interrupted');
    assert.doesNotMatch(adapter.streamEnds[0]?.text || '', /已自动切换为桌面镜像接管/);
    assert.equal(taskStateMap.size, 0);
  });

  it('releases provisional Desktop stop control after a normal SDK completion', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-desktop-stop-control-release',
      userId: 'user-desktop-stop-control-release',
    } as const;
    router.bindToSdkSession(address, 'desktop-thread-stop-control-release', {
      workingDirectory: 'D:\\workspace\\stop-control-release',
      displayName: 'Desktop stop control release',
    });

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const releasedHandoffs: string[] = [];
    const activatedHandoffs: string[] = [];
    let bridgeTurn: ActiveBridgeTurn | undefined;

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-stop-control-release',
        address,
        text: 'normal completion',
        timestamp: Date.now(),
      },
      'normal completion',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        registerBridgeTurn(turn) {
          bridgeTurn = turn;
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask() {},
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-normal-release'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        async prepareDesktopHandoffTask() { return true; },
        activateDesktopHandoffTask(_sessionId, taskId) {
          activatedHandoffs.push(taskId);
          return true;
        },
        releaseDesktopHandoffTask(_sessionId, taskId) {
          releasedHandoffs.push(taskId);
        },
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) taskStateMap.delete(sessionId);
        },
        async deliverResponse() {},
        persistSdkSessionUpdate() {},
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          _onPartialText,
          _onToolEvent,
          _onTaskEvent,
          _onStatusNote,
          onPromptPrepared,
        ) => {
          onPromptPrepared?.('normal completion');
          bridgeTurn?.onDesktopTurnAssociated?.('desktop-turn-stop-control-release');
          return {
            responseText: 'done',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: 'desktop-thread-stop-control-release',
          };
        },
      },
    );

    assert.deepEqual(activatedHandoffs, []);
    assert.equal(releasedHandoffs.length, 1);
    assert.equal(taskStateMap.size, 0);
  });

  it('does not show silence before the configured startup threshold', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-threshold',
      userId: 'user-threshold',
    } as const;
    router.createBinding(address, 'D:\\workspace\\threshold');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-threshold-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-threshold'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          assert.equal(adapter.streamedStatuses.at(-1), '处理中');

          clock.advance(30_000);
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 30秒');

          clock.advance(150_000);
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 3分，上次响应距今 3分');

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 180_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );
  });

  it('does not reset last response age when only tool progress is updated', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-tool-age',
      userId: 'user-tool-age',
    } as const;
    router.createBinding(address, 'D:\\workspace\\tool-age');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-tool-age-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-tool-age'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse() {},
        persistSdkSessionUpdate() {},
        processMessageImpl: async (
          _binding,
          _text,
          _onPermission,
          _abortSignal,
          _files,
          onPartialText,
          onToolEvent,
        ) => {
          onPartialText?.('第一段输出');
          clock.advance(180_000);
          onToolEvent?.('tool-1', 'shell_command', 'running');
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 3分，上次响应距今 3分');

          clock.advance(10_000);
          assert.equal(adapter.streamedStatuses.at(-1), '已运行 3分10秒，上次响应距今 3分10秒');

          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 180_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );
  });

  it('skips normal text delivery when the structured stream UI already finalized the reply', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-card-final',
      userId: 'user-card-final',
    } as const;
    router.createBinding(address, 'D:\\workspace\\card-final');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];

    adapter.onStreamEnd = async (
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
    ): Promise<boolean> => {
      adapter.streamEnds.push({ status, text: responseText });
      return true;
    };

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-card-final-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-card-final'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
      },
    );

    assert.deepEqual(deliveredTexts, []);
    assert.equal(adapter.streamEnds.length, 1);
    assert.deepEqual(adapter.streamEnds[0], { status: 'completed', text: '最终回复' });
  });

  it('finalizes a stopped structured stream as interrupted without sending an error reply', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-stop',
      userId: 'user-stop',
    } as const;
    router.createBinding(address, 'D:\\workspace\\stop');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];

    adapter.onStreamEnd = async (
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
    ): Promise<boolean> => {
      adapter.streamEnds.push({ status, text: responseText });
      return true;
    };

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-stop-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-stop'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (binding) => {
          const task = taskStateMap.get(binding.codepilotSessionId);
          task?.abortController.abort();
          return {
            responseText: '',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: true,
            errorMessage: 'Task stopped by user',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
      },
    );

    assert.deepEqual(adapter.streamEnds, [{ status: 'interrupted', text: '' }]);
    assert.deepEqual(deliveredTexts, []);
  });

  it('sends a stale task notice instead of the old reply when the chat binding has switched', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      channelAlias: '飞书',
      chatId: 'chat-stale-task',
      userId: 'user-stale-task',
      displayName: '旧任务',
    } as const;
    router.createBinding(address, 'D:\\workspace\\old-task');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const deliveredTexts: string[] = [];

    await runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-stale-1',
        address,
        text: 'hello',
        timestamp: Date.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = Date.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-stale'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('旧会话流式内容');
          router.createBinding(address, 'D:\\workspace\\new-task');
          return {
            responseText: '旧会话最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
      },
    );

    assert.equal(deliveredTexts.length, 1);
    assert.match(deliveredTexts[0] || '', /旧会话「旧任务」任务已结束/);
    assert.match(deliveredTexts[0] || '', /当前聊天已切换到其他会话，回复已跳过/);
    assert.doesNotMatch(deliveredTexts[0] || '', /旧会话最终回复/);
    assert.equal(adapter.streamEnds[0]?.status, 'completed');
    assert.match(adapter.streamEnds[0]?.text || '', /旧会话「旧任务」任务已结束/);
  });

  it('stops the runtime heartbeat before stream finalization begins', async () => {
    const adapter = new FakeFeishuStreamingAdapter();
    const address = {
      channelType: 'feishu-default',
      channelProvider: 'feishu',
      chatId: 'chat-finalize',
      userId: 'user-finalize',
    } as const;
    router.createBinding(address, 'D:\\workspace\\finalize');

    const taskStateMap = new Map<string, InteractiveTaskState>();
    const clock = createManualIntervalClock();
    const deliveredTexts: string[] = [];
    const finalizeStarted = createDeferred<void>();
    const releaseFinalize = createDeferred<void>();

    adapter.onStreamEnd = async (
      _chatId: string,
      status: 'completed' | 'interrupted' | 'error',
      responseText: string,
    ): Promise<boolean> => {
      adapter.streamEnds.push({ status, text: responseText });
      finalizeStarted.resolve();
      clock.advance(10_000);
      await releaseFinalize.promise;
      return false;
    };

    const runPromise = runInteractiveMessage(
      adapter,
      {
        messageId: 'incoming-finalize-1',
        address,
        text: 'hello',
        timestamp: clock.now(),
      },
      'hello',
      undefined,
      {
        registerInteractiveTask(task) {
          taskStateMap.set(task.sessionId, task);
        },
        resetMirrorSessionForInteractiveRun() {},
        isCurrentInteractiveTask(sessionId, taskId) {
          return taskStateMap.get(sessionId)?.id === taskId;
        },
        touchInteractiveTask(sessionId, taskId) {
          const task = taskStateMap.get(sessionId);
          if (task?.id !== taskId) return;
          task.lastActivityAt = clock.now();
        },
        recordInteractiveHealthStart() {},
        recordInteractiveHealthProgress() {},
        recordInteractiveHealthTool() {},
        recordInteractiveHealthEnd() {},
        beginMirrorSuppression() { return 'suppression-finalize'; },
        abortMirrorSuppression() {},
        settleMirrorSuppression() {},
        releaseInteractiveTask(sessionId, taskId) {
          if (taskStateMap.get(sessionId)?.id === taskId) {
            taskStateMap.delete(sessionId);
          }
        },
        async deliverResponse(_adapter, _address, responseText) {
          deliveredTexts.push(responseText);
        },
        persistSdkSessionUpdate() {},
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          return {
            responseText: '最终回复',
            outboundAttachments: [],
            tokenUsage: null,
            hasError: false,
            errorMessage: '',
            permissionRequests: [],
            sdkSessionId: null,
          };
        },
        nowMs: () => clock.now(),
        setIntervalFn: (callback, intervalMs) => clock.setInterval(callback, intervalMs),
        clearIntervalFn: (handle) => clock.clearInterval(handle),
        streamStatusIdleDetectionStartMs: 10_000,
        streamStatusHeartbeatMs: 10_000,
      },
    );

    await finalizeStarted.promise;
    const statusCountWhileFinalizing = adapter.streamedStatuses.length;
    releaseFinalize.resolve();
    await runPromise;

    assert.equal(adapter.streamedStatuses.length, statusCountWhileFinalizing);
    assert.deepEqual(deliveredTexts, ['最终回复']);
    assert.equal(clock.activeCount(), 0);
  });
});
