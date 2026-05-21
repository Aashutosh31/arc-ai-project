# ARC-AI Architecture and Runtime

This document consolidates ARC-AI's architectural deep dives across `v0.11.0-beta` and `v0.12.0-beta`, including provider-orchestrated runtime behavior, multi-workspace evolution, and realtime Socket.IO lifecycle guarantees.

---

## Release Timeline

### v0.10.0-beta Foundation

`v0.10.0-beta` established the persistent workspace foundation.

### v0.11.0-beta Intelligence Layer

`v0.11.0-beta` introduced the intelligence layer on top of that foundation:

- semantic workspace search
- intelligent retrieval orchestration
- advanced memory lifecycle management
- provider-aware routing
- multimodal-safe orchestration
- production-hardened streaming/runtime behavior

Live Demo Video: https://www.instagram.com/aashutosh_vaishnav.31/reel/DYXqoNMtwjL/

### v0.12.0-beta Runtime Architecture Evolution

`v0.12.0-beta` expands ARC-AI from assistant behavior into execution-aware runtime infrastructure.

Update 1 Live Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DYfdVKmRQOf/

Update 2 Live Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DYiHRfKRnqU/

---

## Provider-Orchestrated Runtime

ARC-AI now uses a provider-agnostic runtime that separates orchestration from provider adapters.

### Runtime Components

- `server/lib/llm/LLMRouter.js`
- `server/lib/llm/StreamingRuntime.js`
- `server/lib/llm/providers/`

### Provider Strategy

Gemini is prioritized for:

- reasoning
- multimodal tasks
- planning
- tool orchestration
- long-context workflows

Mistral is prioritized for:

- lightweight responses
- summarization
- memory compression
- low-cost fast inference
- fallback generation

### Continuity and Safety Guarantees

- provider continuation chains remain canonical
- tool continuation metadata remains normalized
- `toolCallId` semantics are preserved
- fallback is capability-aware and multimodal-safe
- streaming finalization is guaranteed

---

## Realtime Socket.IO Lifecycle

ARC-AI preserves low-latency realtime interaction while adding runtime intelligence.

### Request Lifecycle

1. Input is captured from voice or text.
2. Frontend emits `ai:stt:final` over Socket.IO.
3. Runtime collects context and routes generation.
4. Tool selection and execution happen inside execution-safe orchestration.
5. Streaming chunks are emitted token-by-token.
6. Finalization and interruption cleanup are guaranteed.

### Lifecycle Properties

- interruption-safe cleanup
- terminal event guarantees
- compatibility with voice workflows
- compatibility with existing conversation persistence
- compatibility with execution recovery layers

---

## Multi-Workspace Runtime (v0.12.0-beta Update 2)

ARC-AI is transitioning from a single global AI session into a multi-workspace intelligent operating environment.

### Primary Architecture Goals

- isolated workspaces
- scoped memory
- scoped executions
- workspace-aware retrieval
- runtime partitioning
- active workspace cognition

### Critical Rules

Workspace isolation must remain:

- deterministic
- provider-agnostic
- execution-safe
- recovery-safe
- streaming-safe

Workspace logic must not:

- alter provider continuation chains
- alter `tool_call_ids`
- mutate canonical reconstruction logic

### Required Runtime Layer

Workspace Runtime Layer introduces:

- `server/models/Workspace.js`
- `server/services/WorkspaceRuntimeManager.js`

`WorkspaceRuntimeManager` responsibilities:

- resolve active workspace
- inject workspace context
- manage workspace-scoped retrieval
- manage workspace-scoped execution state
- expose runtime workspace metadata

---

## Workspace Partitioning Requirements

Every major runtime entity must be workspace-aware with `workspaceId`, including:

- conversations
- memories
- executions
- tasks
- retrievals
- vector indexing
- tool state

No cross-workspace leakage is permitted.

### Vector Namespace Isolation

Workspace retrieval requires namespace partitioning through:

- `workspaceIndexService`
- `workspaceSearchService`

Each workspace must maintain its own vector namespace with scoped indexing and scoped semantic search.

---

## Execution Runtime Isolation

Execution systems are required to remain workspace-scoped:

- `TaskPlanner`
- `TaskExecutor`
- execution model
- `ToolRecoveryManager`

### Isolation Guarantees

- execution ownership is bound to workspace
- retries remain in workspace boundaries
- recovery cannot leak context
- replanning remains workspace-scoped

---

## Backward Compatibility and Migration

The architecture maintains compatibility with existing users and data:

- automatic default workspace creation
- safe migration for old conversations
- safe migration for old memories
- preserved history
- no destructive migrations

---

## Observability

Structured logs are required for:

- workspace activation
- workspace retrieval source
- execution workspace binding
- workspace vector namespace
- workspace switching
- route selection
- fallback usage
- latency
- stream interruption and completion

---

## Compatibility Status

This architecture remains compatible with:

- Socket.IO frontend runtime
- MongoDB persistence
- Pinecone memory system
- dynamic tool registry
- TaskExecutor workflows
- realtime streaming UX
- voice workflows
