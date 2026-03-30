/**
 * Minimal Mock Host Example
 *
 * Demonstrates how to wire up the Codex-to-IM bridge with mock implementations
 * of all host interfaces. This runs the full bridge pipeline without
 * any real database, LLM, or permission system.
 *
 * Usage:
 *   npx tsx src/lib/bridge/examples/mock-host.ts
 *
 * This example:
 * 1. Creates an in-memory store
 * 2. Creates a mock LLM that echoes back messages
 * 3. Initializes the bridge context
 * 4. Simulates processing a message through the pipeline
 */

import { initBridgeContext } from '../context.js';
import * as router from '../channel-router.js';
import * as engine from '../conversation-engine.js';
import type {
  BridgeStore,
  LLMProvider,
  PermissionGateway,
  LifecycleHooks,
  StreamChatParams,
  BridgeSession,
  BridgeMessage,
} from '../host.js';
import type { ChannelBinding, ChannelType } from '../types.js';

// ── In-memory Store ─────────────────────────────────────────

class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private nextId = 1;

  getSetting(key: string) { return this.settings.get(key) ?? null; }

  getChannelBinding(channelType: string, chatId: string) {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: { channelType: string; chatId: string; codepilotSessionId: string; sdkSessionId?: string; workingDirectory: string; model: string; mode?: string }) {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const id = existing?.id || `binding-${this.nextId++}`;
    const binding: ChannelBinding = {
      id,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory ?? existing?.workingDirectory ?? '',
      model: data.model ?? existing?.model ?? '',
      mode: (data.mode as ChannelBinding['mode']) ?? existing?.mode ?? 'code',
      active: existing?.active ?? true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(key, binding);
    return binding;
  }

  deleteChannelBinding(id: string) {
    for (const [key, binding] of this.bindings) {
      if (binding.id === id) {
        this.bindings.delete(key);
        break;
      }
    }
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
    for (const [key, b] of this.bindings) {
      if (b.id === id) { this.bindings.set(key, { ...b, ...updates }); break; }
    }
  }

  listChannelBindings(_channelType?: ChannelType) { return Array.from(this.bindings.values()); }

  getSession(id: string) { return this.sessions.get(id) ?? null; }

  listSessions() { return Array.from(this.sessions.values()); }

  findSessionBySdkSessionId(sdkSessionId: string) {
    return Array.from(this.sessions.values()).find((session) => session.sdk_session_id === sdkSessionId) ?? null;
  }

  createSession(
    name: string,
    model: string,
    _sp?: string,
    cwd?: string,
    _mode?: string,
    options?: {
      reasoningEffort?: BridgeSession['reasoning_effort'];
      sessionType?: BridgeSession['session_type'];
      hidden?: boolean;
      parentSessionId?: string;
      expiresAt?: string;
    },
  ) {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      id: `session-${this.nextId++}`,
      name,
      working_directory: cwd || '/tmp',
      model,
      preferred_mode: (_mode as BridgeSession['preferred_mode']) || 'code',
      reasoning_effort: options?.reasoningEffort,
      session_type: options?.sessionType || 'normal',
      hidden: options?.hidden === true,
      parent_session_id: options?.parentSessionId,
      expires_at: options?.expiresAt,
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId() {}
  updateSession(sessionId: string, updates: Partial<BridgeSession>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, ...updates, id: session.id, updated_at: new Date().toISOString() });
  }
  deleteSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    for (const [key, binding] of this.bindings) {
      if (binding.codepilotSessionId === sessionId) {
        this.bindings.delete(key);
      }
    }
  }
  addMessage(sessionId: string, role: string, content: string) {
    const msgs = this.messages.get(sessionId) || [];
    msgs.push({ role, content });
    this.messages.set(sessionId, msgs);
  }
  getMessages(sessionId: string) { return { messages: this.messages.get(sessionId) || [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSdkSessionId(sessionId: string, sdkSessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.sdk_session_id = sdkSessionId;
  }
  updateSessionModel() {}
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset() {}
}

// ── Echo LLM (returns user input as response) ───────────────

class EchoLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = `Echo: ${params.prompt}`;
    return new ReadableStream({
      start(controller) {
        // Emit text event
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: response })}\n`);
        // Emit result event
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        })}\n`);
        controller.close();
      },
    });
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== Codex-to-IM Bridge Mock Host Example ===\n');

  // 1. Initialize context
  initBridgeContext({
    store: new InMemoryStore(),
    llm: new EchoLLM(),
    permissions: { resolvePendingPermission: () => true },
    lifecycle: {
      onBridgeStart: () => console.log('[lifecycle] Bridge started'),
      onBridgeStop: () => console.log('[lifecycle] Bridge stopped'),
    },
  });

  // 2. Simulate an inbound message
  const address = { channelType: 'telegram', chatId: '12345', displayName: 'Test User' };

  console.log('Resolving channel binding...');
  const binding = router.resolve(address);
  console.log(`  Session: ${binding.codepilotSessionId}`);
  console.log(`  CWD: ${binding.workingDirectory}\n`);

  // 3. Process message through conversation engine
  console.log('Processing message: "Hello, Claude!"');
  const result = await engine.processMessage(binding, 'Hello, Claude!');

  console.log(`\nResult:`);
  console.log(`  Response: "${result.responseText}"`);
  console.log(`  Has error: ${result.hasError}`);
  console.log(`  Token usage: ${JSON.stringify(result.tokenUsage)}`);

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
