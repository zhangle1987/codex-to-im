import type { BridgeStore } from './host.js';
import type { ChannelAddress, ChannelBinding } from './types.js';

export type BindingChangeAction =
  | 'auto_create_draft'
  | 'auto_recreate_missing_session'
  | 'switch_draft'
  | 'switch_desktop'
  | 'new_session'
  | 'unbind'
  | 'web_switch'
  | 'web_unbind';

export interface BindingChangeAuditInput {
  action: BindingChangeAction;
  address: Pick<ChannelAddress, 'channelType' | 'chatId' | 'channelProvider' | 'channelAlias'>;
  fromBinding?: ChannelBinding | null;
  toBinding?: ChannelBinding | null;
  messageId?: string;
  source?: string;
  reason?: string;
}

function describeBinding(binding: ChannelBinding | null | undefined): string {
  if (!binding) return 'none';
  const parts = [
    `session=${binding.codepilotSessionId}`,
    `sdk=${binding.sdkSessionId || '-'}`,
    `mode=${binding.mode}`,
  ];
  if (binding.workingDirectory) {
    parts.push(`cwd=${binding.workingDirectory}`);
  }
  return parts.join(', ');
}

export function recordBindingChange(
  store: Pick<BridgeStore, 'insertAuditLog'>,
  input: BindingChangeAuditInput,
): void {
  const from = describeBinding(input.fromBinding);
  const to = describeBinding(input.toBinding);
  const details = [
    `action=${input.action}`,
    `from=[${from}]`,
    `to=[${to}]`,
  ];
  if (input.source) details.push(`source=${input.source}`);
  if (input.reason) details.push(`reason=${input.reason}`);

  store.insertAuditLog({
    channelType: input.address.channelType,
    channelProvider: input.address.channelProvider
      || input.toBinding?.channelProvider
      || input.fromBinding?.channelProvider,
    channelAlias: input.address.channelAlias
      || input.toBinding?.channelAlias
      || input.fromBinding?.channelAlias,
    chatId: input.address.chatId,
    direction: 'inbound',
    messageId: input.messageId || `binding-change:${Date.now()}`,
    summary: `Binding change: ${details.join('; ')}`,
  });
}
