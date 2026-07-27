import { getOrCreateDraftSession } from '../../internal-sessions.js';
import { isCliOnlyCodexModel, readConfiguredCodexModel } from '../../codex-models.js';
import {
  buildHealthCommandResponse,
  buildHealthListResponse,
  buildCommandFields,
  buildDesktopThreadsCommandResponse,
  DEFAULT_DESKTOP_THREAD_LIST_LIMIT,
  formatCommandDateTime,
  formatCommandPath,
  formatHistoryRole,
  formatMirrorStatus,
  formatRuntimeStatus,
  formatStoredMessageContent,
  formatReasoningEffort,
  getSessionDisplayName,
  MAX_DESKTOP_THREAD_LIST_LIMIT,
  normalizeReasoningEffort,
  parseDesktopThreadListArgs,
  resolveByIndexOrPrefix,
  resolveCommandAlias,
  toUserVisibleBindingError,
  truncateHistoryContent,
} from './command-helpers.js';
import { getBridgeContext } from './context.js';
import { deliverBridgeNotice } from './feedback-delivery.js';
import * as broker from './permission-broker.js';
import * as router from './channel-router.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { BridgeSession } from './host.js';
import type { ChannelBinding, InboundMessage } from './types.js';
import { recordBindingChange, type BindingChangeAction } from './binding-audit.js';
import { isDangerousInput, validateMode, validateSessionId } from './security/validators.js';
import {
  ensureWorkingDirectoryExists,
  formatDisplayedModel,
  getAvailableModelChoicesText,
  getDesktopSessionByThreadIdSafe,
  getDesktopThreadTitle,
  getDisplayedDesktopThreads,
  getHistoryMessageLimit,
  getSelectableCodexModel,
  resetDraftSession,
  resolveDisplayedModel,
  resolveEffectiveReasoningEffort,
  resolveEffectiveSandboxMode,
  resolveNewSessionWorkingDirectory,
} from './bridge-session-support.js';
import {
  formatBindingChatLabel,
  getFeedbackParseMode,
} from './bridge-channel-runtime.js';
import { readDesktopSessionMessages } from '../../desktop-sessions.js';
import { getExplicitDesktopThreadId } from './turns/turn-classifier.js';

const MODE_OPTIONS_TEXT = '可选：`code`（直接执行，默认） `plan`（先分析再行动） `ask`（轻对话 / 草稿）';
const REASONING_OPTIONS_TEXT = '可选：`low` `medium` `high` `xhigh`；数字兼容：`1=minimal` `2=low` `3=medium` `4=high` `5=xhigh`，旧值 `6`、`7` 会按 `xhigh` 处理';

function parseForceFlag(args: string): { args: string; force: boolean } {
  const forcePattern = /(^|\s)--force(?=\s|$)/;
  const force = forcePattern.test(args);
  const cleaned = args.replace(/(^|\s)--force(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return { args: cleaned, force };
}

function buildActiveTaskSwitchBlockedResponse(
  store: ReturnType<typeof getBridgeContext>['store'],
  binding: ChannelBinding,
  markdown: boolean,
): string {
  const session = store.getSession(binding.codepilotSessionId);
  return buildCommandFields(
    '当前会话仍在运行',
    [
      ['标题', getSessionDisplayName(session, binding.workingDirectory)],
      ['Session', binding.codepilotSessionId],
    ],
    [
      '为避免旧任务完成后把回复发到已经切走的聊天，当前不直接切换绑定。',
      '请先发送 `/stop` 停止当前任务；如果确认要强制切换，请在原命令末尾加 `--force`。',
    ],
    markdown,
  );
}

function guardBindingChangeWhileRunning(
  store: ReturnType<typeof getBridgeContext>['store'],
  binding: ChannelBinding | null,
  force: boolean,
  deps: BridgeCommandDispatchDeps,
  markdown: boolean,
): string | null {
  if (!binding || force) return null;
  return deps.getActiveTask(binding.codepilotSessionId)
    ? buildActiveTaskSwitchBlockedResponse(store, binding, markdown)
    : null;
}

function auditCommandBindingChange(
  action: BindingChangeAction,
  msg: InboundMessage,
  fromBinding: ChannelBinding | null | undefined,
  toBinding: ChannelBinding | null | undefined,
  reason?: string,
): void {
  recordBindingChange(getBridgeContext().store, {
    action,
    address: msg.address,
    fromBinding,
    toBinding,
    messageId: msg.messageId,
    source: 'im_command',
    reason,
  });
}

export interface BridgeCommandDispatchDeps {
  getActiveTask(sessionId: string): { abortController: AbortController } | undefined;
  forceStopSession?(sessionId: string, detail?: string): Promise<ForceStopSessionResult>;
  recordInteractiveHealthEnd?(sessionId: string, outcome: 'completed' | 'failed' | 'aborted', detail?: string): void;
  diagnoseSessionHealth(sessionId: string): Promise<import('./session-health-runtime.js').SessionHealthDiagnosis | null>;
  diagnoseAllActiveSessions(): Promise<import('./session-health-runtime.js').SessionHealthDiagnosis[]>;
}

export type ForceStopSessionResult =
  | { status: 'stopped'; detail?: string }
  | { status: 'stop_requested'; detail?: string }
  | { status: 'not_running'; detail?: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'failed'; detail: string };

export async function handleBridgeCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  deps: BridgeCommandDispatchDeps,
): Promise<void> {
  const { store } = getBridgeContext();

  const parts = text.split(/\s+/);
  const rawCommand = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();
  const command = resolveCommandAlias(rawCommand, args);

  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliverBridgeNotice(adapter, msg.address, '命令被拒绝：检测到无效输入。', {
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let responseParseMode: 'Markdown' | 'plain' = getFeedbackParseMode(adapter.channelType);
  let auditResponse = true;
  const currentBinding = store.getChannelBinding(msg.address.channelType, msg.address.chatId);

  switch (command) {
    case '/start':
      response = [
        'Codex to IM',
        '',
        '直接发送文本，就会继续当前聊天绑定的会话。',
        '',
        '常用流程',
        '1. /t 查看最近桌面会话',
        '2. /t 1 接管第 1 条桌面会话',
        '3. 之后直接发消息即可继续这条会话',
        '',
        '发送 /h 查看完整说明。',
      ].join('\n');
      break;

    case '/new': {
      const parsedArgs = parseForceFlag(args);
      const blocked = guardBindingChangeWhileRunning(
        store,
        currentBinding,
        parsedArgs.force,
        deps,
        responseParseMode === 'Markdown',
      );
      if (blocked) {
        response = blocked;
        break;
      }
      const currentSession = currentBinding
        ? store.getSession(currentBinding.codepilotSessionId)
        : null;
      const resolved = resolveNewSessionWorkingDirectory(parsedArgs.args, currentBinding, currentSession);
      if (!resolved.ok) {
        response = resolved.message;
        break;
      }

      const workDir = resolved.workDir;
      ensureWorkingDirectoryExists(workDir);
      const binding = router.createBinding(msg.address, workDir);
      const session = store.getSession(binding.codepilotSessionId);
      auditCommandBindingChange(
        'new_session',
        msg,
        currentBinding,
        binding,
        parsedArgs.force ? 'forced' : undefined,
      );
      response = buildCommandFields(
        '已新建会话',
        [
          ['标题', getSessionDisplayName(session, binding.workingDirectory)],
          ['目录', formatCommandPath(binding.workingDirectory)],
          ['模式', binding.mode],
        ],
        [
          parsedArgs.args.trim() ? '接下来直接发送文本即可继续。' : '已在当前工作目录下新建一个线程。接下来直接发送文本即可继续。',
          '如果当前聊天里已有旧任务在运行，它不会被终止，仍会在后台继续执行并可能稍后回消息。',
          '这是 IM 侧线程，当前只保证在 IM 中可继续；不会自动出现在 Codex Desktop 会话列表中。',
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/thread': {
      const parsedArgs = parseForceFlag(args);
      const threadArgs = parsedArgs.args;
      if (threadArgs === '0' || threadArgs === '0 reset') {
        const blocked = guardBindingChangeWhileRunning(
          store,
          currentBinding,
          parsedArgs.force,
          deps,
          responseParseMode === 'Markdown',
        );
        if (blocked) {
          response = blocked;
          break;
        }
        const draftSession = threadArgs === '0 reset'
          ? resetDraftSession(msg.address)
          : getOrCreateDraftSession(store, msg.address);
        const binding = router.bindToSession(msg.address, draftSession.id);
        if (!binding) {
          response = '草稿线程切换失败。';
          break;
        }
        router.updateBinding(binding.id, {
          mode: 'ask',
          workingDirectory: draftSession.working_directory,
          model: draftSession.model || binding.model,
        });
        const updatedBinding = store.getChannelBinding(msg.address.channelType, msg.address.chatId) || binding;
        auditCommandBindingChange(
          'switch_draft',
          msg,
          currentBinding,
          updatedBinding,
          [
            threadArgs === '0 reset' ? 'reset' : null,
            parsedArgs.force ? 'forced' : null,
          ].filter(Boolean).join(', ') || undefined,
        );
        response = buildCommandFields(
          threadArgs === '0 reset' ? '已重置临时草稿线程' : '已切换到临时草稿线程',
          [
            ['标题', getSessionDisplayName(draftSession, draftSession.working_directory)],
            ['目录', formatCommandPath(draftSession.working_directory)],
            ['过期时间', formatCommandDateTime(draftSession.expires_at)],
            ['模式', 'ask'],
          ],
          ['这是隐藏的草稿线程，不会出现在常规会话列表中。'],
          responseParseMode === 'Markdown',
        );
        break;
      }

      if (!threadArgs) {
        response = `用法：/thread <序号>，或 /thread 0 进入临时草稿线程；发送 /t all 查看最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条，或 /t n 100 查看最近 100 条桌面会话`;
        break;
      }
      if (threadArgs === 'all') {
        const desktopSessions = getDisplayedDesktopThreads(MAX_DESKTOP_THREAD_LIST_LIMIT);
        if (!desktopSessions) {
          response = '读取桌面会话列表失败，请稍后重试。';
          break;
        }
        if (desktopSessions.length === 0) {
          response = '没有找到桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。';
          break;
        }
        response = buildDesktopThreadsCommandResponse(
          desktopSessions,
          responseParseMode === 'Markdown',
          true,
        );
        break;
      }

      const blocked = guardBindingChangeWhileRunning(
        store,
        currentBinding,
        parsedArgs.force,
        deps,
        responseParseMode === 'Markdown',
      );
      if (blocked) {
        response = blocked;
        break;
      }

      const displayedThreads = getDisplayedDesktopThreads(MAX_DESKTOP_THREAD_LIST_LIMIT);
      if (!displayedThreads) {
        response = '读取桌面会话列表失败，请稍后重试。';
        break;
      }
      const threadPick = resolveByIndexOrPrefix(threadArgs, displayedThreads, (session) => session.threadId);
      if (threadPick.ambiguous) {
        response = '匹配到多个桌面会话，请先发送 `/t` 查看列表，再用 `/t 1` 这种序号切换。';
        break;
      }
      if (!threadPick.match) {
        if (validateSessionId(threadArgs)) {
          const desktop = getDesktopSessionByThreadIdSafe(threadArgs, 'thread switch');
          let binding: ReturnType<typeof router.bindToSdkSession>;
          try {
            binding = router.bindToSdkSession(msg.address, threadArgs, desktop ? {
              workingDirectory: desktop.cwd,
              displayName: desktop.title,
            } : undefined);
          } catch (error) {
            response = toUserVisibleBindingError(error, '切换桌面会话失败。');
            break;
          }
          auditCommandBindingChange(
            'switch_desktop',
            msg,
            currentBinding,
            binding,
            parsedArgs.force ? 'forced' : undefined,
          );
          const session = store.getSession(binding.codepilotSessionId);
          response = buildCommandFields(
            '已切换到桌面会话',
            [
              ['标题', desktop?.title || getSessionDisplayName(session, binding.workingDirectory)],
              ['目录', formatCommandPath(binding.workingDirectory)],
            ],
            ['接下来直接发送文本即可继续。'],
            responseParseMode === 'Markdown',
          );
          break;
        }
        if (threadPick.index !== undefined) {
          response = displayedThreads.length > 0
            ? `当前只找到 ${displayedThreads.length} 条桌面会话，没有第 ${threadPick.index} 条。先发送 \`/t\` 查看最近会话，或发送 \`/t all\` 查看更多后再选择。`
            : '没有找到桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。';
          break;
        }
        response = '没有找到对应的桌面会话。先发送 `/t` 查看最近会话，再用 `/t 1` 接管。';
        break;
      }
      let binding: ReturnType<typeof router.bindToSdkSession>;
      try {
        binding = router.bindToSdkSession(msg.address, threadPick.match.threadId, {
          workingDirectory: threadPick.match.cwd,
          displayName: threadPick.match.title,
        });
      } catch (error) {
        response = toUserVisibleBindingError(error, '切换桌面会话失败。');
        break;
      }
      auditCommandBindingChange(
        'switch_desktop',
        msg,
        currentBinding,
        binding,
        parsedArgs.force ? 'forced' : undefined,
      );
      response = buildCommandFields(
        '已切换到桌面会话',
        [
          ['标题', threadPick.match.title || '未命名线程'],
          ['目录', formatCommandPath(binding.workingDirectory)],
        ],
        ['接下来直接发送文本即可继续。'],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/threads': {
      const listArgs = parseDesktopThreadListArgs(args);
      if (!listArgs) {
        response = `用法：/threads、/threads all、/threads n 100（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）`;
        break;
      }
      const { showAll, limit } = listArgs;
      const desktopSessions = getDisplayedDesktopThreads(limit);
      if (!desktopSessions) {
        response = '读取桌面会话列表失败，请稍后重试。';
        break;
      }
      if (desktopSessions.length === 0) {
        response = showAll
          ? '没有找到桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。'
          : '没有找到最近桌面会话。先在 Codex Desktop App 中打开一个会话，再回来试一次。';
        break;
      }
      response = buildDesktopThreadsCommandResponse(
        desktopSessions,
        responseParseMode === 'Markdown',
        showAll,
        limit,
      );
      break;
    }

    case '/reasoning': {
      if (!currentBinding) {
        response = '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管桌面会话。';
        break;
      }
      const session = store.getSession(currentBinding.codepilotSessionId);
      if (!session) {
        response = '当前会话不存在。';
        break;
      }
      if (!args) {
        response = buildCommandFields(
          '当前思考级别',
          [['级别', formatReasoningEffort(resolveEffectiveReasoningEffort(session))]],
          [REASONING_OPTIONS_TEXT, '发送 `/r high` 可切换。'],
          responseParseMode === 'Markdown',
        );
        break;
      }
      const reasoning = normalizeReasoningEffort(args);
      if (!reasoning) {
        response = buildCommandFields(
          '思考级别用法',
          [['命令', '`/reasoning low|medium|high|xhigh`']],
          ['也支持兼容数字：`/reasoning 1|2|3|4|5|6|7`', REASONING_OPTIONS_TEXT],
          responseParseMode === 'Markdown',
        );
        break;
      }
      store.updateSession(session.id, {
        reasoning_effort: reasoning as BridgeSession['reasoning_effort'],
      });
      response = buildCommandFields(
        '已更新思考级别',
        [['级别', formatReasoningEffort(reasoning)]],
        [REASONING_OPTIONS_TEXT],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/cwd': {
      response = '当前版本已不支持 /cwd。请使用 /new 新建会话，或使用 /t 切换到已有桌面会话。';
      break;
    }

    case '/mode': {
      const binding = currentBinding || router.resolve(msg.address);
      if (!args) {
        response = buildCommandFields(
          '当前模式',
          [['模式', binding.mode]],
          [MODE_OPTIONS_TEXT, '发送 `/m code`、`/m plan` 或 `/m ask` 切换。完整命令也兼容：`/mode code`。'],
          responseParseMode === 'Markdown',
        );
        break;
      }
      if (!validateMode(args)) {
        response = buildCommandFields(
          '模式用法',
          [['命令', '`/mode plan|code|ask`']],
          [MODE_OPTIONS_TEXT],
          responseParseMode === 'Markdown',
        );
        break;
      }
      const session = store.getSession(binding.codepilotSessionId);
      if (session) {
        store.updateSession(session.id, {
          preferred_mode: args,
        });
      }
      router.updateBinding(binding.id, { mode: args });
      response = buildCommandFields(
        '已切换模式',
        [['模式', args]],
        [MODE_OPTIONS_TEXT],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/model': {
      const binding = currentBinding || router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      if (!session) {
        response = '当前会话不存在。';
        break;
      }

      if (!args) {
        const desktopThreadId = getExplicitDesktopThreadId(session);
        const currentModel = resolveDisplayedModel(
          binding,
          session,
          store.getSetting('default_model'),
          readConfiguredCodexModel(),
        );
        response = buildCommandFields(
          '当前模型',
          [['模型', formatDisplayedModel(currentModel)]],
          [
            getAvailableModelChoicesText(),
            desktopThreadId
              ? '当前是共享桌面线程，只支持查看模型；如需切换，请先用 `/new` 新建一个 IM 会话线程。'
              : '发送 `/model gpt-5.4` 可切换；发送 `/model default` 可回退到默认模型。',
            '模型切换只影响后续从 IM 发起的 Codex CLI 请求。',
          ],
          responseParseMode === 'Markdown',
        );
        break;
      }

      if (getExplicitDesktopThreadId(session)) {
        response = '当前是共享桌面线程，不支持直接切换模型。请先用 `/new` 新建一个线程，再执行 `/model ...`。';
        break;
      }

      const requestedModel = args.trim();
      if (requestedModel === 'default') {
        store.updateSessionModel(session.id, '');
        router.updateBinding(binding.id, { model: '' });
        const updatedBinding = router.resolve(msg.address);
        const updatedSession = store.getSession(updatedBinding.codepilotSessionId);
        const currentModel = resolveDisplayedModel(
          updatedBinding,
          updatedSession,
          store.getSetting('default_model'),
          readConfiguredCodexModel(),
        );
        response = buildCommandFields(
          '已恢复默认模型',
          [['模型', formatDisplayedModel(currentModel)]],
          ['后续从 IM 发起的 Codex CLI 请求会跟随默认模型。'],
          responseParseMode === 'Markdown',
        );
        break;
      }

      const selectedModel = getSelectableCodexModel(requestedModel);
      if (!selectedModel) {
        response = buildCommandFields(
          '模型用法',
          [['命令', '`/model <slug>`']],
          [
            getAvailableModelChoicesText(),
            '发送 `/model default` 可回退到默认模型。',
          ],
          responseParseMode === 'Markdown',
        );
        break;
      }

      store.updateSessionModel(session.id, selectedModel.slug);
      router.updateBinding(binding.id, { model: selectedModel.slug });
      response = buildCommandFields(
        '已更新模型',
        [['模型', formatDisplayedModel(selectedModel.slug)]],
        [
          '后续从 IM 发起的 Codex CLI 请求会使用这个模型。',
          ...(isCliOnlyCodexModel(selectedModel)
            ? ['这是 CLI only 模型，只能在 IM -> Codex CLI 调用中使用，Codex Desktop 不支持。']
            : []),
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/status': {
      auditResponse = false;
      const binding = currentBinding;
      if (!binding) {
        response = buildCommandFields(
          '当前会话',
          [],
          ['当前聊天还没有绑定会话。可先发送 `/t` 查看最近桌面会话，再用 `/t 1` 接管；或发送 `/new proj1` / `/new 绝对路径` 创建项目会话。'],
          responseParseMode === 'Markdown',
        );
        break;
      }

      const session = store.getSession(binding.codepilotSessionId);
      if (!session) {
        response = buildCommandFields(
          '当前会话',
          [
            ['Session', binding.codepilotSessionId],
            ['目录', formatCommandPath(binding.workingDirectory)],
          ],
          ['当前聊天绑定的会话已经不存在。可用 `/t` 接管桌面会话，或用 `/new proj1` / `/new 绝对路径` 创建新会话。'],
          responseParseMode === 'Markdown',
        );
        break;
      }

      const desktopThreadId = getExplicitDesktopThreadId(session);
      const threadTitle = getDesktopThreadTitle(desktopThreadId);
      const sandboxMode = resolveEffectiveSandboxMode();
      const reasoningEffort = resolveEffectiveReasoningEffort(session);
      const currentModel = resolveDisplayedModel(
        binding,
        session,
        store.getSetting('default_model'),
        readConfiguredCodexModel(),
      );
      const sessionKind = session?.session_type === 'draft'
        ? '临时草稿线程'
        : '普通会话';
      response = buildCommandFields(
        '当前会话',
        [
          ['标题', threadTitle || getSessionDisplayName(session, binding.workingDirectory)],
          ['目录', formatCommandPath(binding.workingDirectory)],
          ['模式', binding.mode],
          ['当前模型', formatDisplayedModel(currentModel)],
          ['类型', sessionKind],
          ['运行状态', formatRuntimeStatus(session)],
          ['共享镜像', formatMirrorStatus(session)],
          ['文件系统权限', sandboxMode],
          ['思考级别', formatReasoningEffort(reasoningEffort)],
        ],
        [
          desktopThreadId
            ? '当前聊天已绑定到一条共享会话，直接发送消息即可继续。'
            : session?.session_type === 'draft'
              ? '当前聊天正在使用临时草稿线程（等同 `/t 0`）。可直接发送消息，或用 `/t` / `/new proj1` / `/new 绝对路径` 切换到正式会话。'
              : '当前聊天还没有绑定桌面会话。可先发送 `/t`，再用 `/t 1` 接管。',
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/health': {
      auditResponse = false;
      if (args === 'all') {
        const diagnoses = await deps.diagnoseAllActiveSessions();
        response = diagnoses.length > 0
          ? buildHealthListResponse(diagnoses, responseParseMode === 'Markdown')
          : '当前没有检测到运行中的会话。';
        break;
      }

      const explicitTargetSessionId = args.trim();
      const targetSessionId = explicitTargetSessionId || currentBinding?.codepilotSessionId;
      if (!targetSessionId) {
        response = '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管桌面会话。';
        break;
      }
      const diagnosis = await deps.diagnoseSessionHealth(targetSessionId);
      if (!diagnosis) {
        response = `没有找到会话 ${targetSessionId}。`;
        break;
      }
      response = buildHealthCommandResponse(
        explicitTargetSessionId ? '指定会话健康检查' : '当前会话健康检查',
        diagnosis,
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/history': {
      if (!currentBinding) {
        response = '当前聊天还没有绑定会话。先发送消息创建会话，或先用 `/t 1` 接管桌面会话。';
        break;
      }

      const limit = getHistoryMessageLimit();
      const session = store.getSession(currentBinding.codepilotSessionId);
      const desktopThreadId = getExplicitDesktopThreadId(session);
      const desktopMessages = desktopThreadId
        ? readDesktopSessionMessages(desktopThreadId, limit)
        : [];
      const { messages: storedMessages } = store.getMessages(currentBinding.codepilotSessionId, { limit });
      const messages = desktopMessages.length > 0 ? desktopMessages : storedMessages;
      if (messages.length === 0) {
        response = '当前会话还没有历史消息。';
        break;
      }
      const threadTitle = getDesktopThreadTitle(desktopThreadId);

      const header = buildCommandFields(
        '最近对话（raw）',
        [
          ['标题', threadTitle || getSessionDisplayName(session, currentBinding.workingDirectory)],
          ['来源', desktopMessages.length > 0 ? '桌面线程' : 'Bridge 缓存'],
          ['返回条数', `${messages.length} / 配置 ${limit}`],
        ],
        args === 'raw'
          ? []
          : ['`/history` 当前直接返回原始记录；`/history raw` 仍可继续使用。'],
        responseParseMode === 'Markdown',
      );
      const body = messages.map((message, index) => {
        if (responseParseMode === 'Markdown') {
          return `${index + 1}. **${formatHistoryRole(message.role)}**\n\n${truncateHistoryContent(formatStoredMessageContent(message.content))}`;
        }
        return `${index + 1}. ${formatHistoryRole(message.role)}\n${truncateHistoryContent(formatStoredMessageContent(message.content))}`;
      }).join('\n\n');
      response = [header, body].join('\n\n').trim();
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      const task = deps.getActiveTask(binding.codepilotSessionId);
      const runningHealthStatuses = new Set([
        'running_active',
        'waiting_tool',
        'slow_observed',
        'suspected_stall',
        'suspected_stream_ui_stall',
        'suspected_detached',
      ]);
      const looksRunning = session?.runtime_status === 'running'
        || session?.runtime_status === 'queued'
        || runningHealthStatuses.has(session?.health_status || '');
      const taskName = getSessionDisplayName(session, binding.workingDirectory);
      const stopDetail = '用户执行 /stop，请求停止当前任务。';
      if (deps.forceStopSession) {
        const result = await deps.forceStopSession(binding.codepilotSessionId, stopDetail);
        if (result.status === 'stopped') {
          deps.recordInteractiveHealthEnd?.(binding.codepilotSessionId, 'aborted', stopDetail);
          response = `旧会话「${taskName}」任务已停止，可继续发送消息恢复该线程。`;
        } else if (result.status === 'stop_requested') {
          deps.recordInteractiveHealthEnd?.(binding.codepilotSessionId, 'aborted', stopDetail);
          response = `已向旧会话「${taskName}」发送停止请求。可发送 \`//\` 确认最终状态。`;
        } else if (result.status === 'not_running') {
          response = result.detail || '当前没有正在运行的任务。';
        } else if (result.status === 'unavailable') {
          response = `无法从 IM 安全停止旧会话「${taskName}」：${result.detail}\n\n未终止 Codex Desktop App 或其他无法确认归属的进程。`;
        } else {
          response = `停止旧会话「${taskName}」失败：${result.detail}\n\n可稍后重试 \`/stop\`，或发送 \`//\` 查看任务是否仍在运行。`;
        }
      } else if (task || looksRunning) {
        if (task) {
          task.abortController.abort();
          deps.recordInteractiveHealthEnd?.(binding.codepilotSessionId, 'aborted', stopDetail);
          response = `已向旧会话「${taskName}」发送停止请求。可发送 \`//\` 确认最终状态。`;
        } else {
          response = '当前任务看起来仍在运行，但当前运行时不支持从 IM 安全停止。';
        }
      } else {
        response = '当前没有正在运行的任务。';
      }
      break;
    }

    case '/perm': {
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = '用法：/perm allow|allow_session|deny <permission_id>';
        break;
      }
      const link = store.getPermissionLink(permId);
      if (!link) {
        response = '没有找到对应权限，或该权限已处理。';
        break;
      }
      if (
        currentBinding?.codepilotSessionId
        && link.sessionId
        && link.sessionId !== currentBinding.codepilotSessionId
      ) {
        response = '这条权限请求不属于当前会话。请先切回对应会话，再处理该权限。';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      response = handled
        ? `已记录权限操作：${permAction}`
        : '没有找到对应权限，或该权限已处理。';
      break;
    }

    case '/unbind': {
      if (!currentBinding) {
        response = '当前聊天还没有绑定任何会话。';
        break;
      }
      const parsedArgs = parseForceFlag(args);
      const blocked = guardBindingChangeWhileRunning(
        store,
        currentBinding,
        parsedArgs.force,
        deps,
        responseParseMode === 'Markdown',
      );
      if (blocked) {
        response = blocked;
        break;
      }
      store.deleteChannelBinding(currentBinding.id);
      auditCommandBindingChange(
        'unbind',
        msg,
        currentBinding,
        null,
        parsedArgs.force ? 'forced' : undefined,
      );
      response = buildCommandFields(
        '已解绑当前聊天',
        [
          ['聊天', formatBindingChatLabel(currentBinding)],
        ],
        [
          '这个聊天已释放当前会话绑定。',
          '之后如果直接发送文本，会自动进入新的临时草稿线程。',
        ],
        responseParseMode === 'Markdown',
      );
      break;
    }

    case '/help':
      responseParseMode = getFeedbackParseMode(adapter.channelType);
      response = [
        '**命令速览**',
        '',
        '**常用**',
        '- `/` 当前会话',
        '- `//` 健康检查',
        '- `/h` 帮助',
        `- \`/t\` 最近 ${DEFAULT_DESKTOP_THREAD_LIST_LIMIT} 条桌面会话`,
        `- \`/t all\` 最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条桌面会话`,
        `- \`/t n 100\` 最近 100 条桌面会话（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）`,
        '- `/t 1` 接管第 1 条会话',
        '- `/n` 在当前工作目录下新建线程（仅保证 IM 可继续，不会自动出现在桌面会话列表）',
        '- `/n proj1` 在默认工作空间下新建项目会话',
        '- 直接发文本：继续当前会话；未绑定时进入临时草稿线程',
        '- `/his` 最近原始记录',
        '',
        '**设置**',
        '- `/m` 查看模式；可用 `code | plan | ask`',
        '- `/r` 查看思考级别；可用 `1 | 2 | 3 | 4 | 5`',
        '- `/model` 查看当前模型；`/model gpt-5.4` 可切换，`/model default` 回退到默认模型',
        '- `/t 0` 临时草稿线程',
        '- `/t 0 reset` 重置草稿线程',
        '- `/unbind` 解绑当前聊天，释放当前会话',
        '- `/stop` 停止当前任务',
        '',
        '**其它**',
        '- `/his raw` 最近原始记录（兼容别名）',
        '- `/perm allow|allow_session|deny <id>` 或 `1 / 2 / 3` 处理权限',
      ].join('\n');
      break;

    default:
      response = `未知命令：${rawCommand}\n发送 /h 或 /help 查看可用命令。`;
  }

  if (response) {
    await deliverBridgeNotice(adapter, msg.address, response, {
      replyToMessageId: msg.messageId,
      audit: auditResponse,
    });
  }
}
