import type { OutboundAttachment } from '../types.js';
import {
  stripOutboundArtifactBlocksForStreaming,
} from '../outbound-artifacts.js';
import type {
  BridgeTurnFinalSource,
  FinalizedBridgeResponse,
} from './turn-types.js';
import {
  collectFinalResponseArtifacts,
  dedupeOutboundAttachments,
} from './final-response-artifacts.js';

export interface AssembleFinalResponseInput {
  text?: string | null;
  attachments?: OutboundAttachment[];
  hasError?: boolean;
  errorMessage?: string;
}

function assembleFinalResponse(
  source: BridgeTurnFinalSource,
  input: AssembleFinalResponseInput,
): FinalizedBridgeResponse {
  const parsed = collectFinalResponseArtifacts(input.text, input.attachments);
  return {
    text: parsed.text,
    attachments: parsed.attachments,
    hasError: input.hasError,
    errorMessage: input.errorMessage,
    source,
  };
}

export function assembleSdkFinalResponse(
  input: AssembleFinalResponseInput,
): FinalizedBridgeResponse {
  return assembleFinalResponse('sdk_result', input);
}

export function assembleDesktopFinalResponse(
  input: AssembleFinalResponseInput,
): FinalizedBridgeResponse {
  return assembleFinalResponse('desktop_task_complete', input);
}

export function hasFinalResponsePayload(response: FinalizedBridgeResponse): boolean {
  return Boolean(response.text || response.attachments.length > 0);
}

export function mergeFinalResponses(
  primary: FinalizedBridgeResponse,
  fallback: FinalizedBridgeResponse,
): FinalizedBridgeResponse {
  return {
    text: primary.text || fallback.text,
    attachments: dedupeOutboundAttachments([
      ...fallback.attachments,
      ...primary.attachments,
    ]),
    hasError: primary.hasError ?? fallback.hasError,
    errorMessage: primary.errorMessage || fallback.errorMessage,
    source: primary.source,
  };
}

export function stripFinalOnlyBlocksForStreaming(text: string): string {
  return stripOutboundArtifactBlocksForStreaming(text);
}
