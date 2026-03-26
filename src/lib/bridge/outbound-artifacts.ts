import path from 'node:path';

import type { OutboundAttachment } from './types.js';

const SEND_BLOCK_REGEX = /<cti-send>\s*([\s\S]*?)\s*<\/cti-send>/gi;
const SEND_BLOCK_OPEN_REGEX = /<cti-send>/i;

interface RawSendInstruction {
  type?: unknown;
  path?: unknown;
  caption?: unknown;
  name?: unknown;
}

export interface ParsedOutboundArtifacts {
  cleanText: string;
  attachments: OutboundAttachment[];
  errors: string[];
}

function normalizeInstruction(raw: RawSendInstruction): OutboundAttachment | null {
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  const filePath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if ((type !== 'image' && type !== 'file') || !filePath || !path.isAbsolute(filePath)) {
    return null;
  }

  return {
    kind: type,
    path: filePath,
    caption: typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption.trim() : undefined,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined,
  };
}

function normalizeInstructionPayload(payload: unknown): {
  attachments: OutboundAttachment[];
  errors: string[];
} {
  const attachments: OutboundAttachment[] = [];
  const errors: string[] = [];

  const objects: RawSendInstruction[] = [];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === 'object') {
        objects.push(item as RawSendInstruction);
      }
    }
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      for (const item of record.items) {
        if (item && typeof item === 'object') {
          objects.push(item as RawSendInstruction);
        }
      }
    } else {
      objects.push(record as RawSendInstruction);
    }
  }

  for (const raw of objects) {
    const normalized = normalizeInstruction(raw);
    if (normalized) {
      attachments.push(normalized);
    } else {
      errors.push('invalid-send-instruction');
    }
  }

  return { attachments, errors };
}

function compactBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseOutboundArtifacts(text: string): ParsedOutboundArtifacts {
  const attachments: OutboundAttachment[] = [];
  const errors: string[] = [];
  let mutated = text ?? '';

  mutated = mutated.replace(SEND_BLOCK_REGEX, (_full, payloadText: string) => {
    try {
      const payload = JSON.parse(payloadText);
      const normalized = normalizeInstructionPayload(payload);
      attachments.push(...normalized.attachments);
      errors.push(...normalized.errors);
    } catch {
      errors.push('invalid-send-json');
    }
    return '';
  });

  return {
    cleanText: compactBlankLines(mutated),
    attachments,
    errors,
  };
}

export function stripOutboundArtifactBlocksForStreaming(text: string): string {
  if (!text) return '';

  let stripped = text.replace(SEND_BLOCK_REGEX, '');
  const openMatch = SEND_BLOCK_OPEN_REGEX.exec(stripped);
  if (openMatch) {
    stripped = stripped.slice(0, openMatch.index);
  }

  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function supportsOutboundArtifacts(channelType: string): boolean {
  return channelType === 'feishu';
}
