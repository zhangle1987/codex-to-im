import type { OutboundAttachment } from '../types.js';
import { parseOutboundArtifacts } from '../outbound-artifacts.js';

export interface FinalResponseArtifactParseResult {
  text: string;
  attachments: OutboundAttachment[];
}

function attachmentKey(attachment: OutboundAttachment): string {
  return [
    attachment.kind,
    attachment.path,
    attachment.caption || '',
    attachment.name || '',
  ].join('\0');
}

export function dedupeOutboundAttachments(
  attachments: OutboundAttachment[],
): OutboundAttachment[] {
  const seen = new Set<string>();
  const deduped: OutboundAttachment[] = [];
  for (const attachment of attachments) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(attachment);
  }
  return deduped;
}

export function collectFinalResponseArtifacts(
  text?: string | null,
  attachments: OutboundAttachment[] = [],
): FinalResponseArtifactParseResult {
  const parsed = parseOutboundArtifacts(text || '');
  return {
    text: parsed.cleanText,
    attachments: dedupeOutboundAttachments([
      ...attachments,
      ...parsed.attachments,
    ]),
  };
}
