# ARC-AI Autonomous Tools

This document describes the **current** tool system: the provider-independent registry, the 22 registered tools, and how tools execute inside the AI pipeline.

---

## Tool Registry (22 tools)

`server/tools/index.js` auto-discovers every `{ schema, execute }` module in the tools directory. The registry is **provider-independent** — tools are defined once and exposed to Groq, Gemini, and Mistral; per-provider translation happens only at the provider adapter boundary.

Current registered tools:

| Category | Tools |
| --- | --- |
| **Communication** | `sendEmail` (Google Apps Script webhook), `sendWhatsAppMessage` |
| **Calendar & time** | `checkCalendar`, `scheduleMeeting`, `getTime`, `createReminder`, `setReminder`, `stopReminder` |
| **Research** | `webSearch`, `getTopNews`, `getWeather`, `scrapeWebsite`, `deepResearchSwarm` |
| **Memory** | `memorize`, `recallMemory`, `storeUserFact` |
| **UI actuation** | `changeTheme`, `openWebsite`, `copyToClipboard`, `playMedia`, `stopMedia` |
| **Computation** | `executeCode` (QuickJS/WASM sandbox) |

> Not every provider is guaranteed identical tool/capability behavior. The registry is neutral; provider-specific behavior lives in the adapters (`server/lib/llm/providers/*`).

---

## Execution Model

1. **Offering tools** — `AIService` passes `getSchemas()` (all 22 schemas) into the LLM request.
2. **Tool calling** — if the response contains `toolCalls`, ARC-AI routes to a planner path or an inline path:
   - **Planner path** (`shouldUsePlanner`) — multiple tools or heavy research tools go through `TaskPlanner.createPlan()` + `executePlan()`, with `execution.*` progress events and cancellation.
   - **Inline path** — tools execute sequentially via `TaskExecutor.executeTool()`.
3. **Execution** — `TaskExecutor` charges ARC-AI credits (per-tool cost), packages `{ actor, signal, workspaceId, conversationId }`, and invokes `tool.execute(args, context, socket)`.
4. **Multi-step + follow-up** — tool results are normalized (tool-call continuation chain rebuilt by `buildProviderContinuationMessages`) and **fed back to the model** for a streaming follow-up synthesis pass.
5. **Client actions** — tool results carrying a `clientAction` payload are emitted over `ai:client:action` so the frontend can change the theme, open a URL, copy to clipboard, or control media/reminders.

---

## Recovery (`ToolRecoveryManager`)

- `classifyFailure` → `blocked`, `auth`, `parse`, `transient`, `http_404`, `not_found`, `malformed`, `unknown`.
- Retry (up to 2×, no extra credit) for transient/parse failures.
- Scrape fallback on 404 (alternative URL candidates, then `webSearch`).
- Replan suggestions for unrecoverable failures; `blocked` (credit exhaustion) propagates without retry.

---

## Autonomous Capabilities at a Glance

- **Live web research** — `webSearch`, `getTopNews`, `getWeather`, `scrapeWebsite` (Cheerio), `deepResearchSwarm`.
- **Proactive scheduling** — natural-language meeting/reminder parsing and scheduling through the calendar pipeline + cron.
- **WhatsApp automation** — `sendWhatsAppMessage` (driven by the WhatsApp provider, `server/providers/whatsapp/`).
- **Email / webhooks** — `sendEmail` via the Google Apps Script webhook (SMTP-bypass design).
- **UI actuation** — `changeTheme`, `openWebsite`, `copyToClipboard`, `playMedia`, `stopMedia`.
- **Code sandboxing** — `executeCode` runs in a QuickJS WebAssembly sandbox (no `vm2`).

---

## Tooling Runtime Notes

- streaming-compatible tool execution
- interrupt-safe execution lifecycle
- Socket.IO realtime UX continuity
- modular registration: adding a tool = one file in `server/tools/`

---

## Relations

- Provider/capability model: [`llm-providers.md`](./llm-providers.md)
- Streaming/persistence runtime: [`architecture-and-runtime.md`](./architecture-and-runtime.md)