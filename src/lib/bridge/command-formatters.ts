import path from 'node:path';

import type { BridgeSession } from './host.js';
import type { ChannelBinding } from './types.js';
import type { DesktopSessionSummary } from '../../desktop-sessions.js';
import {
  DEFAULT_DESKTOP_THREAD_LIST_LIMIT,
  MAX_DESKTOP_THREAD_LIST_LIMIT,
  parseListIndex,
} from './command-aliases.js';

export function resolveByIndexOrPrefix<T>(
  raw: string,
  items: T[],
  getId: (item: T) => string,
): { match: T | null; ambiguous: boolean; index?: number } {
  const token = raw.trim().toLowerCase();
  if (!token) return { match: null, ambiguous: false };

  const index = parseListIndex(token);
  if (index !== null) {
    return { match: items[index - 1] ?? null, ambiguous: false, index };
  }

  const exact = items.find((item) => getId(item).toLowerCase() === token);
  if (exact) return { match: exact, ambiguous: false };

  const prefixMatches = items.filter((item) => getId(item).toLowerCase().startsWith(token));
  if (prefixMatches.length === 1) {
    return { match: prefixMatches[0], ambiguous: false };
  }
  if (prefixMatches.length > 1) {
    return { match: null, ambiguous: true };
  }

  return { match: null, ambiguous: false };
}

export function formatReasoningEffort(reasoning: string): string {
  switch (reasoning) {
    case 'minimal':
      return 'minimal (1)';
    case 'low':
      return 'low (2)';
    case 'medium':
      return 'medium (3)';
    case 'high':
      return 'high (4)';
    case 'xhigh':
      return 'xhigh (5)';
    case 'max':
      return 'max (6)';
    case 'ultra':
      return 'ultra (7)';
    default:
      return reasoning;
  }
}

export function getSessionDisplayName(session: BridgeSession | null | undefined, fallbackDirectory?: string): string {
  if (session?.name?.trim()) return session.name.trim();
  const cwd = session?.working_directory || fallbackDirectory || '';
  if (cwd) return path.basename(cwd) || cwd;
  if (session?.id) return session.id.slice(0, 8);
  return '未命名会话';
}

export function buildCommandFields(
  title: string,
  fields: Array<[string, string | null | undefined]>,
  notes: string[] = [],
  markdown = false,
): string {
  const normalizedFields = fields.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  const normalizedNotes = notes.filter((note) => note.trim().length > 0);

  if (markdown) {
    const lines = [`**${title}**`, ''];
    for (const [label, value] of normalizedFields) {
      lines.push(`- **${label}**：${value}`);
    }
    if (normalizedNotes.length > 0) {
      lines.push('', '**说明**');
      for (const note of normalizedNotes) {
        lines.push(`- ${note}`);
      }
    }
    return lines.join('\n').trim();
  }

  return [
    title,
    '',
    ...normalizedFields.map(([label, value]) => `${label}: ${value}`),
    ...(normalizedNotes.length > 0 ? ['', ...normalizedNotes] : []),
  ].join('\n').trim();
}

export function buildIndexedCommandList(
  title: string,
  items: Array<{ heading: string; details: string[] }>,
  footer: string[] = [],
  markdown = false,
): string {
  if (markdown) {
    const lines = [`**${title}**`, ''];
    items.forEach((item, index) => {
      const marker = `${index + 1}.`;
      const childIndent = ' '.repeat(marker.length + 1);
      lines.push(`${marker} **${item.heading}**`);
      item.details.filter(Boolean).forEach((detail) => lines.push(`${childIndent}- ${detail}`));
      lines.push('');
    });
    footer.filter(Boolean).forEach((line) => lines.push(`- ${line}`));
    return lines.join('\n').trim();
  }

  const lines = [title, ''];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.heading}`);
    item.details.filter(Boolean).forEach((detail) => lines.push(`   ${detail}`));
    lines.push('');
  });
  footer.filter(Boolean).forEach((line) => lines.push(line));
  return lines.join('\n').trim();
}

export function formatCommandPath(cwd: string | undefined | null): string {
  return cwd?.trim() || '~';
}

export function buildDesktopThreadsCommandResponse(
  desktopSessions: DesktopSessionSummary[],
  markdown: boolean,
  showAll: boolean,
  _limit = DEFAULT_DESKTOP_THREAD_LIST_LIMIT,
): string {
  const actualCount = desktopSessions.length;
  const title = showAll
    ? `桌面会话（当前显示 ${actualCount} 条，最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）`
    : `最近 ${actualCount} 条桌面会话`;
  return buildIndexedCommandList(
    title,
    desktopSessions.map((session) => ({
      heading: session.title || '未命名线程',
      details: [
        `目录：${formatCommandPath(session.cwd)}`,
        `来源：${session.originator || 'Codex Desktop'}`,
      ],
    })),
    showAll
      ? [
          '发送 `/t 1` 可接管第 1 条桌面会话。',
          `发送 \`/t\` 可只看最近 ${DEFAULT_DESKTOP_THREAD_LIST_LIMIT} 条。`,
        ]
      : [
          '发送 `/t 1` 可接管第 1 条桌面会话。',
          `发送 \`/t all\` 可查看最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条桌面会话。`,
          `发送 \`/t n 100\` 可查看最近 100 条桌面会话（最多 ${MAX_DESKTOP_THREAD_LIST_LIMIT} 条）。`,
        ],
    markdown,
  );
}

export function toUserVisibleBindingError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message) return message;
  }
  return fallback;
}

export function formatBindingChatLabel(
  binding: Pick<ChannelBinding, 'channelType' | 'channelProvider' | 'channelAlias' | 'chatId' | 'chatDisplayName'>,
  resolvedAlias?: string,
): string {
  const channelLabel = binding.channelAlias
    || resolvedAlias
    || (binding.channelProvider === 'feishu'
      ? '飞书'
      : binding.channelProvider === 'weixin'
        ? '微信'
        : binding.channelType);
  const chatLabel = binding.chatDisplayName?.trim() || binding.chatId;
  return `${channelLabel} 聊天 ${chatLabel}`;
}

export function toUserVisibleCommandError(command: string, error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message && /一个会话只能绑定一个聊天|已绑定到/.test(message)) {
      return message;
    }
  }

  if (command === '/history') {
    return '读取历史记录失败，请稍后重试。';
  }
  if (command === '/new') {
    return '新建会话失败。请检查目录是否可写，或改用 /new 绝对路径。';
  }
  return `${command} 执行失败，请稍后重试。`;
}

export function formatCommandMessageId(id: string | undefined | null): string {
  if (!id) return '未共享';
  return id;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatCommandDateTime(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '-';

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;

  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

function stripStoredAttachmentMarker(content: string): string {
  return content.replace(/\n?<!--files:[\s\S]*?-->$/u, '').trim();
}

export function formatStoredMessageContent(content: string): string {
  const stripped = stripStoredAttachmentMarker(content);
  if (!stripped) return '[empty]';

  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return stripped;

    const lines: string[] = [];
    for (const block of parsed) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lines.push(block.text.trim());
        continue;
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        lines.push(`[tool] ${block.name}`);
        continue;
      }
      if (block.type === 'tool_result') {
        const suffix = block.is_error === true ? ' error' : '';
        if (typeof block.content === 'string' && block.content.trim()) {
          lines.push(`[tool_result${suffix}] ${block.content.trim()}`);
        } else {
          lines.push(`[tool_result${suffix}]`);
        }
      }
    }
    return lines.length > 0 ? lines.join('\n') : stripped;
  } catch {
    return stripped;
  }
}

export function truncateHistoryContent(content: string, maxChars = 800): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}...`;
}

export function formatHistoryRole(role: string): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Codex';
  return role || 'unknown';
}

export function formatRuntimeStatus(session: BridgeSession | null | undefined): string {
  const status = session?.runtime_status || 'idle';
  const queuedCount = session?.queued_count && session.queued_count > 0
    ? session.queued_count
    : 0;

  if (status === 'queued') {
    return queuedCount > 0 ? `排队中（${queuedCount}）` : '排队中';
  }
  if (status === 'running') {
    return '运行中';
  }
  return '空闲';
}

export function formatMirrorStatus(session: BridgeSession | null | undefined): string {
  if (session?.mirror_status === 'watching') {
    return session.mirror_last_event_at
      ? `监听中 · 最近同步 ${formatCommandDateTime(session.mirror_last_event_at)}`
      : '监听中';
  }
  if (session?.mirror_status === 'stale') {
    return '待恢复（暂时没定位到桌面 thread 文件）';
  }
  return '未监听';
}
