# Jev System One Decision Layer

Jev is ARC-AI's first **System One** decision layer: a fast, bounded
classifier that runs **before any external-capability work** and answers the
question *"does this request require an external capability / tool?"* — plus
advisory signals (operation, risk, confirmation).

It is **not** a conversational brain, **not** a replacement for Groq/Gemini,
and **not** an MCP execution layer. Jev **never executes a tool**. It only
produces a normalized decision that deterministic ARC code consumes.

## Why it exists

Most MCP work happens on every turn: inventory, discovery, candidate
selection, feasibility, and execution resolution. For an ordinary
conversational request ("hello", "explain closures", "what's the weather of
closures?") that machinery is pure overhead and, worse, can leak the shape of
external capabilities into unrelated answers.

The gate makes the common path cheaper and cleaner: a confidently
conversational request skips **all** MCP machinery and goes straight to the
normal Groq path. Capability requests and ambiguous requests are completely
unchanged.

## Routing flow

```
request
  │
  ▼
DeterministicDecisionEngine        (cheap, high-confidence only)
  │  certain? ── yes ───────────────────────────► decision
  │  no
  ▼
JevDecisionEngine                  (System One, tiny model via AI Gateway)
  │  high confidence? ── yes ───────────────────► decision
  │  no / error / unavailable
  ▼
legacy / existing ARC routing      (authoritative fallback)
```

- **Deterministic** answers *only* what it can answer conclusively: a bounded
  greeting vocabulary (no-tool) and a curated capability-verb list (tool).
  Everything else defers.
- **Jev** answers four bounded typed questions in one request via the AI SDK's
  `experimental_evaluate` against `typesafe-ai/jev` over Vercel AI Gateway.
- **Legacy** is provider-agnostic and always safe. Jev failures (timeout, rate
  limit, malformed response, missing key) degrade here. `JEV_FAIL_OPEN=true`
  (default) never lets a decision failure block a normal request.

## Decision contract

`DecisionEngine.decide({ request, query, recentContext, workingState, pendingTool, hasAttachment, signal })`
returns:

```js
{
  provider: 'deterministic' | 'jev' | 'legacy',
  latencyMs,
  confidence,                       // confidence in the chosen value
  decisionId,                       // uuid (deterministic/jev only)
  reason,                           // legacy/deferral reason string or null
  needsExternalCapability: { value, probability },  // probability OF the value
  operation:  { value, probability },               // chat|search|media|calendar|messaging|code|mcp|other
  risk:       { value, probability },               // 0..100 normalized
  needsConfirmation: { value, probability },
}
```

Probability fields always express confidence in the **chosen** value (a `false`
`needsExternalCapability` carries `1 - P(true)`), so all thresholds compare in
one consistent direction.

## The four questions

| Question | Type | Purpose |
| --- | --- | --- |
| needsExternalCapability | boolean | Does this request require an external capability/tool? |
| operation | choice | Advisory routing hint (chat/search/media/calendar/messaging/code/mcp/other). |
| risk | score (5 levels) | Approximate risk of the request (advisory, Phase 2 home). |
| needsConfirmation | boolean | Advisory: does the request warrant user confirmation? |

## Confidence thresholds

`JEV_NO_TOOL_THRESHOLD` and `JEV_TOOL_THRESHOLD` (both default `0.90`):

- `needsExternalCapability=false` with probability ≥ no-tool threshold →
  **skip gate may open** (see safety guards).
- `needsExternalCapability=true` with probability ≥ tool threshold →
  treated as a high-confidence tool request; full MCP path runs.
- anything between → `low-confidence` → legacy routing runs the full pipeline.

## MCP skip gate

`decisionPolicy.shouldSkipMcp(result, { policy, workingState, hasAttachments, hasPendingTool })`
is the **single authoritative gate**. It returns `true` only when:

1. the decision confidently says *no external capability*, **and**
2. no attached document/image, **and**
3. no pending tool-call flow, **and**
4. no active working-state surface (activeMedia / activeSearch /
   activeResource / activeTask).

`provider === 'legacy'` can **never** open the gate. When the gate opens the
conversational request bypasses: MCP schema inventory/discovery, candidate
generation, coverage/resolver logic, feasibility, and execution — with an
empty (safe) tool selection fed to the budget pipeline.

Guards are re-asserted inside `shouldSkipMcp`, so even a confidently-wrong Jev
answer cannot skip MCP for a continuation, a multimodal turn, or an in-flight
argument-collection flow.

## MCP integration points

- `server/services/decision/DecisionEngine.js` — orchestration + telemetry.
- `server/services/decision/decisionPolicy.js` — thresholds + `shouldSkipMcp`.
- `server/services/decision/deterministicDecisionEngine.js` — fast path.
- `server/services/decision/jevDecisionEngine.js` — Jev provider (lazy ESM
  `import('ai')`, timeout, normalization). No execution surface exists here.
- `server/services/AIService.js#processQuery` — the gate sits between context
  loading and `McpToolSource.schemasForRequest`. `skipMcpGate` both skips
  schema loading **and** replaces `selectToolSchemas` with a safe empty pick.

Rest of ARC depends only on `./decision`'s public facade
(`decisionEngine`, `decisionPolicy`). It never touches Jev directly.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | – | Vercel AI Gateway key (backend only). Unset ⇒ Jev unavailable ⇒ legacy. |
| `JEV_ENABLED` | `true` | Master switch for the Jev provider. |
| `JEV_MODEL` | `typesafe-ai/jev` | Decision model id. |
| `JEV_NO_TOOL_THRESHOLD` | `0.90` | Min confidence to open the skip gate. |
| `JEV_TOOL_THRESHOLD` | `0.90` | Min confidence to treat as a tool request. |
| `JEV_DECISION_TIMEOUT_MS` | `500` | Max decision wait (clamped 50..10000). |
| `JEV_FAIL_OPEN` | `true` | Fall back to legacy routing on any decision error. |

Policy is loaded once at module load; restart to pick up env changes.

## Tests

```
cd server && node tests/decisionLayer.test.js
```

Covers the deterministic fast path, Jev normalization (injected answers),
orchestration, the full skip-gate safety matrix, the no-execution guarantee,
and policy thresholds/defaults.

## Extending

- New deterministic signals: add phrases to `GREETING_PHRASES` /
  `TOOL_PATTERNS` in `deterministicDecisionEngine.js` (keep it conservative).
- New decision questions: extend `QUESTIONS` + `buildDecisionResult` in
  `decisionTypes.js`, add a normalizer in `jevDecisionEngine.js`, and wire a
  `policy`-driven consumer.
- More thresholds: extend `loadPolicy` in `decisionPolicy.js` (env-driven,
  clamped).