import {
  parseReasoningEffort as parseRuntimeReasoningEffort,
  type RuntimeReasoningEffort,
} from '../../runtime-options.js';

export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const DEFAULT_DESKTOP_THREAD_LIST_LIMIT = 10;
export const MAX_DESKTOP_THREAD_LIST_LIMIT = 200;

export function parseListIndex(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function resolveCommandAlias(rawCommand: string, args: string): string {
  switch (rawCommand) {
    case '//':
      return '/health';
    case '/':
      return '/status';
    case '/h':
      return '/help';
    case '/t':
      return !args
        ? '/threads'
        : /^(all|n\b)/i.test(args.trim())
          ? '/threads'
          : '/thread';
    case '/n':
      return '/new';
    case '/m':
      return '/mode';
    case '/r':
      return '/reasoning';
    case '/his':
      return '/history';
    default:
      return rawCommand;
  }
}

export function parseDesktopThreadListArgs(args: string): { showAll: boolean; limit: number } | null {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) {
    return { showAll: false, limit: DEFAULT_DESKTOP_THREAD_LIST_LIMIT };
  }
  if (trimmed === 'all') {
    return { showAll: true, limit: MAX_DESKTOP_THREAD_LIST_LIMIT };
  }
  const match = trimmed.match(/^n\s+(\d+)$/);
  if (!match) return null;
  const requestedLimit = Number(match[1]);
  const limit = Math.min(requestedLimit, MAX_DESKTOP_THREAD_LIST_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) return null;
  return { showAll: false, limit };
}

export function normalizeReasoningEffort(raw: string): RuntimeReasoningEffort | null {
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  const named = parseRuntimeReasoningEffort(token);
  if (named) return named;

  switch (token) {
    case '1':
      return 'minimal';
    case '2':
      return 'low';
    case '3':
      return 'medium';
    case '4':
      return 'high';
    case '5':
      return 'xhigh';
    case '6':
      return 'max';
    case '7':
      return 'ultra';
    default:
      return null;
  }
}
