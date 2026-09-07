# ARC-AI LLM Providers

This document describes the **current** LLM provider architecture: the `LLMRouter`, each provider, capability handling, and fallback behavior.

---

## 1. Provider Abstraction

LLM integration lives in `server/lib/llm/`, **not** in `server/providers/` (which contains the unrelated WhatsApp client).

- **Provider registry** — `server/lib/llm/providers/index.js` auto-discovers every provider module in `server/lib/llm/providers/` and registers it by `id` (+ aliases). Providers are singletons with lazy clients.
- **`LLMRouter`** — `server/lib/llm/LLMRouter.js` chooses the primary provider, builds a capability-filtered fallback order, issues the generation, records per-provider health stats, classifies failures, and falls back.
- **`StreamingRuntime`** — `server/lib/llm/StreamingRuntime.js` consumes provider streams and relays chunks to the client. See [`architecture-and-runtime.md`](./architecture-and-runtime.md).

A provider exposes: `generate(request)`, `canHandleRequest(request)`, `isAvailable()`, `resolveModel(request)`, `getClient()`, plus `id`/`name`/`priority`/`capabilities`.

---

## 2. Capabilities

| Provider | ID | Priority | Text | Streaming | Tools | Multimodal (images) |
| --- | --- | --- | --- | --- | --- | --- |
| **Gemini** | `gemini` | 100 | ✅ | ✅ | ✅ | ✅ |
| **Groq** | `groq` | 90 | ✅ | ✅ | ✅ | ❌ |
| **Mistral** | `mistral` | 80 | ✅ | ✅ | ✅ | ❌ |

- **Groq** uses the OpenAI SDK against `https://api.groq.com/openai/v1`. Its default model `openai/gpt-oss-120b` is **text-only**; image attachments are rejected explicitly. It supports streaming tool-call delta assembly.
- **Gemini** is fully multimodal, uses `@google/genai`, and also performs server-side voice transcription (`transcribeAudio`) and optional server TTS.
- **Mistral** passes tools through with `toolChoice: 'auto'`; its adapter declares `multimodal: false` even though a `MISTRAL_VISION_MODEL` (Pixtral) is configured — **images route to Gemini**, never Mistral.

> Capabilities are declared in code and enforced by `canHandleRequest()` + router-level filtering. Not every provider is guaranteed identical tool behavior; the router only guarantees that unsupported capabilities never reach a provider.

---

## 3. Routing & Fallback

`LLMRouter`:

1. **Classifies the task** (`inferTaskProfile`) — `multimodal`, `reasoning`, `tool_orchestration`, `long_context`, `lightweight`, `memory_compression`.
2. **Chooses the primary** (`choosePrimaryProvider`):
   - `reasoning` / `tool_orchestration` / `long_context` → **Groq** (else Gemini)
   - `multimodal` → **Gemini**
   - `lightweight` / `memory_compression` → **Groq** (else Mistral)
   - default → **Groq** (else Mistral)
   - If `LLM_PRIMARY_PROVIDER` is set to a concrete provider, that provider is used directly; `LLM_FORCE_PROVIDER` hard-forces one provider.
3. **Builds the provider order** (`buildProviderOrder`) — forced → request `preferredProvider` → primary → every other available provider, **skipping any provider that cannot handle the request** (e.g. Groq/Mistral on image requests).
4. **Generates with failover**:
   - **Non-streaming:** iterates the order; only retryable failures (rate limit, invalid key, 5xx, timeout, model error) trigger fallback. Diagnostics stamp `providerId`, `providerCode`, `model`, `keyConfigured`.
   - **Streaming:** `createFallbackStream` yields from the primary; if the stream fails *before emitting any chunk*, and the failure is retryable, it switches to the next capable provider. Once chunks have reached the client, mid-stream fallback is not attempted (the stream is terminated with an error).
   - Invalid fallback paths (a provider that can't handle the request) are blocked with a 400 error rather than silently skipped.
5. `LLM_FALLBACK_PROVIDER` is read by the router but the fallback cascade is currently derived from **availability + capability filtering** rather than this value.

---

## 4. Current Providers

### Groq (primary)

- Env: `GROQ_API_KEY`, `GROQ_MODEL` (default `openai/gpt-oss-120b`).
- OpenAI-compatible endpoint: `https://api.groq.com/openai/v1`.
- Text, streaming, tool calling (with streamed tool-call delta assembly). No image support.

### Gemini

- Env: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`), `GEMINI_REASONING_MODEL`, `GEMINI_VISION_MODEL`.
- Resolves: multimodal → vision model; reasoning/long-context/tool → reasoning model; else default.
- Text, streaming, tool calling (function declarations, `AUTO` mode), images (embedded base64 parts), plus voice transcription and optional server TTS.

### Mistral

- Env: `MISTRAL_API_KEY`, `MISTRAL_MODEL` (default `mistral-small-latest`), `MISTRAL_LIGHT_MODEL`, `MISTRAL_VISION_MODEL` (unused, since the adapter is not multimodal).
- Resolves: lightweight/memory-compression tasks → lightweight model; else default.
- Text, streaming, tool calling. No image support in the current adapter.

---

## 5. Environment Configuration

```env
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-120b

GEMINI_API_KEY=
# GEMINI_MODEL=gemini-2.5-flash
# GEMINI_REASONING_MODEL=gemini-2.5-flash
# GEMINI_VISION_MODEL=gemini-2.5-flash

MISTRAL_API_KEY=
# MISTRAL_MODEL=mistral-small-latest
# MISTRAL_LIGHT_MODEL=
# MISTRAL_VISION_MODEL=pixtral-12b-2409

# Router (optional; 'auto' is the default)
# LLM_PRIMARY_PROVIDER=auto    # auto | groq | gemini | mistral
# LLM_FALLBACK_PROVIDER=
# LLM_FORCE_PROVIDER=
# LLM_STREAM_CHUNK_DELAY_MS=0
```

> **Never commit actual API keys.** All keys are read from `process.env` at runtime; providers are available only when their key is set (`isAvailable()`).

---

## 6. Configuration-Driven, Capability-Aware

- **Configuration-driven:** the provider order is derived from environment/config, not hard-coded (modulo the `auto` heuristics above).
- **Capability-aware:** providers that cannot satisfy a request are filtered out of the order, up-front and mid-stream, and multimodal requests are never sent to text-only providers.
- **Fail-safe:** if no provider remains, a descriptive error is thrown (`No LLM providers are available. Configure GROQ_API_KEY, GEMINI_API_KEY or MISTRAL_API_KEY.` or a multimodal-specific message).

---

## 7. Testing

See the test section of the README. Relevant commands:

```bash
node tests/groqProvider.test.js          # unit: provider contract, tool sanitization, routing/fallback
node tests/groqProvider.mock.test.js     # mock: Groq request/response lifecycle (no API key)
node tests/groqProvider.live.test.js     # live: real Groq calls (requires GROQ_API_KEY)
node tests/streamingRuntime.test.js      # streaming delivery/persistence tests
```