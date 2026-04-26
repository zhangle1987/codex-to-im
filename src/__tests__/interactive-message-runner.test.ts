import './test-setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../lib/bridge/context.js';
import { BaseChannelAdapter } from '../lib/bridge/channel-adapter.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../lib/bridge/types.js';
import * as router from '../lib/bridge/channel-router.js';
import { formatInteractiveRuntimeStatus, runInteractiveMessage, type InteractiveTaskState } from '../lib/bridge/interactive-message-runner.js';

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
  private streamUiActive = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  consumeOne(): Promise<InboundMessage | null> { return Promise.resolve(null); }
  async send(_message: OutboundMessage): Promise<SendResult> {
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
    return false;
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
    const neverFinish = createDeferred<{
      responseText: string;
      outboundAttachments: [];
      tokenUsage: null;
      hasError: boolean;
      errorMessage: string;
      permissionRequests: [];
      sdkSessionId: null;
    }>();
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
        processMessageImpl: async (_binding, _text, _onPermission, _abortSignal, _files, onPartialText) => {
          onPartialText?.('第一段输出');
          processStarted.resolve();
          return neverFinish.promise;
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

    assert.equal(finalized, false);
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
