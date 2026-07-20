# Codex-to-IM Bridge Architecture

## Module Dependency Graph

```
bridge-manager.ts (orchestrator)
├── channel-adapter.ts (abstract base + registry)
│   └── adapters/
│       ├── feishu-adapter.ts
│       └── weixin-adapter.ts
├── channel-router.ts (address → session binding)
├── conversation-engine.ts (LLM stream processing)
├── permission-broker.ts (tool approval forwarding)
├── delivery-layer.ts (reliable outbound delivery)
├── markdown/
│   ├── ir.ts (intermediate representation)
│   ├── render.ts (generic renderer)
│   └── feishu.ts (Feishu cards/posts)
├── security/
│   ├── validators.ts (input validation)
│   └── rate-limiter.ts (token bucket per chat)
├── types.ts (shared type definitions)
├── host.ts (host interface definitions)
└── context.ts (DI container)
```

## Dependency Injection

All host dependencies are abstracted through interfaces in `host.ts` and accessed via the `BridgeContext` singleton in `context.ts`.

```
┌─────────────┐   implements   ┌──────────────────────┐
│ host.ts     │◄──────────────│ hosts/codepilot.ts   │
│ (interfaces)│                │ (CodePilot adapter)  │
└──────┬──────┘                └──────────────────────┘
       │ injected via
       ▼
┌──────────────┐   used by   ┌──────────────────────────┐
│ context.ts   │────────────►│ All bridge modules       │
│ (DI container)│             │ (via getBridgeContext())  │
└──────────────┘              └──────────────────────────┘
```

**No bridge module imports directly from the host application.** All access goes through `getBridgeContext().store`, `.llm`, `.permissions`, or `.lifecycle`.

## Message Flow

### Inbound (IM → LLM)

1. **Adapter** polls/listens for messages, enqueues `InboundMessage`
2. **Bridge Manager** calls `adapter.consumeOne()`, dispatches to `handleMessage()`
3. Per-session locking via `processWithSessionLock()` — serializes same-session, parallelizes different-session
4. **Channel Router** resolves `ChannelAddress` → `ChannelBinding` (creates session if needed)
5. **Conversation Engine** acquires DB session lock, sends prompt to LLM via `llm.streamChat()`
   - IM-owned sessions use the long-lived Codex app-server in `auto` mode
   - Desktop-backed sessions retain the SDK + Desktop JSONL path because the current Desktop-owned stdio app-server does not publish a shared endpoint
   - app-server may fall back to SDK only before `turn/start` is dispatched
6. SSE stream is consumed server-side:
   - `text` events → accumulated response + streaming preview
   - `permission_request` events → forwarded immediately via Permission Broker
   - `status`/`result` events → SDK session ID capture
7. Response text saved to DB, returned to Bridge Manager

### Codex Session Ownership

- **IM app-server session**: the bridge owns the app-server process and exact `threadId`/`turnId`; loaded threads are reused and released after an idle period. Streamed text, tools, approvals, usage, final text, and attachments still enter the common SSE and delivery pipeline.
- **IM Desktop reuse**: the bridge sends through the SDK and correlates Desktop rollout records by exact turn metadata before a JSONL terminal record can finalize the IM task.
- **Desktop mirror**: Desktop-originated turns are observed from rollout JSONL and delivered to IM without re-execution.

The bridge never attaches to ChatGPT Remote's private relay. Codex CLI daemon/listen support does not make the separately launched Desktop stdio process attachable. `CTI_CODEX_TRANSPORT=sdk` is the operational rollback; `app-server` affects IM-owned sessions only and is ignored for Desktop-backed sessions.

### Outbound (LLM → IM)

1. **Bridge Manager** receives response text, dispatches to `feedback-delivery.ts:deliverResponse()`
2. Platform-specific rendering: Feishu Markdown/cards or plain text fallback
3. **Delivery Layer** handles chunking, rate limiting, retry, dedup, audit logging
4. **Adapter** sends via platform API

### Permission Flow

1. LLM stream emits `permission_request` event (stream blocks)
2. **Permission Broker** formats interactive message with inline buttons
3. **Delivery Layer** sends to IM, records `PermissionLink` in store
4. User clicks button → adapter emits callback `InboundMessage`
5. **Bridge Manager** routes callback to `broker.handlePermissionCallback()`
6. **Permission Broker** validates origin (chat + message ID match), claims atomically, resolves via `PermissionGateway`
7. Stream unblocks and continues

## Key Design Decisions

### globalThis Singletons
Bridge Manager state lives on `globalThis` to survive Next.js HMR. The DI context also uses `globalThis`.

### Deferred Message Acknowledgement
Adapters can defer offset/session acknowledgement until `handleMessage()` completes, preventing message loss on crash.

### Streaming UI Updates
Feishu uses structured streaming cards for text, tool progress, task progress, and runtime status. Other channels fall back to normal delivery unless they implement the optional streaming hooks.

### Session Lock Chains
`processWithSessionLock()` uses Promise chaining — not mutual exclusion — so different sessions process concurrently while same-session messages serialize. Lock cleanup happens in `.finally()`.
