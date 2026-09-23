# JARVIS Action Substrate — Slices 1, 2, 3, 4A & 4B (handoff)

Additive architectural substrate for JARVIS. Slice 1 introduced a unified
capability metadata layer; slice 2 added a normalized execution envelope +
lifecycle observability around the existing single execution choke point;
slice 3 adds idempotency + duplicate side-effect protection at that same
single choke point; slice 4A adds a server-authoritative, capability-keyed
authorization policy layer and completes native risk/scope classification;
slice 4B enforces that authorization verdict at the same single execution
choke point (explicit DENIED and MCP denials block before any side effect),
while approval-required stays transitional.

Status: slice 1 committed (`855da62`), slice 2 committed (`a2d55e2`, pushed),
slice 3 committed (`fb56e45`, pushed), slice 4A committed (`ffb1d4d`, pushed),
slice 4B implemented and validated but **not yet committed** (pending review).

## Integration boundary

Exactly one governed execution path exists: `TaskExecutor.executeTool`
(`server/services/TaskExecutor.js`). It is the shared choke point for native
tools (`toolRegistry.getTool`) and MCP tools (`McpToolSource.resolveTool`
fallback). Slice 2 wraps this method; it does not introduce a second execution
engine.

Call sites that continue to use the choke point unchanged:
`AIService.js` (`:3245/3718/3755/4394/6036/6613/6694`), `TaskPlanner.js:104`,
`ToolRecoveryManager.js` (`:187/220/253`).

## Idempotency + duplicate side-effect protection (slice 3)

One consistent substrate mechanism added at `TaskExecutor.executeTool` — NOT
per-tool, per-adapter, or in AIService/planner/frontend.

### Key model

- `executionId` = physical instance (`cap-<uuid>`), always unique.
- `idempotencyKey` = logical identity of one *intended* action. The same
  logical key → one side effect; duplicates get a replay result, never a
  second execution.
- Logical key source, in priority order: explicit
  `executionOptions.idempotencyKey`, else `requestId`, else `toolCallId`.
  If none is present the guard is **disabled** and the request passes through
  exactly as before (the narrowest safe fallback — args are never hashed).
- Stored key = `sha256(capabilityId \0 userId \0 workspaceId \0
  conversationId \0 logicalKey)` so the same key never collides across
  capability, user, workspace or conversation. Only the key + a 12-char
  `keyHash` are persisted/logged; raw logical keys never hit logs.

### Store (`idempotencyStore.js`)

- DB-backed path: Mongoose `IdempotencyRecord` (unique index on `key`),
  atomic reservation via `findOneAndUpdate({key}, {$setOnInsert}, {upsert,
  new, includeResultMetadata})` — only the winner sees
  `lastErrorObject.updatedExisting === false`. NOTE: mongoose 8.x silently
  IGNORES `rawResult: true` (returns the hydrated doc, so `updatedExisting`
  is always absent); the correct option is `includeResultMetadata: true`.
  Race collisions that surface as `E11000` are read back and treated as a
  duplicate (never fail-open by accident).
- In-memory fallback (DB-free / test env, mirrors `mcp/configStore.js`):
  per-key promise-chain mutex (`withKeyLock`) — a real serialization
  boundary, not a map-contains check.
- Persisted fields are safe only: key, capabilityId, source,
  userId/workspaceId/conversationId, executionId, status,
  outcome{status, errorType, durationMs}, duplicateCount, timestamps.
  Never args, outputs, or credentials.

### Semantics

- First request reserves RUNNING and executes; duplicates of SUCCEEDED
  replay `{success:true, replay:true, duplicateOf, outcome}`.
- Duplicate while original RUNNING → `{success:false, replay:true,
  inProgress:true, duplicateOf}`.
- FAILED / CANCELLED are terminal: duplicates replay the outcome, NEVER
  auto-reuse or retry (documented; no retry system in this slice).
- Store failure is **fail-open** (`decision:'execute'`, emits
  `capability.idempotency.reservationError`) — a storage hiccup can never
  fabricate a duplicate or block execution. This includes a THROWING store:
  `preflight` wraps `store.reserve` in a try/catch so an unexpected rejection
  is treated as fail-open (never propagates out of `executeTool` and fails the
  request fail-CLOSED by accident). `settle` also never throws (post-execution
  settlement can never fail the returned result).
- Preflight runs before `envelope.start()`, so duplicates emit only
  `capability.idempotency.duplicatePrevented`, never a `started`/terminal
  event. Settlement (`settle`) records terminal statuses.

### Failure-mode trade-off (explicit, verified)

Fail-open is DELIBERATE: availability over strict-once. Consequence proven by
`idempotency.failureMode.test.js`: while the store is down, two requests with
the same logical key can BOTH execute the side effect (duplicate window). It
is NOT differentiated by capability risk/scope — a read tool and a
state-changing tool behave identically when the store is down; no risk-tiered
fail-open/fail-closed policy exists in this slice. Behavior on recovery: keys
that were never reserved during the outage are reserved by the first
post-recovery request (no stale phantom replay), then dedup resumes. A
risk-aware fail-closed policy for high-risk capabilities is an architectural
decision and is intentionally deferred.

### Integration

`TaskExecutor.executeTool`: create envelope → `idempotency.preflight` →
`decision !== 'execute'`? return `gate.result` (tool, credit charge, and
client action never run) → `envelope.idempotencyKey = gate.idempotency.keyHash`
→ `envelope.start()` → unmodified `_executeToolCore` → `envelope.finalize` →
`idempotency.settle`. Key derivation + replay builders are pure
(`idempotencyKey.js`); the orchestrator is `idempotency.js`.

## Execution envelope (`server/lib/capabilities/executionEnvelope.js`)

`createExecutionEnvelope(opts)` → `ExecutionEnvelope`. `TaskExecutor.executeTool`
creates the envelope, calls `start()`, runs the unmodified `_executeToolCore`,
and passes the original result object to `finalize(result)`, which returns it
unchanged.

Fields recorded (metadata only — nothing is enforced here):

| Field | Source |
| --- | --- |
| `executionId` | `cap-<uuid>` (never collides with existing `mcp-…` plan ids) |
| `idempotencyKey` | redacted 12-char `keyHash` set by the slice-3 preflight (slice 2 contract unchanged when disabled) |
| `toolName`, `userId`, `workspaceId`, `conversationId` | call-site options |
| `capabilityId`, `source`, `risk`, `scope` | slice-1 discovery builders over the authoritative native/MCP registries |
| `declaredTimeoutMs` | `exec.timeoutMs` if numeric, else MCP default `limits.REQUEST_TIMEOUT_MS` (30000), else null |
| `cancellationDeclaration` | `'cooperative'` |
| `signalProvided`, `signalAbortedAtStart` | existing signal contract only |
| `status` | `started → running → succeeded \| failed \| cancelled` |
| `errorType` | conservative classification (see below) |
| `startedAtMs`, `completedAtMs`, `durationMs` | lifecycle timestamps |

Guarantees:
- one `start` + exactly one terminal event; a terminal can never be emitted twice
- existing tool/adapter result objects pass through byte-for-byte
- no new timeouts, no new cancellation, no retries, no fallback, no compensation

## Lifecycle observability (`observability.js`)

Events (`[Capability]` prefix, mirrors `server/lib/mcp/logger.js`):
`capability.execution.started / succeeded / failed / cancelled` plus slice 3's
`capability.idempotency.duplicatePrevented` / `capability.idempotency.reservationError`.
Emission is deferred via `enqueueMicrotask` and never throws. Log payloads are
pruned to a `SAFE_FIELDS` whitelist; tool inputs/outputs, nested results,
payload fields and secret-looking keys are dropped. Slice 3 added the safe
fields `idempotencyKeyHash`, `duplicateDetected`, `duplicateStatus` (the
redacted hash is the only idempotency identity ever logged).

## Error classification (`envelopeClassification.js`)

Pure mapping, existing `mcp.*` categories preserved:
- `invalid_arguments` → `validation`
- `not_authorized`, `auth_required`, `authentication_failed` → `authorization`
- `execution.not_authorized` (slice 4B normalized authorization failure) → `authorization`
- `connection_timeout` → `timeout`
- `cancelled` → `cancelled`
- `tool_not_found`, `tool_execution_error`, `output_too_large` → `tool`
- `server_unavailable`, `protocol_error`, `not_connected` → `provider`
- credit `blocked / BLOCKED` → `blocked`
- unclassified failure result → `tool`; exhausted/null → `unknown`

## Facade

`server/lib/capabilities/index.js` exposes the slice-1 surface plus
`ExecutionEnvelope`, `createExecutionEnvelope`, `resolveExecutionCapability`,
`envelopeClassification`, `observability`, and the slice-3 surface
`idempotency`, `idempotencyKey`, `idempotencyStore`. No duplicate registry, no
`execute*` facade, no tool-selection/context-budget changes.

## Tests

- `server/tests/capabilities.test.js` — 16/16 (slice 1 + 4A native
  classification completeness).
- `server/tests/executionEnvelope.test.js` — 22/22: envelope id/lifecycle/
  terminal-once/pass-through, native + MCP shape preservation, timeout &
  cancellation metadata, observability pruning (secrets never logged),
  capability metadata parity with the authoritative registries, no duplicate
  registry/execution path, provider-visible tool selection byte-identical
  after envelope executions, live registries untouched.
- `server/tests/idempotency.test.js` — 22/22 (in-memory store, as documented
  above).
- `server/tests/idempotency.mongo.test.js` — 14/14 REAL Mongo acceptance
  (disposable DB, real `IdempotencyRecord` + reservation code): unique-index
  exists, first-reserves, sequential/duplicate/replay, 16-way concurrent race
  → exactly 1 winner, settle persists the same record, fresh OS process reads
  the settled record (process boundary), scope collision separation, real
  native + MCP end-to-end first-execute → persisted settle → replay, and a
  concurrent pair (1 exec + 1 replay).
- `server/tests/idempotency.failureMode.test.js` — 8/8 fail-open semantics
  (reservation error and throw both proceed; reservationError emitted;
  duplicate-window consequence + concurrent case both proven; not
  risk-differentiated; recovery resumes dedup; settle failure never fails the
  result).
- `server/tests/authorizationPolicy.test.js` — 23/23 (slice 4A): verdict
  model (auto / approval-required / deny / unspecified), scope-derived
  defaults, explicit operator policy, guest + workspace gating, MCP denial
  never converted to allow, identity-substitution and malformed-metadata
  fail-safe, authoritative-substrate identity resolution, purity/
  determinism, no provider/model/Jev coupling, complete native
  classification + per-tool assertions.
- `server/tests/taskExecutorAuthorization.test.js` — 20/20 (slice 4B):
  native AUTO executes with an unmodified result shape; DENIED never runs
  the tool body, never charges credits, emits no clientAction/socket event;
  APPROVAL_REQUIRED stays transitional (executes, verdict observable only);
  MCP policy denial stays denied and a capability allow cannot override it;
  an MCP tool authorized by the live in-memory pipeline executes; direct
  TaskExecutor calls and recovery retries cannot bypass DENIED; verdicts key
  on the authoritative capability id; forged `mcpAuthorized` claims, unknown
  capabilities and malformed policies all fail safe; idempotency still
  deduplicates allowed and denied executions; the envelope records a single
  authorization failure; Jev is never consulted; a source scan proves no
  second execution path exists.
- `mcpPolicy` R-12 (part of slice 4B behavior change): the outer
  `TaskExecutor.executeTool` result for an MCP-policy-denied tool is now
  normalized to `execution.not_authorized` (with `authorization.policySource:
  'mcp-authority'`). The MCP rejection stub itself still reports
  `mcp.not_authorized` when invoked directly (unchanged MCP contract).
- Full regression green except two pre-existing failures not caused by this
  work: `mcpSinglePath` S-08 (quote-style source assertion) and
  `ttsFirstChunk` (2 chunk-merging assertions, fail on pristine HEAD too).
- Note (`mcpSinglePath` uses the same whitelisted-log assertion technique as
  the envelope suite; the SQL `NEW`/wal handling is unchanged).

## Authorization policy + complete native classification (slice 4A)

`server/lib/capabilities/authorizationPolicy.js` is the first authoritative
execution-authorization layer. It is a **pure, deterministic, capability-keyed
verdict engine**: capability metadata + execution context + operator policy in,
normalized verdict out. It executes nothing, never invokes the provider/model,
never touches Jev, and creates no pending approval state. Exported on the
substrate facade as `authorizationPolicy`.

### Verdict model (transitional, slice 4A)

`{ allowed, requiresApproval, state, reason, policySource, risk, scope }`

- `UNSPECIFIED` → **preserve existing behavior** (allowed immediately, no
  approval). Legacy-compatible; an absent policy entry never breaks ARC.
- `AUTO` → allowed immediately (low-risk reads/reversible actions, or an
  operator override).
- `APPROVAL_REQUIRED` → `requiresApproval: true` **and** `allowed: true`
  (provisional). Approval-required is a VERDICT ONLY in 4A — it is NOT
  silently treated as denied while the approval transport does not exist.
- `DENIED` → execution authorization fails (`allowed: false`). Reached via an
  explicit operator `deny`, guest/workspace restriction, identity mismatch,
  malformed metadata, or MCP denial.
- `mode: 'enforce'` (future): turns `APPROVAL_REQUIRED` into `allowed: false`,
  still gated by a real approval transport.

### Default policy

The 4A default operator table is empty (`DEFAULT_POLICY`): every capability
follows its scope/risk-derived default. Policy entries are matched by exact
capability id first, then source+name. Configurable (additive) dimensions:
`entries` (auto / approval_required / deny / unspecified), `guestDenied`
(capability-id list), `workspaceRestricted` ({ id?, workspaceIds }).

### MCP remains authoritative

The engine can only consume the **already-authorized MCP capability
projection**: for `source: 'mcp'`, `mcpAuthorized` must be `true`, else the
verdict is DENIED (`mcp-denied` / `mcp-policy-unconfirmed`) from
`MCP_AUTHORITY`. An MCP denial can never be converted into allow here; on top
of an MCP allow, capability-tier approval semantics still apply (e.g. a
consequential MCP tool also yields `approval_required`). Native capabilities
ignore `mcpAuthorized`.

### Jev remains advisory

The engine never reads the decision plane; `needsConfirmation` from Jev stays
a decision-plane input. Execution-time authorization derives from resolved
capability + context + policy.

### Complete native classification

The native classification table (`server/lib/capabilities/risk.js`) now covers
every registered native tool (22), classified from each tool implementation:

- **read / low:** getTime, getWeather, getTopNews, webSearch, scrapeWebsite,
  checkCalendar, recallMemory
- **read / medium:** executeCode (hardened sandbox, arbitrary compute),
  deepResearchSwarm (network-heavy multi-agent read)
- **reversible / low:** playMedia, stopMedia, changeTheme, openWebsite,
  copyToClipboard, createReminder, setReminder, stopReminder, memorize,
  storeUserFact
- **consequential / high:** sendEmail, sendWhatsAppMessage, scheduleMeeting
  (irreversible external side effects)

The classification remains **metadata** in this slice: it flows into
capability discovery and is consumed by the policy engine, but nothing gates
execution on it yet. The taxonomy has no destructive category; high-impact
tools are classified conservatively within read/reversible/consequential.

### Integration boundary

The policy engine analyses resolved capabilities from the authoritative
substrate (`authorizationPolicy` receives a Slice-1 capability object resolved
via `discoverNative` / `buildCapabilityRegistry`); it does not create another
registry. Identity is validated against the substrate shape (native `id`/wire
form and MCP wire-form/server-slug), so capability id/source cannot be
substituted. Slice 4B now wires `authorizeCapability` into the TaskExecutor
choke point (see below); the approval transport/UI remain deferred together
with subsequent slices.

## Execution-time authorization enforcement (slice 4B)

`authorizationPolicy` verdicts are now enforced at the single governed
execution choke point: `TaskExecutor._executeToolCore` (`executeTool`). This is
the only place authorization is checked; there is no second executor, no
duplicated MCP policy, and capability resolution stays inside the substrate
(not in tools).

### Authoritative flow (in order)

1. Resolve the tool (native `toolRegistry.getTool` → MCP
   `McpToolSource.resolveTool` fallback; native can never be shadowed).
2. Unknown tool → existing `Tool X not found` failure (unchanged).
3. **Authorization gate** (`_authorizeExecution`), running BEFORE credits,
   clientAction emission, recovery/retry, provider fallback and any side
   effect:
   - authoritative capability = `resolveExecutionCapability(...)` (slice-1
     builders over the live registries);
   - MCP projection = `mcpAuthorizedFor(...)`, a READ-ONLY view over the MCP
     pipeline's own matchers (`McpToolSource.registry.toolByWireName` /
     `registry.get` / `configsForWorkspace` / `toolAllowed`) — no MCP policy
     is duplicated and `McpManager`/`McpRegistry` are untouched;
   - policy = per-request `executionOptions.authorizationPolicy` (future
     hook) → `operatorPolicy.getOperatorPolicy()` → `DEFAULT_POLICY` (empty);
   - verdict = `authorizeCapability(capability, { userId, workspaceId,
     isGuest }, { policy, mcpAuthorized })`;
   - emit safe observability event only
     (`capability.authorization.allowed / denied / approval_required`).
4. DENIED → return the normalized failure `{ success: false, error:
   'Tool <name> is not authorized for this action.', errorType:
   'execution.not_authorized', tool, authorization: { capabilityId, source,
   risk, scope, state, reason, policySource, requiresApproval } }`. The tool
   body, credits, clientAction, socket events, recovery/retry and provider
   fallback all never run. The result still flows through the envelope term
   (`failed` / `authorization`) and idempotency settlement, so denied
   attempts record and deduplicate exactly like any other terminal.
5. ALLOWED → continue the existing flow verbatim: credits (unless
   `skipCreditCharge`), signal check, then the single `tool.execute(...)`
   call. Successful results are byte-for-byte unchanged and never carry an
   `authorization` key.

### Ordering (documented)

`envelope.start()` and idempotency preflight intentionally precede the gate in
`executeTool` (unchanged slice-2/3 contract). Inside `_executeToolCore`:
resolve → unknown-check → **authorization gate** → signal check → credits →
signal check → `tool.execute`. No unnecessary reordering of envelope or
idempotency semantics.

### DENIED behavior (slice 4B)

- explicit operator deny (by capability id, or source+name) → blocked
- guest/workspace restriction, identity mismatch, malformed capability or
  malformed policy → blocked (fail safe)
- MCP policy denial (or unconfirmed MCP admission) → blocked; a capability
  AUTO/approval entry can never override an MCP denial
- forged `mcpAuthorized` on a native/denied tool → blocked (native ignores the
  projection; `capability.source` stays authoritative)

### APPROVAL_REQUIRED stays transitional (NOT blocked in 4B)

The approval transport (Socket.IO approval events, pending-approval state) and
the approval UI do not exist yet. APPROVAL_REQUIRED therefore still executes
now and is surfaced ONLY as the `capability.authorization.approval_required`
observability event + `requiresApproval` metadata on allowed results — no fake
approval event, no pending state is created. Blocking on approval is an
explicit non-goal of 4B (deferred to a later slice that adds the transport
first).

### MCP authority preserved

`McpManager.resolveTool` still performs its own final admission recheck during
execution; the gate only consumes the pipeline projection. An MCP-policy
denial now short-circuits at the gate (before any MCP network call) and the
outer result is normalized to `execution.not_authorized`; the MCP rejection
stub itself still reports `mcp.not_authorized` when invoked directly.

### Direct-execution protection

There is no bypass: the main loop, continuation, planner, `ToolRecoveryManager`
and every other `AIService` path converge on `TaskExecutor.executeTool`.
`taskExecutorAuthorization.test.js` includes source scans proving no other
`execute(...)` call, no `_executeToolCore` invocation and no duplicate
execution path exist outside the choke point; behavioral tests call
`TaskExecutor.executeTool` directly and via `ToolRecoveryManager` and confirm
DENIED holds on both.

### Process-wide operator policy (`server/lib/capabilities/operatorPolicy.js`)

A tiny accessor: `setOperatorPolicy` / `getOperatorPolicy` /
`resetOperatorPolicy`, defaulting to `DEFAULT_POLICY` (empty) at boot and after
reset. It is the process-wide base for operator configuration; per-request
`executionOptions.authorizationPolicy` takes precedence. NOT a store — no
persistence, no per-workspace CRUD (those come with the approval/admin slice).

### What remains for later slices (4C+)

Approval transport (Socket.IO approval events + pending-approval state),
approval/admin UI, enforcement of APPROVAL_REQUIRED (block until approved),
runtime policy refresh + persistence, per-workspace policy CRUD.

## Manual validation (no live providers configured)

Real native `getTime`, real in-memory MCP (read + failing tool + aborted
signal), unknown-tool rejection, and a native failure all produce correct
terminal events with safe logs and unchanged result shapes. Real idempotency
flow: native getTime twice with the same key → one execution + one replay;
in-memory MCP read twice with same key → one server call + one replay; same
key across two users → both execute (no false collision).

Slice 4B manual check (real local execution path, DB-attached TaskExecutor):
default `getTime` executes with an unchanged result shape (no `authorization`
key); an operator deny on the harmless `changeTheme` fixture → rejected with
`execution.not_authorized`, no clientAction and no side effect; undernied
`changeTheme` still returns its `CHANGE_THEME` clientAction; a direct
`getTime` call under a deny is equally rejected (no bypass); the operator
policy default is empty and resets cleanly, so no policy change persists after
the check. MCP denial is validated by the in-memory server tests (denied wire
tool rejected at the gate; pipeline-authorized tool executes).

## Intentionally NOT implemented (deferred)

- Retries / recovery orchestration / proactive jobs / new capabilities
- Durable plan state (the plan-level `Execution` model), compensation
- Any new timeout or cancellation mechanism
- Planner integration (a later slice builds on this envelope)
- Idempotency wiring inside individual native tools / MCP adapters /
  AIService / planner / frontend — a single substrate mechanism only
- Risk-aware fail-closed policy for high-risk capabilities during store
  outages (deliberate architectural decision, not part of this slice —
  fail-open is uniform today)
- **Slice 4A → 4B boundary:** enforcement of `authorizationPolicy` verdicts
  inside TaskExecutor / execution path is DONE in 4B (DENIED + MCP denials
  block; approval-required is deliberately NOT blocked yet because no
  approval transport exists). Still deferred: approval transport (Socket.IO
  approval events, pending-approval state); approval UI; runtime policy
  refresh + persistence; per-workspace policy CRUD; guest-native and
  workspace gating is enforced through the gate since 4B. Jev remains
  untouched by 4A/4B.

## Environment note (pre-existing, unrelated)

In ad-hoc `node -e` harnesses that `require('abort-controller')` **after**
`TaskExecutor`, the tool registry logs
`Failed to load tool ...sendWhatsAppMessage.js: AbortController is not defined`.
Reproduced identically on pristine HEAD; real test suites do not trigger it.