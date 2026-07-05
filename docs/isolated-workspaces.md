---
title: Isolated Workspaces — v0.13.0-beta
---

# 🔥  MAJOR RELEASE: v0.13.0-beta

**Release date:** 2026-05-22

### *Isolated Multi-Workspace Execution & Runtime Orchestration*

ARC-AI has officially evolved beyond a single persistent AI workspace into a **true multi-workspace autonomous runtime environment**. This release introduces isolated execution environments, workspace-aware frontend orchestration, and runtime-safe synchronization while strictly preserving realtime streaming, provider continuity, and execution integrity.

#### 🧠 Multi-Workspace Runtime System & Scoped Conversations

Each workspace now behaves as an isolated intelligent runtime environment.

* **Global Active Workspace State:** Workspace-aware frontend orchestration and scoped retrieval synchronization.
* **Isolated Conversations:** Features scoped real-time conversation synchronization and runtime-safe switching. Conversation state now safely resets/rebinds during workspace transitions without stale context leakage.

#### ⚡ Workspace-Aware Execution & Socket Synchronization

The execution and socket runtime cleanly separate workspace logic, provider orchestration, and streaming internals.

* **Execution Runtime:** Supports isolated execution buckets, scoped execution tracking, and runtime-safe rendering/rebinding. Executions remain correctly scoped during workspace switches and autonomous lifecycles.
* **Socket Safety:** Implemented workspace-safe socket synchronization and isolated real-time event routing. Prevents socket duplication, stale listeners, and cross-workspace execution contamination.

#### 🏗️ Production-Grade Lifecycle & UX Integration

Browser prompt flows have been completely replaced with a polished, execution-aware UX.

* **Workspace Management:** Native modal-based management UI (Create, Rename, Archive/Delete) with inline validation and responsive interaction flows.
* **Platform Direction:** ARC-AI now visually and behaviorally acts as an enterprise-ready, execution-aware operating environment rather than a single conversational thread.

---

For implementation details and architecture notes related to isolated runtimes, see `docs/architecture-and-runtime.md` and the `server/WorkspaceRuntimeManager.js` implementation.
