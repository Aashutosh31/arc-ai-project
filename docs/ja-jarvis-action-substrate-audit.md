# JARVIS Action Substrate — Baseline Audit (feat/jarvis-action-substrate)

Status: AUDIT COMPLETE — SUBSTRATE NOT BUILT
Base: `master` @ `2a998b6` ("Merge pull request #99 ... feature/jev-decision-layer"), repair commit `c9c8c8c` (decision gate wired live).

This document is the deliverable of a read-only architecture audit performed
before starting the JARVIS Action Substrate. It records (a) the confirmed
baseline state, (b) the critical defect found in the baseline, (c) the repair
that was applied to `master`, (d) the capability/execution map the substrate
must integrate with, and (e) the capability contract + first implementation
slice for the substrate (NOT yet implemented).

---

## 1. Baseline verification (pre-repair, `master` @ `2a998b6`)

| Component | Status | Evidence |
| --- | --- | --- |
| MCP Phase 1+2 (server registry, OAuth, tool lifecycle, policy) | PRESENT | `server/lib/mcp/`, `server/models/McpConfig`, OAuth suites green |
| Voice Runtime 2.0 | PRESENT | `server/services/ttsService.js` (VoiceTtsStreamer), mcpOAuth/voice tests green |
| Jev System One decision layer | PRESENT (dead wiring) | `server/services/decision/` — engine, policy, gateway key gate |
| Context budget + safety | PRESENT | `server/lib/context*`, 24/24 suites green |
| Planner + tool continuation | PRESENT | `server/services/TaskPlanner.js`, 9/9 toolContinuation green |

Baseline regression sampled GREEN: contextBudget 18, contextBudgetSafety 6,
decisionLayer 35, toolContinuation 9, messageCursorPagination 13,
conversationContinuity 14, mcpSelection 10, mcpEnforcement 18, mcpServerScope 12,
mcpPolicy 12, mcpExplicitTool 10, mcpCapabilitySelection 22.

> Exception: `mcpSinglePath.test.js` S-08 fails on the PURE baseline and after
> repair. It is a pre-existing test/source mismatch (asserts single-quoted
> `status: 'executing tools'`; source emits double-quoted). Not caused by the
> repair; left untouched.

## 2. Critical baseline defect: live Jev gate was dead (fixed)

`server/services/AIService.js` referenced `this.decisionEngine.decide(...)` and
free `decisionPolicy` at the upstream MCP gate, but neither was ever imported
or assigned anywhere in the module. Every request hit `TypeError: Cannot read
properties of undefined (reading 'decide')`, was caught, and failed open
(`skipMcpGate=false`) — so the MCP gate never actually gated.

Empirically confirmed (pre-repair): `typeof a.decisionEngine === "undefined"`,
and calling the gate threw.

### Fix applied on `master` (`c9c8c8c`)
- Import `const { decisionEngine, decisionPolicy } = require("./decision")`.
- Constructor: `this.decisionEngine = decisionEngine; this.decisionPolicy = decisionPolicy;`
  (facade singleton — `AIService.decisionEngine === facade.decisionEngine`).
- New seam method `evaluateUpstreamDecisionGate({request, query, recentContext,
  workingState, pendingTool, hasAttachment, signal})` with a fail-open contract:
  missing engine → `{decisionGate:null, skipMcpGate:false, reason:"decision-engine-unavailable"}`;
  engine throw/timeout → caught, warn, fail open.
- Site 1 (primary upstream decision, `~4031`): replaced inline gate with
  `const upstreamGate = await this.evaluateUpstreamDecisionGate({...});`
  `const decisionGate = upstreamGate.decisionGate; let skipMcpGate = upstreamGate.skipMcpGate;`.
- Site 2 (working-state re-evaluation, `~4268`): `decisionPolicy.shouldSkipMcp`
  → `this.decisionPolicy.shouldSkipMcp`.
- Scope fix: hoisted `conversationalStreamed` to `processQuery` scope. It was
  declared inside a block that closes at line 5755 but referenced at line 6696
  — a latent ReferenceError on streamless turns, now reachable because the
  high-confidence no-tool fast path actually executes after the gate fix.

### Jev execution surface (unchanged)
Jev is decision-only: `engine.jev` has no `execute`/`executeTool`/`callTool`.
It never runs tools; the tool execution funnel is `server/services/TaskExecutor.js`
(TaskExecutor.js:106) for BOTH native and MCP tools.

### Verification
- `server/tests/aiserviceDecisionGate.test.js` — 13 tests, 13 pass (wiring,
  facade identity, hello→skip true, React→skip true, Linear→skip false,
  attachments/working-state disable skip, engine throw→fail open, legacy
  low-confidence→skip false, missing engine→fail open, decide+policy consulted,
  Jev no execution surface, source-read seam routing).
- `server/tests/aiserviceDecisionGateRequestPath.test.js` — 3 tests, 3 pass
  (real `processQuery` guest flow: "hello" never touches `schemasForRequest`;
  "List my Linear projects" does; Jev never executes).
- Full AIService-dependent regression green: mcpServerScope 12, mcpLiveTrace 10,
  mcpEnforcement 18, mcpVisibility 22, mcpSaveIssue 15, mcpTargetResolution 24,
  mcpCreateRegression 15, mcpPreflight 18, vectorMetadata 5, conversationContinuity 14,
  mcpSelection 10, mcpPolicy 12, mcpExplicitTool 10, mcpCapabilitySelection 22,
  mcpOAuth 30, mcpReconnect 6, mcpPhase2 15, mcpAvailability 17, mcpAdversarial 8,
  mcpPendingArgs 12, mcpSchemaValidation 20, mcpRefresh 4, mcp 22, contextBudget 18,
  contextBudgetSafety 6, toolContinuation 9, messageCursorPagination 13,
  decisionLayer 35, playMedia 6, themeCatalog 6.

## 3. Pre-existing defects found and intentionally NOT fixed

| Defect | Location | Behavior | Decision |
| --- | --- | --- | --- |
| TDZ `effectiveWireName` read before `const` | `server/lib/mcp/McpManager.js:148` vs `:156` | Potential ReferenceError in the workspace-non-visible `resolveTool` deny branch | Documented; left untouched — fixing alters MCP behavior, out of the repair mandate |
| S-08 source-string mismatch | `server/tests/mcpSinglePath.test.js:176` | Asserts single-quote `status: 'executing tools'`; source uses double quotes | Pre-existing test bug; left for a separate decision |

## 4. Capability / execution map (integration points)

| Layer | File | Purpose |
| --- | --- | --- |
| Native registry | `server/tools/index.js` | Loads native capability plugins (`webSearch`, `playMedia`, `storeUserFact`, ...) |
| Execution funnel | `server/services/TaskExecutor.js` (`executeTool` @ :106) | Single entry for native AND MCP tool execution |
| MCP facade | `server/lib/mcp/index.js` (`McpToolSource`) | `schemasForRequest`, `resolveTool`, `getBlockedTools` |
| MCP manager | `server/lib/mcp/McpManager.js` | Connection lifecycle, OAuth, visibility, policy |
| Decision layer | `server/services/decision/index.js` | Facade: `decisionEngine`, `decisionPolicy`, `decisionTypes` |
| AI core | `server/services/AIService.js` | Request path, gate seam (`evaluateUpstreamDecisionGate`), inline loop calling TaskExecutor |
| Observability | `server/lib/mcp/logger.js`, `server/lib/WorkspaceLogger.js` | Structured event logging (mcp.*, workspace I/O) |

## 5. Capability contract (substrate target — NOT built)

```js
{
  id: string,                    // namespaced, e.g. "native.read.webSearch"
  source: "native" | "mcp",
  name: string,                  // registered wire name
  description: string,
  scope: ["read" | "reversible" | "consequential"],
  risk: "low" | "medium" | "high",
  permissions: string[],         // least-privilege grants
  inputSchema: object,           // JSON Schema
  outputSchema: object,
  timeoutMs: number,             // execution deadline
  cancellation: "cooperative" | "hard",
  idempotency: "safe" | "unsafe",// re-execution semantics
  observability: "envelope" | "line"
}
```

## 6. First substrate slice (planned — NOT implemented)

`server/lib/capabilities/*`:
1. inventory loader (registry → capability list, no behavior change)
2. capability metadata schema + validation
3. read-only mapping proofs (native.read=`webSearch`|`checkCalendar`,
   native.reversible=`playMedia`|`changeTheme`, mcp.read, mcp.consequential)
4. regression harness (all 22-item baseline matrix stays green)

The 22-item test plan covers: decision-gate wiring, fail-open contract,
Jev-no-execution invariant, fast-path activation, request-path entry count,
McpManager policy paths, working-state/pending interactions, attachments,
voice/TTS mode, planner vs inline routing, and the pre-existing TDZ/S-08 items
(documented separately).