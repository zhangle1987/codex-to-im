import fs from 'node:fs';
import path from 'node:path';

import {
  getDesktopSessionByThreadId,
  listDesktopSessions,
} from '../../desktop-sessions.js';
import type { DesktopSessionSummary } from '../../desktop-sessions.js';
import { DEFAULT_WORKSPACE_ROOT } from '../../config.js';
import {
  resetDraftSession as resetDraftSessionForStore,
} from '../../internal-sessions.js';
import {
  findAvailableCodexModel,
  isCliOnlyCodexModel,
  listAvailableCodexModels,
} from '../../codex-models.js';
import {
  normalizeReasoningEffort as normalizeStoredReasoningEffort,
  normalizeSandboxMode,
} from '../../runtime-options.js';
import { getBridgeContext } from './context.js';
import type { BridgeSession } from './host.js';
import { validateWorkingDirectory } from './security/validators.js';

const AVAILABLE_CODEX_MODELS = listAvailableCodexModels();
const AVAILABLE_CODEX_MODEL_MAP = new Map(AVAILABLE_CODEX_MODELS.map((model) => [model.slug, model]));

export function getDisplayedDesktopThreads(limit: number): DesktopSessionSummary[] | null {
  try {
    return listDesktopSessions(limit);
  } catch (error) {
    console.error('[bridge-manager] Failed to list desktop sessions:', error);
    return null;
  }
}

export function getDesktopSessionByThreadIdSafe(
  threadId: string,
  context: string,
): DesktopSessionSummary | null {
  try {
    return getDesktopSessionByThreadId(threadId);
  } catch (error) {
    console.error(
      `[bridge-manager] Failed to load desktop thread ${threadId} during ${context}:`,
      error,
    );
    return null;
  }
}

export function getWorkspaceRoot(): string {
  const { store } = getBridgeContext();
  return store.getSetting('bridge_default_workspace_root') || DEFAULT_WORKSPACE_ROOT;
}

export function resolveEffectiveReasoningEffort(session: BridgeSession | null | undefined): string {
  const { store } = getBridgeContext();
  return normalizeStoredReasoningEffort(
    session?.reasoning_effort || store.getSetting('bridge_codex_reasoning_effort'),
  );
}

export function resolveEffectiveSandboxMode(): string {
  const { store } = getBridgeContext();
  return normalizeSandboxMode(store.getSetting('bridge_codex_sandbox_mode'));
}

export function resolveDisplayedModel(
  binding: { model?: string | null } | null | undefined,
  session: BridgeSession | null | undefined,
  configuredDefaultModel?: string | null,
  codexDefaultModel?: string | null,
): string {
  return binding?.model
    || session?.model
    || configuredDefaultModel
    || codexDefaultModel
    || 'default';
}

export function formatDisplayedModel(model: string): string {
  const metadata = AVAILABLE_CODEX_MODEL_MAP.get(model);
  return metadata && isCliOnlyCodexModel(metadata)
    ? `${model}（仅 IM / CLI）`
    : model;
}

export function getAvailableModelChoicesText(): string {
  if (AVAILABLE_CODEX_MODELS.length === 0) {
    return '当前没有可用模型缓存；请检查 `~/.codex/models_cache.json`，然后重启 Bridge。';
  }
  return `可选模型：${AVAILABLE_CODEX_MODELS.map((model) => formatDisplayedModel(model.slug)).join('、')}`;
}

export function getSelectableCodexModel(slug: string) {
  return AVAILABLE_CODEX_MODEL_MAP.get(slug) || findAvailableCodexModel(slug);
}

export function resolveNewWorkingDirectory(rawArgs: string): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { ok: false, message: '缺少路径参数。' };
  }

  if (path.isAbsolute(trimmed)) {
    const validated = validateWorkingDirectory(trimmed);
    if (!validated) {
      return { ok: false, message: '路径无效。必须是绝对路径，且不能包含目录穿越或特殊字符。' };
    }
    return { ok: true, workDir: validated };
  }

  const workspaceRoot = getWorkspaceRoot();

  if (trimmed.includes('\0') || /[$`;|&><(){}\x00-\x1f]/.test(trimmed)) {
    return { ok: false, message: '项目名无效。' };
  }

  const normalizedRelative = path.normalize(trimmed);
  if (
    !normalizedRelative
    || normalizedRelative === '.'
    || normalizedRelative.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    return { ok: false, message: '项目名无效。不能使用 .. 或空路径。' };
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelative);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, message: '项目路径越界。新项目必须创建在默认工作空间内。' };
  }

  const validated = validateWorkingDirectory(resolvedPath);
  if (!validated) {
    return { ok: false, message: '解析后的工作目录无效。' };
  }
  return { ok: true, workDir: validated };
}

export function resolveNewSessionWorkingDirectory<T extends {
  workingDirectory: string;
  model?: string | null;
}>(
  rawArgs: string,
  binding: T | null,
  session: BridgeSession | null | undefined,
): { ok: true; workDir: string } | { ok: false; message: string } {
  const trimmed = rawArgs.trim();
  if (trimmed) {
    return resolveNewWorkingDirectory(trimmed);
  }

  if (!binding || !session) {
    return {
      ok: false,
      message: '当前聊天还没有绑定正式会话。请先用 `/t 1` 接管，或使用 `/new proj1` / `/new 绝对路径` 创建项目会话。',
    };
  }

  if (session.session_type === 'draft') {
    return {
      ok: false,
      message: '当前不是正式工作会话。无参 `/new` 只能基于当前正式会话的目录创建新线程；请先切回正式会话，或使用 `/new proj1` / `/new 绝对路径`。',
    };
  }

  const validated = validateWorkingDirectory(session.working_directory || binding.workingDirectory || '');
  if (!validated) {
    return {
      ok: false,
      message: '当前会话没有有效的工作目录。请改用 `/new proj1` 或 `/new 绝对路径`。',
    };
  }

  return { ok: true, workDir: validated };
}

export function ensureWorkingDirectoryExists(workDir: string): void {
  fs.mkdirSync(workDir, { recursive: true });
}

export function resetDraftSession(address: { channelType: string; chatId: string }): BridgeSession {
  const { store } = getBridgeContext();
  return resetDraftSessionForStore(store, address);
}

export function getHistoryMessageLimit(): number {
  const { store } = getBridgeContext();
  const configured = Number.parseInt(store.getSetting('bridge_history_message_limit') || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return 8;
  return Math.max(1, Math.min(20, configured));
}

export function getDesktopThreadTitle(threadId: string | undefined | null): string | null {
  if (!threadId) return null;
  return getDesktopSessionByThreadIdSafe(threadId, 'status lookup')?.title || null;
}
