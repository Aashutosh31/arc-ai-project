# ARC-AI Architecture and Runtime

This document describes the **current** ARC-AI runtime: identity, the AI pipeline, tool execution, streaming, workspaces, memory, and persistence. It reflects the code as it exists today, not earlier release notes.

Related documents:

- [`llm-providers.md`](./llm-providers.md) — LLMRouter, providers, capabilities, fallback.
- [`advanced-voice.md`](./advanced-voice.md) — Advanced Voice state machine and STT/TTS.
- [`autonomous-tools.md`](./autonomous-tools.md) — the tool registry and execution model.
- [`memory-and-rag.md`](./memory-and-rag.md) — memory learning and workspace-scoped retrieval.
- [`isolated-workspaces.md`](./isolated-workspaces.md) — workspace isolation and ownership.
- [`vision-and-multimodal.md`](./vision-and-multimodal.md) — live vision and multimodal routing.

---

## 1. Conceptual Architecture

```
                         ┌────────────────────────────┐
                         │           User             │
                         └─────────────┬──────────────┘
                                       │  Text / Voice / Vision
                                       ▼
                         ┌────────────────────────────┐
                         │         Client             │
                         │  (React + Vite, React 19)  │
                         └─────────────┬──────────────┘
                                       │ Socket.IO  (ai:stt:final, ai:stream:stop)
                                       │ REST      (auth, conversations, workspaces,
                                       │             memory, search, voice/transcribe)
                                       ▼
                         ┌────────────────────────────┐
                         │  Authentication / Actor    │
                         │  { type: user | guest, id }│
                         │  server/middleware · actor  │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌────────────────────────────┐
                         │        AIService           │
                         │  credits · memory · tools  │
                         │  planning · persistence    │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌────────────────────────────┐
                         │        LLMRouter           │
                         ├────────────────────────────┤
                         │   Groq (primary)           │
                         │   Gemini (multimodal/S-TTS)│
                         │   Mistral (fallback)       │
                         └─────────────┬──────────────┘
                                       ▼
       ┌─────────────────────────────────────────────────┐
       │ Tool Registry / TaskExecutor / TaskPlanner      │
       │ WorkspaceRuntimeManager / Memory (Mongo+Pinecone)│
       └─────────────────────────────┬───────────────────┘
                                     ▼
                         ┌────────────────────────────┐
                         │     Streaming Runtime       │
                         │  Socket.IO chunk delivery   │
                         │  non-blocking persistence   │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌────────────────────────────┐
                         │       Text + TTS           │
                         │  browser speechSynthesis   │
                         │  or server Gemini audio    │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌────────────────────────────┐
                         │          Client            │
                         └────────────────────────────┘
```

### Where things live

| Concern | Location |
| --- | --- |
| **Conversations are persisted** | `Conversation` + `Message` Mongoose documents (`server/models/`), written by `AIService` and routed through `server/routes/conversations.js`. Both are actor- and workspace-scoped. |
| **Workspaces are resolved** | `WorkspaceRuntimeManager.resolveWorkspace()` (`server/services/WorkspaceRuntimeManager.js`) computes the active workspace (explicit id → default → fresh default). `Workspace.owner` is a real-user ObjectId; guests resolve to `null` scoping. |
| **Credits are charged** | `creditService.consumeCredits()` — once per AI request in `AIService.processQuery`, once per tool in `TaskExecutor` (per-tool costs), and once per server voice transcription (`server/routes/voice.js`). |
| **Tools execute** | `TaskExecutor.executeTool()` (single step) or `TaskPlanner.executePlan()` (multi-step plans), both backed by the tool registry `server/tools/index.js`. Recovery via `ToolRecoveryManager`. |
| **Provider fallback occurs** | Inside `LLMRouter.generate()` (non-streaming) and `LLMRouter.createFallbackStream()` (streaming), iterating an availability/capability-filtered provider order. |

---

## 2. Identity & Authentication

- Every auth method — local register/login, Google OAuth, guest session — resolves to one canonical **actor**: `{ type: 'user' | 'guest', id: string }` (`server/lib/actor.js`).
  - **Users:** `id` is the `User` `_id` hex string.
  - **Guests:** `id` is the `GuestSession.sessionId` (e.g. `guest_<uuid>`).
- REST middleware (`server/middleware/authMiddleware.js`) sets `req.actor`; the Socket.IO handshake (`server/index.js`) sets the identical shape on `socket.actor`, so voice/socket identity and REST identity never diverge.
- ObjectId-typed ownership fields (`Workspace.owner`, `AIMemory.userId`, `UserFact.userId`) reference real users only; guests never own documents in those collections.

---

## 3. Request Lifecycle (`AIService.processQuery`)

1. **Credit charge** — 1 credit per AI request; blocked with a user-friendly `bot_error` when balance is insufficient.
2. **Workspace resolution** — `WorkspaceRuntimeManager` resolves/injects the active workspace (id, vector namespace, settings, metadata).
3. **Conversation lifecycle** — for non-guests, a new `Conversation` is created when none is supplied (`ai:conversation:created`); the user `Message` is saved.
4. **Request tracking** — an `AbortController` per socket; a superseding request or `ai:stream:stop` aborts the previous one.
5. **Context assembly** — rule-based calendar-intent classifier, recent `AIMemory` (+ `UserFact` for non-guests), workspace retrieval context (`WorkspaceContextManager`), optional document parsing.
6. **Generation** — `LLMRouter.generate()` with the 22-tool schema set; multimodal requests set `taskMode: 'multimodal'`.
7. **Tool execution** — if `toolCalls` are returned:
   - **Planner path** (`shouldUsePlanner`) → `TaskPlanner.createPlan()` + `executePlan()`, streaming progress events (`execution.*`).
   - **Inline path** → sequential `TaskExecutor.executeTool()`, with `ToolRecoveryManager` recovery.
   - Both paths finish with a **streaming continuation generation** (`makeContinuationGeneration`) that feeds normalized tool results back to the model via `buildProviderContinuationMessages`.
   - `clientAction` results are emitted (`ai:client:action`) so the frontend can actuate the UI.
8. **Streaming delivery** — text chunks are relayed through `StreamingRuntime` (`ai:tts:response:chunk`). If server TTS is active, text is also pushed into a `TtsStreamBuffer` for segment synthesis (`ai:tts:audio`).
9. **Persistence** — final assistant message, `AIMemory` write (non-guest), Pinecone vector upsert (background, non-blocking), optional auto-title.
10. **Abort/interrupt** — stops TTS, persists partial content as an interrupted draft, emits terminal status (never a stuck UI).

---

## 4. Streaming Runtime

`server/lib/llm/StreamingRuntime.js` owns delivery:

- **Provider streaming** — Groq/Gemini/Mistral `stream` generators are consumed chunk-by-chunk; each chunk is emitted over Socket.IO immediately.
- **Zero artificial delay by default** — `LLM_STREAM_CHUNK_DELAY_MS` defaults to `0` (`??` nullish chain, so an explicit `0` stays `0`).
- **Non-blocking persistence** — background callbacks (persistence, vector writes) are chained off-band (`trackCallback`) and **never** gate or break socket delivery.
- **Finalization** — every path terminates with an `isFinal: true` chunk; interruption aborts the stream but still settles terminal state. `consume()` respects `socket.isInterrupted`.

---

## 5. Workspaces & Isolation

- `Workspace.owner` → real-user ObjectId; guests are short-circuited out of workspace routes and resolve to `null` workspace context.
- Every major runtime entity (`Conversation`, `Message`, `AIMemory`, `UserFact`, `Execution`) carries `workspaceId`.
- Pinecone vectors are namespaced per workspace (`workspace_<id>`); search never crosses namespaces.
- Migration/back-compat: `createDefaultWorkspace()` auto-creates a default workspace and migrates legacy unscoped documents.

---

## 6. Persistence

- **MongoDB (Mongoose)** — conversations, messages, memories, user facts, executions, guest sessions, workspaces, users.
- **Pinecone** — semantic vectors, upserted in the background after exchanges (`workspaceIndexService`), namespaced per workspace.
- **Embeddings** — `embeddingService` uses Mistral `mistral-embed` with an SHA1-based LRU cache.

---

## 7. Observability

Structured logs cover: canonical actor ids, workspace resolution/switch, route selection (`route.selected`/`route.completed`), fallback transitions, provider failure classification (`describeProviderFailure` — diagnostics carry *no* keys, audio, or message text), stream interruption/completion, and credits.

---

## 8. Compatibility & Guardrails

- Tool schemas are provider-independent; per-provider translation happens only at the provider adapter boundary.
- Multimodal requests are capability-filtered across the whole provider order (no invalid fallback paths).
- Provider error normalization stamps `providerId`, `providerCode`, `model`, and `keyConfigured` so downstream error messages are truthful.
- All provider request bodies are Unicode-normalized (`toWellFormedUnicode`) to prevent lone-surrogate JSON validation failures.

---

## 9. Historical Timeline

Prior release documentation:

- **v0.10.0–v0.13.0-beta** — persistent workspace foundation, provider-aware routing, multi-workspace runtime, isolated executions (see [`isolated-workspaces.md`](./isolated-workspaces.md)).
- **v1.0.0** — security hardening, WebAssembly code sandboxing, graceful shutdown (see [`v1.0.0-RELEASE.md`](./v1.0.0-RELEASE.md)).

The present document describes the current system. Where older notes contradict the code, the code wins.