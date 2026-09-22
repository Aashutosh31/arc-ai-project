# JARVIS Action Substrate — Slices 1 & 2 (handoff)

Additive architectural substrate for JARVIS. Slice 1 introduced a unified
capability metadata layer; slice 2 added a normalized execution envelope +
lifecycle observability around the existing single execution choke point.

Status: slice 1 committed (`855da62`), slice 2 implemented and validated but
**not yet committed** (pending review).

## Integration boundary

Exactly one governed execution path exists: `TaskExecutor.executeTool`
(`server/services/TaskExecutor.js`). It is the shared choke point for native
tools (`toolRegistry.getTool`) and MCP tools (`McpToolSource.resolveTool`
fallback). Slice 2 wraps this method; it does not introduce a second execution
engine.

Call sites that continue to use the choke point unchanged:
`AIService.js` (`:3178/3651/3688/4327/5965/6542/6623`), `TaskPlanner.js:104`,
`ToolRecoveryManager.js` (`:187/220/253`).

## Execution envelope (`server/lib/capabilities/executionEnvelope.js`)

`createExecutionEnvelope(opts)` → `ExecutionEnvelope`. `TaskExecutor.executeTool`
creates the envelope, calls `start()`, runs the unmodified `_executeToolCore`,
and passes the original result object to `finalize(result)`, which returns it
unchanged.

Fields recorded (metadata only — nothing is enforced here):

| Field | Source |
| --- | --- |
| `executionId` | `cap-<uuid>` (never collides with existing `mcp-…` plan ids) |
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
`capability.execution.started / succeeded / failed / cancelled`. Emission is
deferred via `enqueueMicrotask` and never throws. Log payloads are pruned to a
`SAFE_FIELDS` whitelist; tool inputs/outputs, nested results, payload fields
and secret-looking keys are dropped.

## Error classification (`envelopeClassification.js`)

Pure mapping, existing `mcp.*` categories preserved:
- `invalid_arguments` → `validation`
- `not_authorized`, `auth_required`, `authentication_failed` → `authorization`
- `connection_timeout` → `timeout`
- `cancelled` → `cancelled`
- `tool_not_found`, `tool_execution_error`, `output_too_large` → `tool`
- `server_unavailable`, `protocol_error`, `not_connected` → `provider`
- credit `blocked / BLOCKED` → `blocked`
- unclassified failure result → `tool`; exhausted/null → `unknown`

## Facade

`server/lib/capabilities/index.js` exposes the slice-1 surface plus
`ExecutionEnvelope`, `createExecutionEnvelope`, `resolveExecutionCapability`,
`envelopeClassification`, `observability`. No duplicate registry, no `execute*`
facade, no tool-selection/context-budget changes.

## Tests

- `server/tests/capabilities.test.js` — 15/15 (slice 1).
- `server/tests/executionEnvelope.test.js` — 22/22: envelope id/lifecycle/
  terminal-once/pass-through, native + MCP shape preservation, timeout &
  cancellation metadata, observability pruning (secrets never logged),
  capability metadata parity with the authoritative registries, no duplicate
  registry/execution path, provider-visible tool selection byte-identical
  after envelope executions, live registries untouched.
- Full regression green except two pre-existing failures not caused by this
  work: `mcpSinglePath` S-08 (quote-style source assertion) and
  `ttsFirstChunk` (2 chunk-merging assertions, fail on pristine HEAD too).
- Note (`mcpSinglePath` uses the same whitelisted-log assertion technique as
  the envelope suite; the SQL `NEW`/wal handling is unchanged).

## Manual validation (no live providers configured)

Real native `getTime`, real in-memory MCP (read + failing tool + aborted
signal), unknown-tool rejection, and a native failure all produce correct
terminal events with safe logs and unchanged result shapes.

## Intentionally NOT implemented (deferred)

- Retries / recovery orchestration / proactive jobs / new capabilities
- Idempotency keys, durable plan state, compensation
- Any new timeout or cancellation mechanism
- Planner integration (a later slice builds on this envelope)

## Environment note (pre-existing, unrelated)

In ad-hoc `node -e` harnesses that `require('abort-controller')` **after**
`TaskExecutor`, the tool registry logs
`Failed to load tool ...sendWhatsAppMessage.js: AbortController is not defined`.
Reproduced identically on pristine HEAD; real test suites do not trigger it.