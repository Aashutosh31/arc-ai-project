# JARVIS Action Substrate — Slices 1, 2, 3, 4A, 4B, 4C, 4D & 4E (handoff)

Additive architectural substrate for JARVIS. Slice 1 introduced a unified
capability metadata layer; slice 2 added a normalized execution envelope +
lifecycle observability around the existing single execution choke point;
slice 3 adds idempotency + duplicate side-effect protection at that same
single choke point; slice 4A adds a server-authoritative, capability-keyed
authorization policy layer and completes native risk/scope classification;
slice 4B enforces that authorization verdict at the same single execution
choke point (explicit DENIED and MCP denials block before any side effect);
slice 4C makes APPROVAL_REQUIRED a real server-authoritative approval
workflow — pending-approval state, a Socket.IO approval transport to the
initiating session only, and a fail-closed approval gate whose APPROVED
decision continues the SAME execution attempt exactly once. The approval
identity includes the INITIATING SOCKET: multiple sockets for one authenticated
user are supported, but a same-user resolve from a different socket is refused
(`socket_mismatch`), and a reconnect — a new connection with a new `socket.id` —
cannot resolve the pre-reconnect approval (it fails closed at its TTL). Slice 4D ships the
conversation-first frontend approval UI: a pure approval state model, a
presentational in-flow card, and the client half of the 4C transport, wired
into the existing dashboard and validated in a real browser. Slice 4E hardens
the edges: owner-scoped workspace identity (incoming workspace ids and plan
executions are bound to the authenticated requester), seeded process-wide
guest hard-deny defaults, and post-approval TOCTOU revalidation that fails
closed if authority was revoked while a human decision was pending.

Status: slice 1 committed (`855da62`), slice 2 committed (`a2d55e2`, pushed),
slice 3 committed (`fb56e45`, pushed), slice 4A committed (`ffb1d4d`, pushed),
slice 4B committed (`9ae8847`, pushed), slice 4C implemented and validated but
**not yet committed** (pending review), slice 4D implemented and validated but
**not yet committed** (pending review), slice 4E implemented and validated but
**not yet committed** (pending review).

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
Slice 4C added the approval lifecycle events
`capability.approval.requested / approved / denied / expired / cancelled` and
extended `SAFE_FIELDS` with `approvalId` and `decision` (tool inputs/outputs,
nested results, payload fields and secret-looking keys remain dropped).
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
  APPROVAL_REQUIRED engages the slice 4C approval gate (without an
  authenticated session it fails closed and never executes); MCP policy
  denial stays denied and a capability allow cannot override it; an MCP tool
  authorized by the live in-memory pipeline executes; direct TaskExecutor
  calls and recovery retries cannot bypass DENIED; verdicts key on the
  authoritative capability id; forged `mcpAuthorized` claims, unknown
  capabilities and malformed policies all fail safe; idempotency still
  deduplicates allowed and denied executions; the envelope records a single
  authorization failure; Jev is never consulted; a source scan proves no
  second execution path exists.
- `server/tests/approvalStore.test.js` — 14/14 (slice 4C): the authoritative
  approval state — create → PENDING with TTL, approve/deny/expire/cancel
  transitions, single-use exactly-one terminal, duplicate/after-deny/
  after-expiry rejections, user/execution/workspace/capability identity
  binding, malformed input and unknown ids.
- `server/tests/taskExecutorApproval.test.js` — 24/24 (slice 4C): the
  execution-time approval gate — no execution before approval; approve
  continues the SAME envelope exactly once; deny/expire/cancel never execute
  and settle a normalized `execution.not_authorized`; credits are charged
  only after approval (once); concurrent approve races have exactly one
  winner; wrong-user and wrong-workspace approvals are rejected; stale
  approvals cannot approve; direct/continuation/planner/recovery paths all
  obey the gate (no bypass, no-session fails closed); MCP denial stays denial;
  idempotency stays correct across the lifecycle (one approval per logical
  action, settled FAILED vs replayable SUCCEEDED, timeout never becomes a
  replayable success); the envelope records single started/succeeded and
  authorization terminal events; the request reaches only the initiating
  socket with safe preview metadata; and a real Socket.IO transport contract
  over raw engine.io websockets proves requested→resolve end-to-end
  (approve once, deny zero, timeout zero, duplicate once, different-user
  socket rejected).
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

### Verdict model (slice 4A)

`{ allowed, requiresApproval, state, reason, policySource, risk, scope }`

- `UNSPECIFIED` → **preserve existing behavior** (allowed immediately, no
  approval). Legacy-compatible; an absent policy entry never breaks ARC.
- `AUTO` → allowed immediately (low-risk reads/reversible actions, or an
  operator override).
- `APPROVAL_REQUIRED` → `requiresApproval: true` **and** `allowed: true`
  (provisional). In 4A/4B this was a verdict only; slice 4C makes it real: the
  gate blocks until the initiating session approves, then continues the SAME
  execution attempt exactly once (see the 4C section). Without an
  authenticated session it fails closed — never silently allowed, never
  executed.
- `DENIED` → execution authorization fails (`allowed: false`). Reached via an
  explicit operator `deny`, guest/workspace restriction, identity mismatch,
  malformed metadata, or MCP denial.
- `mode: 'enforce'` → an alternative that turns `APPROVAL_REQUIRED` into
  `allowed: false`. It exists in the pure engine (`options.mode`) and is
  covered by tests, but `TaskExecutor` does not request it: it uses the
  default transitional mode plus the 4C interactive gate, which keeps the
  approving decision on the same session and never runs two executor attempts.
  The choice does not weaken enforcement — `TaskExecutor` keys the approval
  flow off `requiresApproval`, so a required approval runs in **both** modes.
  `DENIED` is never affected by the mode.

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

### APPROVAL_REQUIRED is real (slice 4C)

Slice 4C replaces the transitional spreadsheet. See the "Approval state +
server-side approval transport (slice 4C)" section below for the gate, the
state model and the transport contract.

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
`executionOptions.authorizationPolicy` takes precedence. Deliberately no-I/O —
the durable authority behind the knob is the Mongo-backed
`operatorPolicySource` (slice 4E item 2), which hydrates this accessor; the
execution path performs zero DB round trips.

### What remains for later slices (4E+)

Runtime policy refresh + persistence is now shipped (slice 4E item 2 — the
Mongo-backed operator policy with bounded refresh). Still deferred:
per-workspace policy CRUD; durable out-of-band approval (mobile push, e-mail
links) and multi-node approval coordination. (The fourth-party approval UI is
now shipped in slice 4D.)

## Approval state + server-side approval transport (slice 4C)

`APPROVAL_REQUIRED` is now a real, server-authoritative approval. A pending
approval is created at the single choke point (`TaskExecutor._executeToolCore`,
`_awaitApproval`), the initiating session is notified on the Socket.IO
transport, and execution WAITS for approve/deny/expire/cancel — then continues
the SAME execution attempt (no second executor, no re-resolution, no duplicated
idempotency reservation). The frontend approval UI ships as slice 4D below; 4C
shipped the state + transport + enforcement only.

### Approval state (`server/lib/capabilities/approvalStore.js`)

- In-memory, per-process, transient **on purpose** (documented tradeoff): an
  approval is a bounded-lifetime interactive gate over an execution attempt
  that is itself in-flight in this process. If the process dies mid-wait, the
  awaiting execution dies with it — a durable record would only orphan state
  or let a stale durable "approved" later release a NEW execution. The
  identity that must survive restarts is the side-effect dedup key, already
  served by the DB-backed idempotencyStore (slice 3).
- States: `PENDING → APPROVED | DENIED | EXPIRED | CANCELLED`. Single-use and
  exactly-once: each terminal transition is an atomic compare-and-swap on the
  record with **no await between check and store**, so concurrent
  approve/deny/timeout/cancel serialize and exactly ONE wins.
- Identity binding at creation: `executionId`, authenticated `userId`,
  `workspaceId` (when applicable), `capabilityId`, **and the initiating
  socket/session id** (`initiatingSocketId`, the server-minted `socket.id` of
  the authenticated connection that raised the request). `resolve()` re-checks
  every value it is given against the stored binding; the transport never trusts
  a client-supplied userId/executionId/socketId.
- **Session identity (P0 #2).** `userId` identifies an *account*, not the
  session that was asked to authorize one consequential action. ARC
  intentionally supports several concurrent sockets for one user
  (`global.connectedSockets` in `server/index.js`), so the initiating
  connection is part of the approval identity: a same-user resolve from a
  different socket is refused with `socket_mismatch`, exactly like
  `user_mismatch`, and the record stays `PENDING` for the real initiator.
  Omitting the socket identity is also a mismatch — never a bypass — and a
  socket without an id cannot raise an approval at all, so no unbound record
  can ever exist. The bound id is stored privately (`_initiatingSocketId`, like
  `_timer`/`_resolve`) and is **not** part of the public snapshot, because the
  transport acks the whole resolve result and a snapshot field would disclose
  the initiating socket's id to a different user. `cancel()` is deliberately
  user-bound only: it has no client-facing event (it is the server's own abort
  rollback) and can only ever turn a pending gate into a failure.
- TTL: `DEFAULT_TTL_MS = 30000`, env `APPROVAL_TTL_MS`, mirroring the MCP
  constant `REQUEST_TIMEOUT_MS` (`server/lib/mcp/limits.js`) — one bounded
  interactive round-trip. Lazy expiry on resolve/cancel plus a per-record
  unref'd timer; a PENDING record past expiry can never approve.
- `approvalId` = `apr-<hex>` — always distinct from `executionId`.
- Exposed on the substrate facade (`approvalStore`) with create/resolve/
  cancel/waitForDecision/read/list + test surface (`_reset`, `_expireNow`).

### The gate (`TaskExecutor._awaitApproval`)

Runs inside `_executeToolCore` right after the authorization verdict, BEFORE
credits, clientAction, recovery/retry and any side effect. Fail-closed by
construction: no bindable authenticated session (`socket.userId` must equal the
executing user **and** the socket must carry a server-minted `id`, never a
client-asserted identity), a store-write failure, or a
failed notification each return the normalized
`{ success:false, errorType:'execution.not_authorized', authorization:{…,
  approvalId, approvalState, decision, reason }, cancelled? }` and NEVER
execute. Only an `APPROVED` decision (or a pending post-approval signal
abort) moves past the gate; approve continues the same call, so credits and
the tool body run exactly once.

Abort/cancel: driven by the execution AbortSignal, not by socket disconnect.
`_abortWatch` races the decision wait; aborting transitions the PENDING record
to `CANCELLED`. Transient Socket.IO reconnects do NOT cancel an in-flight
execution — ARC already supports multi-tab (`global.connectedSockets`) and a
reconnect is not an abort signal.

**Reconnect semantics (documented, deliberate).** This process runs no
`connectionStateRecovery`, so a reconnect is a NEW connection with a NEW
`socket.id`. Because the approval is bound to the connection that was asked,
the replacement connection can never resolve the pre-reconnect approval: it is
non-resolvable from the moment the socket is replaced and the request then
fails closed at its own `APPROVAL_TTL_MS` (default 30s) with
`approvalState: 'EXPIRED'`. The alternative — a client-carried session token
that survives reconnect — would be a client-asserted identity and a new
multi-device/out-of-band approval system (mobile push, approval links), which
is explicitly out of scope for 4C. The cost is therefore one bounded
interactive round-trip lost to a mid-prompt reconnect; the benefit is that one
account can never authorize a consequential action from a session that was not
asked. A reconnect does not cancel the *execution*; the approval simply can no
longer be granted.

### Transport contract

- `agent:approval:requested` (server → initiating session only, safe preview
  metadata — no args, credentials, auth data or outputs): `{ approvalId,
  executionId, capabilityId, toolName, source, risk, scope, reason,
  expiresAt, state }`.
- `agent:approval:resolve` (client → server, wired in `server/index.js`):
  `{ approvalId, decision: 'approve' | 'deny' }` — that is the whole client
  contract. The handler resolves with `socket.userId` **and `socket.id`**, both
  read from the authenticated server socket; `data.socketId` (or any other
  client-asserted socket identity) is deliberately never read, so a forged
  payload field can neither bypass nor re-target the binding. The optional ack
  returns the store result (`{ ok, state, decision?, reason? }`; a refusal also
  echoes the record, which carries no socket identity). Identity/state checks
  happen in the store, so a different user, a different socket of the same user,
  a duplicate, a stale or an expired resolve is rejected exactly once, with
  `socket_mismatch` as the reason for the cross-socket case.

### Observable lifecycle + integration

- New frozen events: `capability.approval.requested / approved / denied /
  expired / cancelled`; `SAFE_FIELDS` extended with `approvalId`, `decision`.
- Approval sits after the idempotency reservation, so one logical action
  yields exactly one approval; DENIED/EXPIRED/CANCELLED approvals settle an
  `authorization` failure (never a replayable success), APPROVED settle
  `SUCCEEDED` (duplicates replay). The envelope records a single
  started→succeeded or a single authorization-failure terminal.
- MCP policy denial remains authoritative and non-overridable; a capability
  approval entry can never override it (no approval is created for an MCP
  denial).

### Part 12 — real localhost transport validation

The `Socket.IO transport` test in `taskExecutorApproval.test.js` boots a real
`http` + `socket.io` Server with test auth middleware (stamping
`socket.userId`), wires the same `agent:approval:resolve` handler shape, runs a
real TaskExecutor (approval policy on harmless `getTime`), and connects real
raw engine.io websocket clients. Verified over the wire: no execution before
approval; requested event reaches the initiating socket with safe metadata; a
different-user socket cannot approve; approve → exactly one execution;
deny → zero executions; too-late response → EXPIRED and zero executions;
duplicate approve → still exactly one execution.

**P0 #2 addition (same-user cross-socket isolation).** Two concurrent
connections for ONE authenticated user, plus a reconnect case, are now covered
on the real transport: the second connection of the same user is refused with
`socket_mismatch` and the record stays `PENDING` for the real initiator, which
still resolves it and executes exactly once; a forged `socketId` in the
payload is ignored from both sides (a sibling claiming the initiator's id is
still refused, and the initiator is unaffected by its own bogus field); a socket
with no id can never raise an approval; omitting the socket identity is a
mismatch, not a bypass; and a reconnect (new `socket.id`) cannot resolve the
pre-reconnect approval, which then fails closed at its TTL. Suites:
`server/tests/approvalStore.test.js` (unit, 21),
`server/tests/taskExecutorApproval.test.js` (29, includes the real-socket
cross-socket + reconnect cases), and
`server/tests/approvalSocketBinding.socket.test.js` (10, boots the real
`server/index.js` with real JWTs over localhost and the real resolve handler).

## Frontend approval UI (slice 4D)

4D is the fourth part of the slice-4 approval story: the dashboard renders a
conversation-first permission card for each pending approval and lets the user
approve/deny it. It is a pure client addition — it **only consumes** the 4C
events and the 4C resolve handler; no backend file was modified and no
approval semantics were changed. The design goal is that a conversation reads
as "ARC asked, the user answered, the server decided".

### Files

- `client/src/lib/approvalUi.js` — pure, dependency-free approval UI state
  machine (normalize / request-add upsert / resolve-start / ack reconcile /
  display-only expiry tick / status & risk & scope & source mapping / pending
  count / socket.io ack normalizers). Single source of truth for every
  transition the UI can take.
- `client/src/contexts/ApprovalContext.jsx` — the only transport owner: it
  subscribes `agent:approval:requested` **directly on the socket** (mirroring
  `ExecutionContext`, deliberately NOT on `useSocket`'s ref-counted
  `SOCKET_EVENTS` teardown scope so another consumer can never strip the
  listener) and is the only place that emits `agent:approval:resolve` with the
  exact 4C payload `{ approvalId, decision }` (identity is socket-bound, never
  sent). A 6s lost-ack timer reverts a stuck card to retryable pending.
- `client/src/components/ApprovalCard.jsx` — presentation-only card: nothing
  in it can auto-approve, emit on the socket, or fabricate a result. Rendered
  inline in the ChatInterface message flow (non-modal, no autofocus, real
  buttons, `role="status"` + `aria-live="polite"` status footer, risk accent
  mirrored by text labels so it is never color-only).
- Wiring: `ApprovalProvider` wraps the routes inside `ExecutionProvider`
  (`client/src/App.jsx`); `ChatInterface.jsx` renders an `ApprovalStack` after
  the typing indicator and binds `onResolve={resolveApproval}`.

### State machine (client view)

`PENDING → BUSY → APPROVED | DENIED | CANCELLED | EXPIRED | ERROR`, plus
`PENDING → EXPIRED` for display when the local clock passes `expiresAt` (the
server's lazy TTL stays the enforcement authority). A double-click race is
guarded on both sides: the UI only starts a resolve from PENDING, and the
server CAS lets exactly one terminal transition win. A resolve whose server
ack is lost (`no-ack`/`network`) reverts to PENDING with a retry note — the
card is never stranded and a later tap self-heals through the server's
`already_resolved` response. Terminal status is never resurrected by a
duplicate `requested` event (upsert is idempotent).

### Safety + wording contract

The card renders only the whitelisted preview fields from the 4C event — args,
credentials, auth data and tool outputs never reach the UI model or the DOM.
Copy is explicit that nothing runs before a decision ("ARC is requesting
permission to use <tool>", "Nothing runs before you decide", "Denied · the
tool will not run", "Expired · no decision was received"). Risk/scope/source
read out as text labels (`High risk`, `Has lasting external effects`,
`MCP tool`) in addition to any accent styling.

### Tests

- `client/tests/approvalUiState.test.mjs` (24) — full state matrix: payload
  whitelist, idempotent upsert, double-click guard, authoritative ack
  (approve/deny/already_resolved/expired), network + lost-ack revert,
  display-only expiry, risk/scope/source labels, and the socket.io ack-arg
  normalizers.
- `client/tests/approvalCardSource.test.mjs` (8) — source regression: card can
  never auto-approve/emit; exact resolve payload; listener registered outside
  the useSocket teardown scope; a11y (live region, keyboard reachable,
  non-blocking); inline stack wiring.
- Real-browser QA (`client/tests/qa/approvalHarnessServer.mjs` +
  `client/tests/qa/test_approval_browser.py`) — Playwright + system Chromium
  against the real dashboard, real `approvalStore`, real socket and the real
  `TaskExecutor` approval gate on `getTime`, all validated across the wire:
  native approve → tool executes exactly once; deny → zero executions with
  `Denied` status; expiry while the card is open (buttons removed, server
  record EXPIRED); rapid double-click → still a single execution; socket
  reconnect (offline → online) → the pending card resolves over the new
  connection; MCP-shaped request renders `High risk` / `MCP tool` /
  consequential scope. Responsive/a11y matrix at 1920/1440/1024/768/390/360:
  no page-level horizontal overflow, cards never cover the composer, decision
  buttons never clipped, and keyboard focus + Enter approves.

## Workspace identity + guest hard-deny + approval TOCTOU (slice 4E)

Slice 4E bolts the remaining hard edges onto the 4B/4C gate:

1. **Workspace identity** — an incoming `workspaceId` may no longer be
   asserted blindly. `WorkspaceRuntimeManager.getWorkspaceById` now accepts an
   optional `ownerUserId` and scopes the lookup to that owner; `resolveWorkspace`
   passes the authenticated `userId`, so a forged/cross-user workspace resolves
   to nothing and falls through to the user's default workspace instead. The
   `ai:stt:final` socket handler mirrors the same owner gate before trusting an
   incoming workspace id. `TaskPlanner.executePlan` additionally requires the
   execution document to belong to the socket-authenticated requester (identical
   `Execution not found` response — no existence leak), even when a matching
   `workspaceId` is supplied.

2. **Seeded guest hard-deny** — `operatorPolicy` now boots with
   `GUEST_DENY_DEFAULTS` (`native:webSearch`, `native:scrapeWebsite`,
   `native:deepResearchSwarm`, `native:sendEmail`,
   `native:sendWhatsAppMessage`, `native:memorize`,
   `native:storeUserFact`, `native:executeCode`, `native:scheduleMeeting`),
   every id verified against the live native registry. Guests are hard-denied
   these external/consequential natives by default even with **no operator
   configuration**, while the frozen pure-engine `DEFAULT_POLICY` remains
   untouched (empty `guestDenied`). `resetOperatorPolicy` restores the seeded
   base.

   The set is **not** hand-maintained on trust: `tests/authorizationPolicy`
   derives it from the live registry plus `nativeRiskFor()` and fails if any
   `consequential`/`high` native is missing (or if the list names an id that no
   longer exists). A newly registered irreversible tool therefore cannot become
   guest-executable by being forgotten here. `native:sendWhatsAppMessage` was
   itself found missing by exactly that check during the Phase 1 closure audit
   and is now covered.

3. **Approval TOCTOU revalidation** — after an approval resolves to `allowed`,
   `TaskExecutor` re-derives the authoritative authorization verdict *before*
   credits or any side effect. If the operator policy / MCP registry /
   workspace membership changed while the human decision was pending, the
   execution is failed closed (`blocked`) — the tool body and credit charge
   never run.

### Files

- `server/services/WorkspaceRuntimeManager.js` — owner-scoped lookup.
- `server/index.js` — `ai:stt:final` owner gate on incoming workspace id.
- `server/services/TaskPlanner.js` — execution ownership check.
- `server/lib/capabilities/operatorPolicy.js` — seeded guest-deny base.
- `server/services/TaskExecutor.js` — post-approval revalidation.
- `server/tests/slice4eIdentifyHarness.test.js` — 11 tests (owner-scoping,
  planner gating, seeded defaults, `DEFAULT_POLICY` immutability, boundary
  enforcement, TOCTOU blocked + normal-approval regression).

### Mongo-backed operator policy + bounded runtime refresh (slice 4E item 2)

Items 1/3/5 (above) made the *in-process* policy conservative. Item 2 makes
the operator policy **durable and operator-manageable** without adding a DB
round trip to the execution path.

- **Model** (`server/models/OperatorPolicy.js`): exactly ONE document lives in
  the collection, guaranteed by a unique `key` (default `operator-policy`). The
  shape mirrors the pure engine exactly: `guestDenied`, `workspaceRestricted`
  (subdoc `{ id, workspaceIds }`), `entries` (subdoc
  `{ id?, source?, name?, action, reason? }` with the engine's action enum),
  `updatedAt`.
- **Source** (`server/lib/capabilities/operatorPolicySource.js`): the only
  module that reads/writes the document. On startup it **hydrates** the
  in-process accessor (`operatorPolicy.setOperatorPolicy`) and, if no document
  exists, upserts THE default document from the guest-deny seeds (a unique-key
  E11000 insert race is retried as a re-read — never a duplicate authority).
- **Bounded refresh**: an unref'd interval (`startRefreshTimer` /
  `stopRefreshTimer`) refreshes at least every `FRESHNESS_BOUND_MS` (default
  60 s, override `OPERATOR_POLICY_REFRESH_MS`, floor 1 s; graceful shutdown
  stops the timer before the connection closes). Refresh is single-flight
  (concurrent refreshes share one in-flight read) and a revision counter
  discards a stale read that raced an operator write.
- **Failure behavior** (all preserve last-known-good): Mongo unavailable →
  `lastError: mongo-unavailable`, kept + logged, last-known-good survives
  (`storeReady()` fails fast on a disconnected connection instead of buffering);
  a malformed PERSISTED document is never applied and never overwritten (an
  operator PUT repairs it); a missing document is recreated from seeds.
- **Routes** (`server/routes/policy.js`, mounted at `/api/policy` before the
  global JSON parser so its own **64 KB body cap** is authoritative):
  - `GET` — served entirely from the in-process cache (zero Mongo reads),
    returns `{ policy, meta }` (freshness bound, last-loaded, last-error,
    next-refresh, revision); never leaks store meta fields.
  - `PUT` — full replace of the policy document (bare body or `{ policy }`
    envelope). Validation is synchronous and whitelist-only: unknown fields,
    Mongo `$` operators, wrong `action`, bad capability ids, and oversized
    bodies are rejected **before** any write (400/413; one atomic upsert on
    success). The apply to the in-process policy is immediate and serialized
    (concurrent PUTs are last-writer-wins in both the document and memory);
    a failed persist never touches the in-process policy (503/500).
  - Authorization is operator-only and non-guest (fail-closed): a signed-in
    operator/admin role, or membership in `OPERATOR_EMAILS` /
    `OPERATOR_USER_IDS` (read at request time). Guests → 403 `GATE.GUEST`;
    non-operators → 403 `GATE.OPERATOR`.
- **Execution path unchanged**: TaskExecutor still reads only the in-process
  knob on every execution — zero per-request Mongo queries.
- **Files**: `server/models/OperatorPolicy.js`,
  `server/lib/capabilities/operatorPolicySource.js`, `server/routes/policy.js`,
  `server/index.js` (startup hydrate + timer + route + shutdown).
- **Tests**: `server/tests/operatorPolicySource.test.js` — 25 tests (schema,
  single-authority hydration + E11000 race, bounded interval refresh, cache-only
  GET, operator/gate matrix, immediate atomic PUT + envelope, malformed body /
  `$` injection / 64 KB 413 rejection, malformed-persisted never applied,
  last-known-good under outage + disconnect, zero per-request Mongo across real
  TaskExecutor executions, PUT-driven verdict change through the real executor,
  single-flight refresh, last-writer-wins PUT serialization).

### Governed nested tool calls inside the swarm (slice 4E item 4)

Slice 4E item 4 closes the last ungoverned execution path: `deepResearchSwarm`
no longer calls the `webSearch` / `scrapeWebsite` leaf tools directly. Both
nested calls now route through the **same** `TaskExecutor.executeTool` choke
point every other capability uses, so a research tool invocation inherits the
full substrate path — capability resolution → authorization → approval →
execution envelope → idempotency → credits → execution — with the caller's real
context.

- **One executor, no second flow** — there is no separate nested executor and no
  recursive `deepResearchSwarm`. The nested call is literally the public
  `getTaskExecutor().executeTool('webSearch' | 'scrapeWebsite', ..., userId,
  socket, { workspaceId, conversationId, signal })` API the AI service uses.
  `getTaskExecutor()` is a lazy `require` inside the tool to keep
  `tools/index ⇄ deepResearchSwarm ⇄ services/TaskExecutor` from forming a boot-order-dependent require cycle.
- **Context comes from the caller, never from tool args** — `userId`, `socket`,
  `workspaceId`, `conversationId`, and the swarm's own `localAbortController`
  signal are propagated explicitly into the nested dispatch. A malicious
  `{ query: ... }`/`{ url: ... }` payload cannot spoof the actor or the
  workspace; the authorization engine sees the authenticated requester.
- **Ordering and events preserved** — the swarm still emits its `logSwarm`
  `tool.start` / `tool.result` / `tool.failure` events, keeps its rate-limit
  delays, and formats its final report identically. Nested results adopt the
  normalized `{ success, error, cancelled }` failure shape, and the existing
  result formatting (`searchResults.success`, `searchResults.content`,
  `scrapeResult.content`) is unchanged.
- **Authorization / denial** — an operator deny on `native:webSearch` (or the
  ephemeral-tool route in `authorizationPolicy`) is enforced on the nested call:
  the swarm starts, the nested envelope is refused with `authorization.denied`,
  the real tool body never executes, and no credit is charged.
- **Approval re-entrancy** — a nested call that requires approval uses the same
  single-use approval store + Socket.IO transport as slice 4C, requesting its
  own approval from the initiating session. Post-approval TOCTOU re-checking (4E
  item 3) applies to the nested call exactly as it does to any top-level one;
  no second approval flow exists.
- **Credits** — the cost of a nested governed execution is 2 credits per
  `webSearch` / `scrapeWebsite` and 8 for the outer `deepResearchSwarm`; no
  `skipCreditCharge` escape is passed to nested calls.
- **Emergency stop** — the existing `localAbortController` keeps working: the
  nested signal propagates into the dispatched tool; cancellation before start,
  in-flight, or while an approval is pending follows the same abort path and
  leaves no orphaned execution.
- **Idempotency** — outer and nested executions each get their own
  `executionId`; the idempotency gate is active whenever a logical key exists,
  so outer and nested runs never collide on a shared key.
- **Seed reconciliation** — two registered natives were verified against the
  live registry and appended (order-preserving) to `GUEST_DENY_DEFAULTS`:
  `native:executeCode` and `native:scheduleMeeting` (now 8 ids). `memorize` is
  the capability id for the `memoryWriter` surface — no alias is used.
- **Files**: `server/tools/deepResearchSwarm.js` (lazy executor ref + two
  governed nested calls), `server/lib/capabilities/operatorPolicy.js`
  (seed list +2), `server/tests/slice4eSwarmGovernance.test.js` — 18 tests
  (governed routing, credit inheritance, envelope identity + caller workspace,
  default allow, operator deny, guest hard-deny, workspace restriction,
  caller-not-args context, the full 4C approve/deny/no-session/TOCTOU flow,
  cancellation before start + in-flight + pending approval, no recursion,
  unchanged success shape, distinct idempotency identity per execution).
- **Real-config validation** — with `dotenv` real config and only the
  Mongo-dependent layers (credits backend, Message/Conversation models, and the
  LLM report generator) substituted in-process, the real `TaskExecutor`,
  real `deepResearchSwarm`, and the REAL live-network `webSearch` (Wikipedia)
  and `scrapeWebsite` (example.com) tools were exercised end-to-end: the
  swarm-nested webSearch produced the full
  `capability.execution.started → capability.authorization.allowed →
  live fetch → capability.execution.succeeded` chain with real Wikipedia data
  (`title="Microsoft Azure"`), the governed scrape enveloped a live 200 fetch,
  and an operator deny on `native:webSearch` produced
  `capability.authorization.denied` with ZERO live invocations, ZERO envelope
  success, and ZERO credit charge while the swarm started normally (17/17
  checks). The box itself cannot reach the real `server/.env` Mongo Atlas URI
  (the Atlas IP allow-list rejects this network; boot error reproduced), so the
  full HTTP-boot validation is environment-blocked here, not blocked by code —
  the harness + this real-config run cover the governed behavior directly.
  Wikipedia intermittently rate-limits undici bursts from this shared egress IP
  with an HTML page; a retry-with-backoff on HTML-only wiki responses (still
  the real URL + real HTTP round-trip) makes the live run deterministic.

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

Slice 4C approval check: a real local TaskExecutor under
`approval_required` on `getTime`, wired to a real Socket.IO server with
client-driven resolve — the tool does not run before approval, the requested
event carries only safe preview metadata, an approve over the wire executes
exactly once, a deny over the wire executes zero times, and a too-late resolve
finds the record EXPIRED and still zero executions (covered end-to-end by the
transport test; see Part 12 above).

## Phase 1 closure audit — governed-path regressions

A final closure pass audited "every action flows through one governed
boundary" against the live code rather than against intent. Four real defects
were found; each fix is locked by a test with a verified negative control.

### 1. WhatsApp socket send bypassed the governed boundary (HIGH)

`providers/whatsapp/index.js` handled `whatsapp:send` by calling
`clientManager.sendMessage(...)` directly. That is an alternate execution
path: **any authenticated socket — including a guest — could send a real
WhatsApp message with no authorization, no approval, no idempotency, no
execution envelope and no observability.**

The handler now resolves the shared executor lazily (keeping the
`TaskExecutor → tools/index → sendWhatsAppMessage → clientManager` require
graph acyclic at boot) and delegates to
`executeTool('sendWhatsAppMessage', { recipientName, message }, userId, socket, …)`.
Client-visible events and payloads are unchanged, so the ambiguity UX
(`whatsapp:recipient_ambiguous` with `matches`) still works.

`tests/governedExecutionPaths.test.js` proves the handler delegates, and that a
guest is denied by the real `TaskExecutor` with the tool body never running.
The negative control matters here: the test stubs `clientManager.sendMessage`,
because without the stub a reintroduced bypass merely throws "client not
initialized" and the test would pass **vacuously**.

### 2. `native:sendWhatsAppMessage` missing from the guest hard-deny (HIGH)

`lib/capabilities/risk.js` classifies `sendWhatsAppMessage` as
`consequential`/`high` — the exact tier the guest deny set exists to cover —
but the id was absent from `GUEST_DENY_DEFAULTS`, so a guest could reach a
real external message send through the model path. Added, plus the derived
completeness test described in slice 4E item 2.

### 3. Idempotency was inert in production (MED)

The guard was fully implemented and unit-proven, but **no production call
site ever supplied an identity**, so `resolveIdempotencyKey` always returned
`{ enabled: false }` and every execution passed straight through.

The model dispatch sites now supply one. The identity is
`<per-turn assistant message id>:<provider tool_call id>`, because a provider
`tool_call` id is unique only *within* a response — providers commonly number
them `call_1`, `call_2`, …, so using it alone would make a later turn's
legitimate repeat collide with an earlier one and silently do nothing. If
either half is missing the key is `null` and the execution stays in the
documented pass-through mode: the substrate still never guesses a logical
identity from tool arguments.

`tests/idempotencyWiring.test.js` covers all three properties — same-turn
duplicate replays, same id in a different turn still executes, unkeyed stays
pass-through. The replay envelope is `{ success, replay, duplicateOf, outcome }`
and deliberately does **not** echo stored tool output.

### 4. Current-news "two 10s waits" (MED)

A GDELT `503` produced the message `…unavailable response (HTTP 503)`, which
matched `ToolRecoveryManager`'s `TRANSIENT_PATTERNS` (`/unavailable/i`,
`/503/i`) and was therefore retried **inside the same turn** — issuing a
byte-identical request that stacks a *second* full `REQUEST_TIMEOUT_MS` (10s)
behind the first, for a verdict that cannot change.

`getTopNews` now declares its own failures `retryable: false`: every failure
it returns is either a definitive upstream answer or a request that already
consumed the full timeout budget. `ToolRecoveryManager` honors an explicit
`result.retryable === false` **ahead of** the text heuristics, so a tool's
first-hand declaration outranks pattern-guessing (genuine transport faults
never reach that path — they throw and are classified on their own merits).
Recovery is unchanged for every other tool.

`tests/newsMultiTurnScoping.test.js` (8 checks, real `TaskExecutor` + real
news tool, no live GDELT) covers one fetch per turn, no retry storm on
failure, truthful failure with no fabricated articles, no scope leakage into
unrelated requests, per-actor isolation, and stable 4-turn scoping. Both halves
of the fix are load-bearing: breaking either one reintroduces the double fetch.

## Intentionally NOT implemented (deferred)

- Retries / recovery orchestration / proactive jobs / new capabilities
- Durable plan state (the plan-level `Execution` model), compensation
- Any new timeout or cancellation mechanism
- Planner integration (a later slice builds on this envelope)
- Idempotency wiring inside individual native tools / MCP adapters / the
  frontend — a single substrate mechanism only. The **model** call sites in
  `AIService` are now wired (see the closure audit above); the tool-internal
  and adapter-level wiring is still deferred.
- Risk-aware fail-closed policy for high-risk capabilities during store
  outages (deliberate architectural decision, not part of this slice —
  fail-open is uniform today)
- **Slice 4A → 4B boundary:** enforcement of `authorizationPolicy` verdicts
  inside TaskExecutor / execution path is DONE in 4B (DENIED + MCP denials
  block; approval-required deliberately NOT blocked yet because no approval
  transport exists). **Slice 4C now supplies that transport and enforcement**
  (pending-approval state + Socket.IO approval events + fail-closed gate), and
  **slice 4D ships the fourth-party approval UI** (in-flow permission cards +
  approve/deny on the dashboard). **Slice 4E adds workspace-identity
  isolation, seeded guest hard-deny, and post-approval TOCTOU revalidation.**
  Still deferred: durable out-of-band approval (mobile push, e-mail links);
  multi-node approval coordination; **per-workspace policy CRUD** (runtime
  policy refresh + persistence itself is now shipped in slice 4E item 2). Jev
  remains untouched by 4A through 4E.

## Environment note (pre-existing, unrelated)

In ad-hoc `node -e` harnesses that `require('abort-controller')` **after**
`TaskExecutor`, the tool registry logs
`Failed to load tool ...sendWhatsAppMessage.js: AbortController is not defined`.
Reproduced identically on pristine HEAD; real test suites do not trigger it.
---

# Mongo test safety contract (Phase 1 hardening)

## Why this section exists — the incident

A Mongo integration test built its target by **string concatenation**:

```js
// server/tests/idempotency.mongo.test.js (before)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27027';
const DB_NAME  = `arc_idem_accept_${process.pid}_${Date.now()}`;
const URI      = `${MONGO_URI}/${DB_NAME}`;      // <-- the bug
await mongoose.connect(URI);
...
await conn.dropDatabase();                        // <-- wiped the app database
```

When the ambient `MONGO_URI` already carried a database path — the normal
shape for an Atlas connection string — the resulting URI had **two** path
segments (`.../jarvis_production_db/arc_idem_accept_1234_...`). The Mongo
driver uses the **first** path segment, so the test connected to the
**application database**, wrote test documents into it, and then called
`dropDatabase()` on it. The application database was wiped.

Nothing about that failure was visible at the call site: the variable was named
`URI`, the name looked disposable, and the ambient variable was "just a
default".

**Lesson (test infrastructure):** a test that writes to a database must never
*choose* that database by appending a string to a URI it did not build itself.
Disposable-ness has to be a property the test can be *checked* against, not a
name it invented. The cost of proving it (host allowlist + marker + revalidation)
is trivial; the cost of guessing wrong is the whole database.

## The shared guard

`server/tests/helpers/disposableMongo.js` is the single safety abstraction.
Every Mongo-writing test and script goes through it. It exposes:

| Function | Purpose |
|---|---|
| `planDisposableRun(opts)` | Pure pre-connect gate. Throws `DisposableMongoSafetyError` on any unsafe or incomplete configuration. **No connection is attempted.** |
| `openDisposableMongo(opts)` | Connects to a freshly generated disposable database and writes the run-ownership marker. Refuses to reuse a database that already holds collections. |
| `attachDisposableMongo(opts)` | Read-only attach for a second process in the same run; requires a matching ownership marker. |
| `dropDisposableDatabase(ctx)` | The **only** `dropDatabase()` in the repository, after revalidating everything. |
| `deleteDisposableDocuments(ctx, collection, filter)` | Scoped deletes. A non-empty filter is mandatory. |
| `assertCleanupAllowed(ctx)` | Revalidates marker + host + database + live database + collection set. |
| `validateDisposableConfig` / `evaluateOwnership` / `evaluateDisposableDbName` | Pure predicates, used by the safety suite. |
| `buildChildEnv(plan)` / `buildChildArgs(key)` | Secret-free child-process plumbing (env, never argv). |
| `safeTargetSummary(plan)` | The only sanctioned log shape. |

## Required environment (all four, or the run does not happen)

```
MONGO_TEST_URI=mongodb://<host>        # a DISPOSABLE host, host-only path
MONGO_TEST_EXPECTED_HOST=<exact-host>  # every host in the URI must match
MONGO_TEST_DISPOSABLE=1
RUN_MONGO_INTEGRATION=1
```

Optional, for multi-invocation workflows: `MONGO_TEST_RUN_ID`,
`MONGO_TEST_DB_NAME` (reuse a run's database), and for the measurement script
`MONGO_MEASURE_ALLOW_DESTRUCTIVE=1`.

**There is no fallback.** `MONGO_URI`, `DATABASE_URL` and application `.env`
files are never read as a connection source. The guard reads the ambient URI for
one purpose only — discovering the application database name so it can refuse
it — and never logs it.

Intent is classified so failures are honest:

| State | Behavior |
|---|---|
| Nothing configured | `SKIP` with the required variables printed. |
| `MONGO_TEST_URI` or `RUN_MONGO_INTEGRATION` set but configuration unsafe | `FAIL` (exit 1). The operator asked to run; the target is wrong. |
| `NODE_ENV=production` | Always refused, before anything else. |

## Database naming

* Generated name: `arc_ai_test_<runId>`, matching `^arc_ai_test_[a-z0-9][a-z0-9_-]{7,}$`.
* Selected with the driver's `dbName` option — **never** by appending to the URI:

  ```js
  mongoose.connect(uri, { dbName: generatedDisposableDb });
  ```

  The URI is passed through verbatim, so `mongodb+srv` hosts, credentials,
  replica sets, TLS and query options are preserved — and nothing in the path or
  query string can redirect the connection.
* The database is re-read from the live connection (`connection.db.databaseName`)
  and must equal the generated name exactly.
* Refused: `test`, `admin`, `local`, `config`, `prod`, `production`, `staging`,
  `development`, `dev` (and other conventional names), the application database
  name, and any name without the `arc_ai_test_` prefix.
* A `MONGO_TEST_URI` that itself names a non-disposable database is refused, so
  an operator who pastes the application URI into `MONGO_TEST_URI` gets a
  failure instead of the incident.

## Host allowlist

The host is parsed from the URI and compared against `MONGO_TEST_EXPECTED_HOST`
**before connecting**. Every host in the URI must match (a replica-set URI with
one rogue member is refused). `host:port` may be declared for precision.
Mismatches fail with `host=<host> does not match MONGO_TEST_EXPECTED_HOST=...`.

## Marker ownership

On connect the guard writes one document into `__disposableMongoRun`:

```js
{ _id: 'ownership', kind: 'disposable-mongo-run',
  runId, host, database, disposable: true, createdAt }
```

Before **any** destructive cleanup the guard re-reads that marker and re-checks
`runId`, `host`, `database`, the `disposable` flag, the live database name, and
the collection set. A failure means: disconnect, **do not drop**, **do not
delete**, fail closed.

The database is also required to be **empty at connect**, so "collections this
run created" is a sound ownership proof even for tests whose reachable models
cannot be enumerated in advance (`ANY_RUN_COLLECTION`). A database that already
held data is refused at connect — which is precisely what would have stopped the
incident, since the application database is never empty.

## Guarded cleanup

```js
try {
  /* ...test writes... */
} finally {
  await mongoSafety.dropDisposableDatabase(ctx);   // revalidates, then drops
}
```

No test or script may call `conn.dropDatabase()` or a raw `deleteMany()`; both
are enforced by a repository lint inside `disposableMongoSafety.test.js` (cases
18–20), which fails if a new call site appears outside the guard.

## Secret hygiene

* Full URIs are never logged. The only sanctioned shape is:

  ```
  host=<host>
  database=<arc_ai_test_runid>
  disposable=true
  ```

  No username, password, port or query parameters. Error messages report the
  host only; the parser reduces credentials to a boolean and discards them.
* Mongo URIs are **never** passed through `process.argv` (visible to every
  process on the host). The restart-probe child receives the target through the
  environment, plus the parent's `runId` and database name so it reuses the
  parent's database instead of creating one.

## Tests and scripts protected

| Surface | Before | After |
|---|---|---|
| `tests/idempotency.mongo.test.js` | ambient `MONGO_URI` default, URI concatenation, direct `dropDatabase()` | guard-generated database, guarded cleanup, SKIP/FAIL per intent, env-based child |
| `tests/idempotency.probe-child.js` | URI in `argv[2]` | read-only `attachDisposableMongo`, key-only argv |
| `tests/messageHistory.baseline.test.js` | ambient `MONGO_URI`/`DATABASE_URL`, real `Message` writes + `deleteMany` | Parts A/B untouched and always run; Part C gated on the disposable contract, guarded cleanup |
| `scripts/measureMessageHistory.js` | ambient `MONGO_URI`/`DATABASE_URL`, unscoped `deleteMany` on any conversation id | explicitly designated target, read-only default, `MONGO_MEASURE_ALLOW_DESTRUCTIVE=1` for writes, cleanup scoped to the run's own probe conversation |
| `scripts/clearStaleGoogleCalendarTokens.js` | unchanged — authenticated production maintenance, dry-run by default | intentionally not disposable-gated (it exists to repair the application database) |

Safe invocation for the measurement script:

```bash
cd server
export MONGO_TEST_URI=mongodb://127.0.0.1:27017
export MONGO_TEST_EXPECTED_HOST=127.0.0.1
export MONGO_TEST_DISPOSABLE=1 RUN_MONGO_INTEGRATION=1
export MONGO_MEASURE_ALLOW_DESTRUCTIVE=1
node scripts/measureMessageHistory.js --seed 500     # prints runId + database
export MONGO_TEST_RUN_ID=<runId> MONGO_TEST_DB_NAME=<db>
node scripts/measureMessageHistory.js --measure <conversationId>
node scripts/measureMessageHistory.js --cleanup <conversationId>
```

## Safety suite

`cd server && node tests/disposableMongoSafety.test.js` — 20 pure assertions, no
connection, no Atlas, safe to run anywhere. Cases 1–17 cover the contract
(missing/ambient-only configuration, missing marker, wrong host, `test`/
production-like/application database names, invalid prefix, valid generation,
missing/mismatched marker, mismatched database/host, valid ownership, query-string
containment, credential redaction, argv secrecy). Cases 18–20 enforce the
contract structurally across `server/tests` and `server/scripts`.
