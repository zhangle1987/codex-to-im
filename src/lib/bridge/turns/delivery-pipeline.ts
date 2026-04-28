import type { BaseChannelAdapter } from '../channel-adapter.js';
import type { ChannelAddress, OutboundAttachment, SendResult } from '../types.js';
import {
  deliverResponse as defaultDeliverResponse,
} from '../feedback-delivery.js';
import {
  finalizeStreamFeedback,
  type StreamFeedbackTarget,
} from '../stream-feedback-controller.js';
import type { FinalizedBridgeResponse } from './turn-types.js';

export type DeliverResponseImpl = (
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  attachments?: OutboundAttachment[],
) => Promise<unknown>;

export interface FinalResponseDeliveryContext {
  adapter: BaseChannelAdapter;
  address: ChannelAddress;
  sessionId: string;
  replyToMessageId?: string;
  deliverResponse?: DeliverResponseImpl;
  deliverText?: (text: string) => Promise<SendResult>;
}

export interface FinalResponseDeliveryOptions {
  skipText?: boolean;
}

function normalizeUnknownSendResult(result: unknown): SendResult {
  if (result && typeof result === 'object' && 'ok' in result) {
    return result as SendResult;
  }
  return { ok: true };
}

export async function deliverFinalResponse(
  context: FinalResponseDeliveryContext,
  response: FinalizedBridgeResponse,
  options: FinalResponseDeliveryOptions = {},
): Promise<SendResult> {
  let lastResult: SendResult = { ok: true };
  const deliverResponse = context.deliverResponse || defaultDeliverResponse;

  if (!options.skipText && response.text.trim()) {
    if (context.deliverText) {
      lastResult = await context.deliverText(response.text);
    } else {
      lastResult = normalizeUnknownSendResult(await deliverResponse(
        context.adapter,
        context.address,
        response.text,
        context.sessionId,
        context.replyToMessageId,
        [],
      ));
    }
    if (!lastResult.ok) return lastResult;
  }

  if (response.attachments.length > 0) {
    lastResult = normalizeUnknownSendResult(await deliverResponse(
      context.adapter,
      context.address,
      '',
      context.sessionId,
      context.replyToMessageId,
      response.attachments,
    ));
    if (!lastResult.ok) return lastResult;
  }

  return lastResult;
}

export async function finalizeStreamingUi(
  target: StreamFeedbackTarget,
  status: 'completed' | 'interrupted' | 'error',
  response: Pick<FinalizedBridgeResponse, 'text'>,
): Promise<boolean> {
  return finalizeStreamFeedback(target, status, response.text);
}
