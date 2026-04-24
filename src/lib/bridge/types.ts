/**
 * Bridge system types — shared across all bridge modules.
 *
 * The bridge connects external IM channels (Feishu/Lark, Weixin)
 * to local chat sessions, allowing users to interact with the configured LLM
 * from their preferred messaging platform.
 */

// Re-export bridge-local types from host.ts so consumers can import from one place
export type { FileAttachment } from './host.js';

// ── Channel Types ──────────────────────────────────────────────

/**
 * Channel type identifier.
 * Extensible — any string is valid so new adapters can register without
 * modifying this definition. Well-known values: 'feishu', 'weixin'.
 */
export type ChannelType = string;

/** Unique address of a user within a channel */
export interface ChannelAddress {
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;        // Platform-specific chat/channel identifier
  userId?: string;       // Platform-specific user identifier (optional for group chats)
  displayName?: string;  // Human-readable name for audit logs
}

/** Composite key for routing: channelType + chatId */
export interface SessionKey {
  channelType: ChannelType;
  chatId: string;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from an IM channel */
export interface InboundMessage {
  /** Platform-specific message ID (for dedup and reference) */
  messageId: string;
  /** Address of the sender */
  address: ChannelAddress;
  /** Plain text content of the message */
  text: string;
  /** Timestamp of the message (ISO string or unix epoch ms) */
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message that triggered the callback */
  callbackMessageId?: string;
  /** Platform-specific raw update object (for adapter-specific handling) */
  raw?: unknown;
  /** Adapter-specific update ID for deferred offset acknowledgement */
  updateId?: number;
  /** File attachments (images, documents) from the IM channel */
  attachments?: import('./host.js').FileAttachment[];
}

/** Outbound message to send to an IM channel */
export interface OutboundMessage {
  /** Target address */
  address: ChannelAddress;
  /** Message text, optionally using the channel's selected parse mode. */
  text: string;
  /** Parse mode for the text */
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  /** Optional local artifacts to upload and send through the channel. */
  attachments?: OutboundAttachment[];
  /** Inline keyboard buttons */
  inlineButtons?: InlineButton[][];
  /** If replying to a specific message */
  replyToMessageId?: string;
}

/** A local artifact that the bridge should send back to the IM channel. */
export interface OutboundAttachment {
  kind: 'image' | 'file';
  path: string;
  caption?: string;
  name?: string;
}

/** Inline keyboard button for permission prompts */
export interface InlineButton {
  text: string;
  callbackData: string;
}

/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  /** Platform-specific message ID of the sent message */
  messageId?: string;
  error?: string;
}

// ── Bindings ───────────────────────────────────────────────────

/** Links an IM chat to a CodePilot session */
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  chatId: string;
  chatUserId?: string;
  chatDisplayName?: string;
  /** CodePilot session ID this chat is bound to */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Bridge Status ──────────────────────────────────────────────

/** Overall bridge system status */
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/** Status of a single channel adapter */
export interface AdapterStatus {
  channelType: ChannelType;
  channelProvider?: string;
  channelAlias?: string;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// ── Audit & Dedup ──────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  createdAt: string;
}

// ── Streaming Preview ─────────────────────────────────────────

/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
  draftId: number;           // non-zero 31-bit random integer, reused within one answer cycle
  chatId: string;
  lastSentText: string;      // last text actually sent as draft
  lastSentAt: number;        // timestamp (ms) of last sent draft
  degraded: boolean;         // set true after API failure → skip further previews
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;       // latest accumulated text (may not yet be sent due to throttle)
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for streaming card progress display */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

export type TaskProgressStatus = 'in_progress' | 'pending' | 'completed';

/** Structured task / plan progress for product-style streaming UIs. */
export interface TaskProgressInfo {
  text: string;
  status: TaskProgressStatus;
}

// ── Config ─────────────────────────────────────────────────────

/** Platform-specific message length limits */
export const PLATFORM_LIMITS: Record<string, number> = {
  feishu: 30000,
  weixin: 4000,
};
