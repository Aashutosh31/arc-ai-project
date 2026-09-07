<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d0221,25:1a0b3d,50:2d0a4e,75:1a0b3d,100:0d0221&height=200&section=header&text=ARC-AI&fontSize=70&fontColor=00fff5&fontAlignY=42&animation=fadeIn&desc=AUTONOMOUS%20REAL-TIME%20CONVERSATIONAL%20AGENT&descAlignY=62&descSize=16&descColor=ff2ee6" width="100%"/>

<h1>🤖 ARC-AI: Autonomous Real-time Conversational Agent</h1>

<p><strong>A MERN-stack, provider-agnostic AI workspace with conversational voice, live vision, autonomous tool execution, memory, and realtime streaming.</strong></p>

<img src="https://img.shields.io/badge/LLM--ROUTER-Groq%20%7C%20Gemini%20%7C%20Mistral-00fff5?style=for-the-badge&labelColor=0d0221&color=00fff5" />
<img src="https://img.shields.io/badge/VOICE-Half--Duplex%20Advanced%20Voice-b026ff?style=for-the-badge&labelColor=0d0221&color=b026ff" />
<img src="https://img.shields.io/badge/TOOLS-22--Tool%20Registry-ff2ee6?style=for-the-badge&labelColor=0d0221&color=ff2ee6" />
<img src="https://img.shields.io/badge/STREAMING-Socket.IO%20Real--time-39ff14?style=for-the-badge&labelColor=0d0221&color=39ff14" />

<br/><br/>

<a href="https://arc-ai-project.vercel.app/" target="_blank">
  <img width="100%" alt="ARC-AI Demo" src="https://github.com/user-attachments/assets/3f9fd56f-263c-4fdd-b6fd-391612ba7807" />
</a>

<p><strong>🔗 Click the image to try the Live Application</strong></p>

<p>
  <a href="https://arc-ai-project.vercel.app/"><img src="https://img.shields.io/badge/Live-Demo-0d0221?style=for-the-badge&logo=vercel&logoColor=00fff5&labelColor=0d0221&color=00fff5" /></a>
  <a href="https://github.com/Aashutosh31/arc-ai-project"><img src="https://img.shields.io/badge/Source-Code-0d0221?style=for-the-badge&logo=github&logoColor=ff2ee6&labelColor=0d0221&color=ff2ee6" /></a>
</p>

</div>
<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🚀 Overview

**ARC-AI (Autonomous Real-time Conversational AI)** is a full-stack, multi-provider AI assistant that behaves like a persistent, conversational workspace. It combines:

- **Advanced Voice Mode** — a conversational, half-duplex voice interaction model with interruption (barge-in) and live vision.
- **Capability-aware LLM routing** across **Groq**, **Gemini**, and **Mistral** with automatic fallback.
- **22 autonomous tools** (web research, memory, calendar/email/reminders, media, UI actuation, code sandboxing, and more) executed through a provider-independent tool registry.
- **Realtime streaming** over Socket.IO with zero artificial delay by default and non-blocking persistence.
- **Workspace-scoped memory** — semantic (Pinecone) plus structured (MongoDB) retrieval.
- **ECMAScript (QuickJS/WASM) sandboxing** for LLM-triggered code execution.

### 🎥 Main Showcase Demo

▶️ **[Watch the Full YouTube Demo](https://www.youtube.com/watch?v=jt7q8v5KsrU)**

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🧭 High-Level Architecture

```
User
 ↓
Text / Voice / Vision
 ↓
Client (React + Vite)
 ↓
Socket.IO  /  REST (Express)
 ↓
Authentication → canonical actor { type: user|guest, id }
 ↓
AIService (orchestration)
 ↓
LLMRouter
 ├── Groq (primary, text/tools/streaming)
 ├── Gemini (multimodal, voice STT, vision)
 └── Mistral (lightweight fallback)
 ↓
Tool Registry / Memory (Pinecone + MongoDB) / Workspace / Task Execution
 ↓
Streaming Runtime (Socket.IO chunks, zero artificial delay)
 ↓
Text + TTS (browser speechSynthesis or server Gemini audio)
 ↓
Client
```

Deep dives live in **[`docs/`](docs/)**:

- [`docs/architecture-and-runtime.md`](docs/architecture-and-runtime.md) — request lifecycle, streaming, workspaces, persistence.
- [`docs/llm-providers.md`](docs/llm-providers.md) — LLMRouter, providers, capabilities, fallback.
- [`docs/advanced-voice.md`](docs/advanced-voice.md) — Advanced Voice state machine, STT/TTS paths, configuration.
- [`docs/vision-and-multimodal.md`](docs/vision-and-multimodal.md) — live webcam vision and multimodal routing.
- [`docs/autonomous-tools.md`](docs/autonomous-tools.md) — the 22-tool registry and execution model.
- [`docs/memory-and-rag.md`](docs/memory-and-rag.md) — memory learning and workspace-scoped retrieval.
- [`docs/isolated-workspaces.md`](docs/isolated-workspaces.md) — workspace isolation and ownership.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🔐 Identity & Authentication

ARC-AI is **provider-agnostic at the identity layer**: every login method resolves to one canonical actor shape — `{ type: 'user' | 'guest', id: string }` — at the auth boundary (`server/lib/actor.js`).

- **Guest sessions** — instant one-tap access (`POST /api/auth/guest`). Guests get a `guest_<uuid>` id, a starter credit balance, and a scoped conversation history. Guests do **not** own workspaces and do **not** persist long-term memory (no `AIMemory`/`UserFact` documents, no vector writes).
- **Google authentication** — OAuth sign-in (`GET /api/auth/google/*`), usable to create or link a Google identity, with Google Calendar connection for real users.
- **Email/password** — classic register/login with JWT.
- **REST + Socket.IO identity consistency** — the same canonical actor is set on Express requests (`req.actor`) and Socket.IO sockets (`socket.actor`), so a voice command over the socket and a REST `/api/conversations` call always resolve to the same identity.
- **Workspace ownership model** — `Workspace.owner` is an **ObjectId reference to a real user**. Guests auto-resolve to `null` workspace scoping. ObjectId-typed ownership collections (`Workspace.owner`, `AIMemory.userId`, `UserFact.userId`) only ever reference real users.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🧠 LLM Architecture

ARC-AI is powered by a capability-aware **`LLMRouter`** (`server/lib/llm/LLMRouter.js`) over a provider plugin registry:

| Provider | Text | Streaming | Tools | Multimodal (images) |
| --- | --- | --- | --- | --- |
| **Groq** (primary) | ✅ | ✅ | ✅ | ❌ `openai/gpt-oss-120b` is text-only via the OpenAI-compatible endpoint |
| **Gemini** | ✅ | ✅ | ✅ | ✅ |
| **Mistral** | ✅ | ✅ | ✅ | ❌ adapter rejects image attachments |

- **Current primary provider:** `groq`
- **Current primary model:** `openai/gpt-oss-120b`
- **Default routing (`LLM_PRIMARY_PROVIDER=auto`):**
  - reasoning / tool orchestration / long context → **Groq** (else Gemini)
  - **multimodal / any image attachment → Gemini** (Gemini stays important because Groq GPT-OSS 120B is text-only)
  - lightweight / memory compression → **Groq** (else Mistral)
  - default → **Groq** (else Mistral)
- **Fallback** is capability-aware: providers that cannot handle a request (e.g. Groq on an image request) are excluded from the cascade, both up-front and mid-stream.
- Provider selection is **configuration-driven**: set `LLM_PRIMARY_PROVIDER` to pin the primary, or `LLM_FORCE_PROVIDER` to force a single provider.

### Model configuration (environment variables that exist today)

```env
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b

LLM_PRIMARY_PROVIDER=auto      # auto | groq | gemini | mistral
LLM_FALLBACK_PROVIDER=         # read by the router; fallback currently derives from availability + capability filtering
LLM_FORCE_PROVIDER=            # optional hard override
LLM_STREAM_CHUNK_DELAY_MS=0    # 0 = no artificial streaming delay

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
GEMINI_REASONING_MODEL=gemini-2.5-flash
GEMINI_VISION_MODEL=gemini-2.5-flash

MISTRAL_API_KEY=your_mistral_api_key
MISTRAL_MODEL=mistral-small-latest
MISTRAL_LIGHT_MODEL=
MISTRAL_VISION_MODEL=pixtral-12b-2409
```

> **Note:** `MISTRAL_VISION_MODEL` is configured, but the Mistral adapter declares `multimodal: false` and rejects image attachments; images route to Gemini.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🛠️ Tool System

ARC-AI maintains a **provider-independent, convention-based tool registry** (`server/tools/index.js`) that auto-discovers any `{ schema, execute }` module in the tools directory. The current registry exposes **22 tools**:

- **Communication:** `sendEmail` (Google Apps Script webhook), `sendWhatsAppMessage`
- **Calendar & time:** `checkCalendar`, `scheduleMeeting`, `getTime`, `createReminder`, `setReminder`, `stopReminder`
- **Research:** `webSearch`, `getTopNews`, `getWeather`, `scrapeWebsite`, `deepResearchSwarm`
- **Memory:** `memorize`, `recallMemory`, `storeUserFact`
- **UI actuation (client action):** `changeTheme`, `openWebsite`, `copyToClipboard`, `playMedia`, `stopMedia`
- **Computation:** `executeCode` (QuickJS/WASM sandbox)

**Tool calling flow:**

1. The model is offered the full tool schema list (`getSchemas()`).
2. When the response contains `toolCalls`, ARC-AI decides between a **planner path** (multi-step autonomous execution via `TaskPlanner`) or an **inline path** (sequential tools via `TaskExecutor`).
3. Each tool runs through `TaskExecutor`, which charges ARC-AI credits, packages the execution context (actor, workspace, conversation, abort signal), and invokes `tool.execute(args, context, socket)`.
4. Tool results are normalized per provider (tool-call continuation chain rebuilt by `buildProviderContinuationMessages`) and **fed back to the model** for a follow-up synthesis pass.
5. `clientAction` results are emitted back to the frontend so the UI can act (theme change, open URL, clipboard, media).

Failures route through `ToolRecoveryManager` (retry for transient/parse errors, scrape-fallback on 404s, replan suggestions). Tools are defined once and work across Groq, Gemini, and Mistral — not every provider is guaranteed identical tool behavior, but the registry itself is provider-neutral.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🎤 Advanced Voice Mode

Voice interaction is **conversational and half-duplex** (one direction at a time). It is governed by an explicit state machine (`client/src/utils/voiceInteractionMachine.js`):

```
idle → listening → processing → speaking → listening → …
```

- **During `speaking`:** the microphone is disabled, and ARC can never transcribe its own speech.
- **Barge-in:** one tap while ARC is speaking stops audio + generation immediately and returns to `listening` (the mic re-arms).
- During `listening`, TTS playback must not be active — a clean conversational boundary.

**Voice input (STT)** is feature-detected, not assumed:

- **Native path** — browsers exposing `SpeechRecognition`/`webkitSpeechRecognition` (continuous, interim results).
- **Server-STT fallback** — browsers without native recognition (e.g. Firefox typically) use `MediaRecorder` + `POST /api/voice/transcribe`, which transcribes via Gemini and charges 1 ARC-AI credit.
- **VAD / silence detection** — RMS-based voice activity detection (threshold `0.03`) on the raw audio spectrum; a trailing silence (~1.5 s) submits the utterance; a 60 s cap per utterance.
- **Turn/session guards and stale-callback protection** — each listening cycle gets a unique turn id; late browser callbacks carrying a stale turn are discarded.
- **Live vision integration** — with the camera enabled, the current frame is captured at utterance finalization and attached to the voice command.

**Crucially: voice input ≠ voice output.** Input and output use separate engines (see below). Not all browsers use the same STT implementation; capability detection decides.

## 🔊 Text-to-Speech (TTS)

- **Default path — browser speech synthesis** (`speechSynthesis`): sentence-based queued playback via `useTextToSpeech` (clean text, split on sentence/clause boundaries, natural-voice preference, Firefox resume guard).
- **Optional path — server TTS** (`TTS_PROVIDER=gemini`): ARC-AI streams the LLM output to a `TtsStreamBuffer`, splits it at sentence boundaries, synthesizes each segment via Gemini, and emits base64 WAV audio over Socket.IO. The client queues and plays it with a plain `HTMLAudioElement`.
- Server TTS config: `TTS_PROVIDER=browser|gemini`, `TTS_MODEL=gemini-2.5-flash-preview-tts`, `TTS_VOICE=Kore` (reuses `GEMINI_API_KEY`).
- A per-response `ai:tts:mode` event tells the client which path to use, so browser and server voice never double-play.
- **Interruption/flush:** stopping generation flushes the audio queue; a final `ai:tts:audio:stop` event clears pending server audio.
- **Browser limitations:** autoplay policies require a user gesture before audio starts, and voice output depends on browser/OS-installed voices (voice *quality/identity* varies).

> **Validation status:** the server-side (Gemini) TTS pipeline is implemented and covered by headless unit tests (`server/tests/ttsService.test.js`), but has **not** been validated across a wide matrix of browsers. Treat cross-browser server TTS as *implemented, not fully production-validated*; browser-authored voice differences remain.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## ⚡ Streaming

- Providers stream tokens; `StreamingRuntime` relays chunks to the client over **Socket.IO** (`ai:tts:response:chunk`).
- **Zero artificial delay by default** — `LLM_STREAM_CHUNK_DELAY_MS` defaults to `0`. Set it (e.g. `20`) only to simulate a typing effect.
- **Persistence is decoupled from per-chunk delivery** — background callbacks (DB writes, vector upserts) never gate socket delivery and can never break it.
- **Interruption/finalization** — every stream ends with an `isFinal` terminal event; `ai:stream:stop` aborts in-flight generation and cleanup is idempotent (the UI can never get "stuck streaming").
- Latency-sensitive behavior is covered by a regression test (`server/tests/streamingRuntime.test.js`). Specific production latency numbers are not claimed here.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 👁️ Vision

- **Live webcam input** — `LiveVisionCamera` streams the camera into the UI and captures the current frame (base64 JPEG) when the user speaks or submits a command.
- The captured frame is attached to the command payload (`ai:stt:final`) and **routed to a multimodal-capable provider (Gemini)** by the LLMRouter.
- Multimodal requests never silently fall through to a text-only provider; if none is available, a clean error is returned.

## 🧠 Memory & RAG

- **Memory learning** — after each successful exchange ARC may write an `AIMemory` record and upsert a Pinecone vector (semantic + structured memory, workspace-scoped).
- **Retrieval** — `WorkspaceContextManager` merges long-term (semantic + structured keyword search) and short-term (recent conversation) context with recency weighting and duplicate suppression.
- **Guest limitation** — guest sessions do **not** write or retrieve long-term memory; they get no `AIMemory`/`UserFact`/vector results and only hold conversation-scoped state.
- **Workspace-aware behavior** — memory and search are scoped to the active workspace (Pinecone namespaces `workspace_<id>`), and search results are never cross-workspace.

## 💳 Credits

ARC-AI has its own **application-level credit system** (`server/services/creditService.js`). This is an internal per-user usage / anti-abuse mechanism, **entirely separate from provider billing**:

| Concept | What it is |
| --- | --- |
| **ARC-AI Credits** | Internal per-user balance. 1 credit per AI request, tool-specific costs, 1 credit per server voice transcription. Refilled/upgraded by signing in. Guests start lower than signed-in users. |
| **Provider billing** | Your Gemini / Groq / Mistral API account billing and quotas. |

No secrets or implementation details are exposed here — the system simply decouples product usage accounting from provider API costs.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🖥️ Browser Automation

- **WhatsApp automation** uses `puppeteer-core` + a system-installed Chromium (configurable via `CHROMIUM_PATH`, `CHROME_BIN`, `PUPPETEER_EXECUTABLE_PATH`). Headless browsers are idle-reaped after inactivity to preserve memory.
- The Docker image installs Chromium + all required libraries so WhatsApp/Puppeteer run inside containers (see [`docs`](docs/) and `server/RAILWAY_DOCKER_NOTES.md`).
- There is **no general-purpose server-side browser-automation tool** beyond the WhatsApp integration; user-facing "open website / play media / change theme" behaviors are delivered as client-side actions over the socket, not headless browsing.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 💻 Tech Stack

<div align="center">

<img src="https://skillicons.dev/icons?i=react,vite,nodejs,express,socketio,mongodb,webpack&theme=dark" />

</div>

<br/>

| Category | Technologies |
| --- | --- |
| **Frontend** | React, Vite, styled-components, Web Speech API (SpeechRecognition + speechSynthesis), Socket.IO client |
| **Backend** | Node.js, Express.js, Socket.IO, node-cron, BullMQ |
| **Database** | MongoDB (Mongoose), Pinecone (Vector RAG), Mistral embeddings |
| **AI / ML Runtime** | Groq (GPT-OSS 120B via OpenAI-compatible API), Gemini, Mistral AI |
| **Sandboxing** | quickjs-emscripten (WebAssembly code execution) |
| **Infrastructure** | Google Apps Script (email webhook), Google OAuth, Docker, Vercel (frontend) |

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 📦 Environment Variables

The authoritative template is `.env.example` (root and `server/` are kept in sync). Core variables:

```env
# Server
PORT=5000
FRONTEND_URL=http://localhost:5173
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret_key_minimum_32_characters

# LLM providers
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
MISTRAL_API_KEY=your_mistral_api_key
MISTRAL_MODEL=mistral-small-latest

# Optional LLM Router & streaming
# LLM_PRIMARY_PROVIDER=auto   # auto | groq | gemini | mistral
# LLM_FALLBACK_PROVIDER=
# LLM_FORCE_PROVIDER=
# LLM_STREAM_CHUNK_DELAY_MS=0

# Optional server TTS (Gemini)
# TTS_PROVIDER=browser        # browser (default) | gemini
# TTS_MODEL=gemini-2.5-flash-preview-tts
# TTS_VOICE=Kore

# Memory / integrations
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX=arc-brain
GOOGLE_EMAIL_WEBHOOK=your_google_apps_script_webhook_url
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5000/api/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=your_secure_32_byte_token_encryption_key

# Optional Puppeteer / Chromium paths
# CHROMIUM_PATH=
# CHROME_BIN=
# PUPPETEER_EXECUTABLE_PATH=

# Optional WhatsApp
# WHATSAPP_IDLE_TIMEOUT_MS=300000
```

Frontend (client `.env`):

```env
VITE_API_URL=http://localhost:5000
VITE_APP_URL=http://localhost:5173
```

> `GOOGLE_TOKEN_ENCRYPTION_KEY` is **mandatory** — the server fails-fast at startup if it is missing.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## ⚙️ Local Setup

### Prerequisites

- Node.js (LTS)
- MongoDB Atlas Cluster (`MONGO_URI`)
- A Groq, Gemini, and/or Mistral API key (at least one is required)
- Pinecone API key (for RAG memory)
- Google OAuth credentials + `GOOGLE_TOKEN_ENCRYPTION_KEY` (required)

### 1. Clone the Repository

```bash
git clone https://github.com/Aashutosh31/arc-ai-project.git
cd arc-ai-project
```

### 2. Backend Configuration

```bash
cd server
npm install
cp .env.example .env
```

Fill in `.env` — in particular `MONGO_URI`, `JWT_SECRET`, at least one LLM provider key, and the **mandatory** `GOOGLE_TOKEN_ENCRYPTION_KEY` (32+ hex chars). The server fails-fast on startup if the encryption key is missing.

Start the development server:

```bash
npm run dev
```

### 3. Frontend Configuration

```bash
cd ../client
npm install
```

If the backend runs somewhere other than `http://localhost:5000`, create a `.env` (see template above) and set `VITE_API_URL`. Then:

```bash
npm run dev
```

### 4. Self-Hosting with Docker

The backend is packaged in `server/Dockerfile` (Node 20 + system Chromium for WhatsApp/Puppeteer). `server/docker-compose.yml` uses host networking and a relative, portable bind mount for WhatsApp session persistence.

```bash
cd server
cp .env.example .env      # configure API keys
docker compose up --build
```

The backend listens on `http://localhost:5000`. See `server/RAILWAY_DOCKER_NOTES.md` for Railway-specific notes. The frontend is deployable on **Vercel** (SPA rewrites + security headers are already in `client/vercel.json`).

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🧪 Testing

Tests use a framework-free harness (`assert`-based `check`/`checkAsync`) and run directly with `node` — no Jest/Mocha, no `npm test` script.

```bash
# Server
node tests/groqProvider.test.js          # unit tests (no API key needed)
node tests/groqProvider.mock.test.js     # mock lifecycle tests (no API key needed)
node tests/groqProvider.live.test.js     # LIVE integration tests (needs GROQ_API_KEY)
node tests/streamingRuntime.test.js      # streaming delay / non-blocking persistence
node tests/ttsService.test.js            # TTS segmentation, WAV framing, buffering

# Client
node scripts/testVoiceMachine.js         # Advanced Voice state-machine regression tests
```

| Kind | Coverage |
| --- | --- |
| **Unit tests** | Provider contract/routing/fallback, streaming runtime, TTS pure logic, voice state machine |
| **Mock tests** | Groq provider request/response lifecycle against a mocked OpenAI client (no network) |
| **Live API tests** | Real Groq calls (skipped without `GROQ_API_KEY`), router fallback to Gemini |
| **Manual browser QA** | Voice recognition/TTS/microphone flows are **not** automated — no live-browser testing has been performed in CI |

CI (`.github/workflows/ci.yml`) runs client lint + build and a server syntax check.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🆘 Troubleshooting

- **Provider key not configured** — set at least `GROQ_API_KEY`, `GEMINI_API_KEY`, or `MISTRAL_API_KEY`. The router error names the missing variable pattern (`GROQ_API_KEY, GEMINI_API_KEY or MISTRAL_API_KEY`).
- **Provider quota / rate limit** — the router classifies 429/quota errors as transient and retries the fallback provider automatically. Raised quotas on the provider account resolve it.
- **Unsupported multimodal provider** — image requests must land on Gemini; text-only providers are excluded from the fallback cascade and a clear "no multimodal-capable provider" error is returned.
- **Browser microphone permission** — ARC-AI requests `getUserMedia` with echo cancellation/noise suppression; a `NotAllowedError` means permission was denied in the browser/OS. Re-enable from site settings.
- **Browser SpeechRecognition unavailable** — the client falls back to `MediaRecorder` + server transcription (`POST /api/voice/transcribe`). If that endpoint returns `VOICE_STT_UNAVAILABLE`, `GEMINI_API_KEY` is missing/expired.
- **Server STT unavailable** — transcription requires Gemini; if unconfigured, typing still works and browsers with native recognition are unaffected.
- **TTS autoplay restrictions** — browsers block audio without a prior user gesture; interact with the app once (click/tap) before relying on voice replies.
- **Stale guest-session recovery** — the frontend validates cached guest tokens on load; on rejection it clears the stale session and mints a fresh one automatically.
- **Conversation/workspace mismatch** — conversations are actor- and workspace-scoped. Cross-actor access 404s; if a conversation seems to "disappear," confirm the correct workspace is active.
- **Docker/Chromium startup problems** — the image installs Chromium and its libraries; `docker-entrypoint.sh` auto-detects the binary. Override with `CHROMIUM_PATH` if Puppeteer still can't find an executable, and ensure adequate RAM for headless Chromium.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## ✨ Recent Architecture & Stability Improvements

Recent work refocused the runtime around identity correctness, conversational voice, streaming performance, and honest error handling:

- **Canonical actor identity** — every auth method (guest, Google, local) resolves to a single `{ type, id }` actor shared by REST and Socket.IO.
- **Workspace attribution correction** — conversations/memories/executions are strictly workspace- and actor-scoped; ownership is user-ObjectId based.
- **Stale guest-session recovery** — the client validates and auto-renews expired guest sessions.
- **Conversation message-loading race protection** — safer pagination/sync during workspace switches.
- **Truthful AI provider error classification** — provider failures are normalized and reported with model/key diagnostics, never masked or misleading.
- **Malformed Unicode sanitization** — lone surrogates are normalized before hitting Gemini/Mistral request bodies.
- **Generation terminal-state fixes** — streams and abort paths always settle (idempotent `isFinal`/cleanup), so the UI can't get stuck.
- **Groq provider integration** — added Groq as the primary text/tools provider with streaming, tool calling, and tool-call delta assembly.
- **Response streaming latency optimization** — removed the default per-chunk artificial delay (`LLM_STREAM_CHUNK_DELAY_MS=0`).
- **Non-blocking persistence** — database/vector writes never gate socket delivery.
- **Advanced Voice half-duplex state machine** — explicit conversational turn state machine with barge-in, silence detection, and stale-callback protection.

These are summarized as architectural improvements; historical release notes remain in the `docs/` index (`docs/isolated-workspaces.md`, `docs/v1.0.0-RELEASE.md`).

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## ⚠️ Attribution Required

This project is open-source under the MIT License. You are free to use, modify, and distribute this code. However:

* You **MUST** provide proper credit to the original author.
* You **MUST** include a link to this repository.
* You **MUST NOT** claim this project as your own work.

## 📝 License

This project is licensed under the MIT License.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 👨‍💻 Author & Original Creator

**Aashutosh Bairagi**
*Built ARC-AI from scratch (architecture, backend, agent system, RAG pipeline, UI actuation). First published with live demo and deployment.*

* 🔗 **GitHub:** [Aashutosh31](https://github.com/Aashutosh31)
* 🔗 **LinkedIn:** [Aashutosh Bairagi](https://www.linkedin.com/in/aashutosh-bairagi-559aa530b/)
* 🐦 **Twitter/X:** [@Aashutosh_dev31](https://x.com/Aashutosh_dev31)

> *If you are viewing this project elsewhere, verify the original source here.*

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

⭐ If you found this project interesting, consider starring the repo!

<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:ff2ee6,50:b026ff,100:00fff5&height=120&section=footer" width="100%"/>
</div>