---
title: Isolated Workspaces
---

# ARC-AI Workspaces

This document describes the **current** workspace model: ownership, scoping, and isolation.

---

## Ownership Model

- `Workspace.owner` is an **ObjectId reference to a real user**. Only signed-in users own workspaces.
- **Guests** (`guest_<uuid>` actors) are short-circuited out of workspace routes and resolve to `null` workspace context — they get a from-guest-scoped conversation experience but no persistent workspace or long-term memory.
- The canonical actor abstraction (`server/lib/actor.js`) guarantees REST and Socket.IO agree on whose workspace is active.

---

## Resolution

`WorkspaceRuntimeManager.resolveWorkspace()` (`server/services/WorkspaceRuntimeManager.js`) resolves the active workspace per request/socket:

1. explicit `workspaceId` (ownership-validated)
2. user's oldest non-archived workspace
3. auto-created **Default Workspace** (with `vectorNamespace = workspace_<id>`, plus background migration of legacy unscoped documents)

`injectWorkspaceContext()` exposes `{ workspaceId, vectorNamespace, settings, metadata }` to the AI pipeline.

---

## Isolation & Scoping

Every major runtime entity carries `workspaceId`:

- conversations
- messages
- memories (`AIMemory`, `UserFact`)
- executions
- search / retrieval
- vector indexing (Pinecone namespaces `workspace_<id>`)

No cross-workspace leakage is permitted: retrieval, memory writes, and search are always scoped to the active workspace.

---

## Runtime Safety

- Switching workspaces rebinds execution + conversation state without stale-context leakage.
- Socket listeners are workspace-aware (`workspace:switch` broadcasts to all of the user's sockets).
- Execution buckets (`TaskPlanner`, `TaskExecutor`, `ToolRecoveryManager`) remain workspace-scoped; retries and replans never leave the workspace boundary.

---

## Routes (all `protect`)

- `GET /api/workspaces/` — list non-archived workspaces
- `GET /api/workspaces/active` — resolve active workspace
- `POST /api/workspaces/` — create (generates `vectorNamespace`)
- `PUT /api/workspaces/:workspaceId` — rename / visibility / settings
- `DELETE /api/workspaces/:workspaceId` — soft-delete (archive)

---

## Relations

- Runtime + persistence: [`architecture-and-runtime.md`](./architecture-and-runtime.md)
- Memory scoping: [`memory-and-rag.md`](./memory-and-rag.md)