# ARC-AI Memory and RAG

This document describes the **current** memory stack, retrieval architecture, and workspace-scoped memory governance.

---

## Memory Stack

ARC-AI combines two persistence layers:

| Layer | Backend | Purpose |
| --- | --- | --- |
| **Structured memory** | MongoDB (`AIMemory`, `UserFact`) | Long-term, queryable records; user facts; pinned/editable entries |
| **Semantic memory** | Pinecone vectors + Mistral `mistral-embed` | Similarity retrieval over conversation snippets |

- **Embeddings** — `embeddingService` (Mistral `mistral-embed`) with an SHA1-based LRU cache (max ~200 entries), text truncated/normalized before embedding.
- **Vector writes** — `workspaceIndexService.upsertTextVector()` is called *in the background* after exchanges; never blocks streaming.

---

## Memory Learning

- After each successful exchange ARC may write an `AIMemory` document `{ userId, query, response, source }`.
- Learning is gated by the user's `memoryLearningEnabled` preference (memory route: `PATCH /api/memory/preferences`).
- **Guest limitation:** guest sessions do **not** write `AIMemory`/`UserFact`, do **not** upsert vectors, and receive **no** memory-search results (search short-circuits to empty for guest actors). Guests keep only conversation-scoped state.

---

## Memory Separation

1. **Conversation History** — the current conversation's messages (short-term context).
2. **Working Context** — the recent in-flight exchange assembled by `WorkspaceContextManager`.
3. **Semantic Memory** — Pinecone vector recall.
4. **Long-Term User Facts** — `UserFact` documents injected as "CRITICAL CONTEXT" into the system prompt (up to 12 most recent, non-guest only).

This separation isolates short-term conversation noise from durable memory.

---

## Workspace-Aware Retrieval

`WorkspaceSearchService` (`server/services/workspaceSearchService.js`) runs these searches in parallel:

| Source | Notes |
| --- | --- |
| Conversations | Title + last-message keyword match |
| Messages | Content keyword match |
| Structured memory | `UserFact.fact` + `AIMemory.query/response/tags` keyword match |
| Semantic vectors | Pinecone similarity (cosine) |

Ranking combines relevance scoring, **recency weighting** (`1/(1+ageDays/14)`), and **duplicate suppression**; `WorkspaceContextManager` then merges long-term + short-term items with a momentum-adjusted score and returns the top items.

Everything is scoped by **workspace**: Pinecone namespaces are `workspace_<id>` / `user_<id>`, and search/retrieval never crosses workspaces.

---

## Memory Management System

- remembered-facts dashboard (`GET /api/memory/`; guests get an empty dashboard)
- editable / pinnable / deletable long-term memory (`PATCH`/`DELETE` on `/api/memory/facts/:memoryId`, `/api/memory/semantic/:memoryId`)
- memory-learning preferences

---

## Design Notes & Guardrails

- selective embedding (minimum text length, background writes)
- non-blocking retrieval orchestration
- no cross-workspace leakage

---

## Relations

- Provider routing / models: [`llm-providers.md`](./llm-providers.md)
- Workspace ownership/isolation: [`isolated-workspaces.md`](./isolated-workspaces.md)