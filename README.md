<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d0221,25:1a0b3d,50:2d0a4e,75:1a0b3d,100:0d0221&height=200&section=header&text=ARC-AI&fontSize=70&fontColor=00fff5&fontAlignY=42&animation=fadeIn&desc=AUTONOMOUS%20REAL-TIME%20CONVERSATIONAL%20AGENT&descAlignY=62&descSize=16&descColor=ff2ee6" width="100%"/>

<h1>🤖 ARC-AI: Autonomous Real-time Conversational Agent</h1>

<p><strong>A MERN-stack Digital Assistant featuring RAG Memory, Live Web Research, Proactive Cron Routines, and Serverless Microservices.</strong></p>

<img src="https://img.shields.io/badge/MERN--STACK-0d0221?style=for-the-badge&labelColor=0d0221&color=00fff5" />
<img src="https://img.shields.io/badge/RAG--MEMORY-0d0221?style=for-the-badge&labelColor=0d0221&color=b026ff" />
<img src="https://img.shields.io/badge/SERVERLESS-0d0221?style=for-the-badge&labelColor=0d0221&color=ff2ee6" />
<img src="https://img.shields.io/badge/BUILD-v1.0.0-0d0221?style=for-the-badge&labelColor=0d0221&color=39ff14" />

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

**ARC-AI (Autonomous Real-time Conversational AI)** is a full-stack, voice-activated digital assistant that moves beyond traditional reactive chatbots into a **proactive, autonomous agent**.

Evolving rapidly into a persistent AI workspace platform (similar to ChatGPT, Claude, and Cursor), ARC-AI is built on a highly modular, provider-agnostic runtime capable of real-time execution, semantic memory retrieval, and dynamic frontend actuation.

### 🎥 Main Showcase Demo

▶️ **[Watch the Full YouTube Demo](https://www.youtube.com/watch?v=jt7q8v5KsrU)**

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🔥 LATEST STABLE RELEASE: v1.0.0

### *Production-Grade Security Hardening, Graceful Lifecycles, & WebAssembly Sandboxing*

ARC-AI is now officially production-ready and fully prepared for local or remote hosting with the release of **v1.0.0**. This release introduces secure WebAssembly-based code execution sandboxing, mandatory OAuth token database encryption, container-friendly graceful lifecycles, and relative volume portability.

#### 🛡️ WebAssembly-Isolated Sandboxed Execution
* **QuickJS WebAssembly Runtime:** Replaced the deprecated `vm2` executor with `quickjs-emscripten`. Code execution triggered by LLMs now runs inside a secure WebAssembly sandbox, resolving the RCE code execution vulnerability.
- **Mandatory OAuth Database Encryption:** Enforced `GOOGLE_TOKEN_ENCRYPTION_KEY` as a strictly required environment variable. The backend now fails-fast and exits on startup if this key is missing.
- **Dynamic CORS Handler:** Replaced static CORS wildcards (`'*'`) with a dynamic origin resolver. This resolves the browser validation bug when combining wildcards with credential transmission (`credentials: true`).

#### ⚡ Runtime Reliability & Graceful Lifecycles
- **WhatsApp Process Leak Prevention:** Implemented an activity-aware idle timeout reaper. Headless Chromium browsers are automatically terminated after 5 minutes of inactivity, preserving system RAM and CPU.
- **Graceful Shutdown Lifecycles:** Added signal listeners (`SIGINT`, `SIGTERM`) to execute clean resource teardowns. All HTTP servers, MongoDB connections, and active WhatsApp/Puppeteer processes are cleanly shut down in parallel.
- **Race Condition Resolutions:** Synchronized client destruction and recovery hooks to prevent socket binding conflicts.

#### 🏗️ Developer Onboarding & Deployment Portability
- **Compose Volume Portability:** Replaced absolute host directory paths in `docker-compose.yml` with a portable, relative bind mount (`./.whatsapp-sessions`).
- **Complete Environment Templates:** Added `.env.example` templates in both the root and `server` directories covering all mandatory and optional configurations (e.g. LLM routing, models, and timeouts).
* 🔗 **[Read the Full v1.0.0 Release Notes](./docs/v1.0.0-RELEASE.md)**


##  MAJOR RELEASE: v0.13.0-beta

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
* 🔗 **[Watch v0.13.0 Workspace Orchestration Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYmluEPxOhf/)**

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🏗️ v0.12.0-beta: Runtime Architecture Evolution

ARC-AI was restructured into a more autonomous, execution-oriented runtime architecture.

* **Execution & Provider Safety:** Recovery logic lives ABOVE the provider layer instead of mutating continuation chains. This preserves streaming continuity, `tool_call` consistency, and execution integrity.
* **Multi-Workspace Foundation:** Introduced `WorkspaceRuntimeManager.js` to dynamically inject context. Every major runtime entity (conversations, memories, executions) became workspace-aware with isolated Pinecone vector namespaces.
* 🔗 **[Watch Architecture Update 1 Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYfdVKmRQOf/)** | 🔗 **[Watch Architecture Update 2 Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYiHRfKRnqU/)**

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🧠 v0.11.0-beta: Intelligent Workspace & Provider-Orchestrated Runtime

This phase established the intelligence layer on top of the persistent workspace foundation, introducing advanced memory governance and a scalable backend.

* **Intelligent Provider Routing:** Dynamically selects Gemini (reasoning, multimodal, planning) or Mistral (fast, cost-effective, summarization).
* **Semantic Workspace Search:** Keyword and semantic retrieval across conversation titles, historical messages, and contextual discussions.
* **Advanced Memory Lifecycle:** Clear separation of Conversation History, Working Context, Semantic Memory, and Long-Term User Facts.
* **Intelligent Retrieval Layer:** Utilizes relevance scoring, recency weighting, and duplicate suppression to fetch prioritized, low-noise context.
* 🔗 **[Watch Provider Routing Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYNhWsDxFG1/)** | 🔗 **[Watch Runtime Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYXqoNMtwjL/)**

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 🛠️ The Core Ecosystem & Autonomous Tools

ARC-AI is equipped with a suite of autonomous tools for research, automation, communication, and direct interface actuation, all utilizing a low-latency **Socket.IO + REST API pipeline**.

### 🎥 1. GPT-4o Live Vision & Multimodal Routing

* Real-time webcam video feed for live vision input. Captures the current camera frame when the user speaks and pipes the frame directly into the existing `ai:stt:final` socket payload.
* Routes visual context securely to the Pixtral vision model, protected by runtime safety guardrails to prevent silent attachment loss.
* 🔗 **[Watch Live Vision Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DX84FejNgwo/)**

### 🌐 2. Live Web Research

* Real-time DOM scraping using Cheerio.
* API-based search, live weather, and news fetching capabilities.
* 🔗 **[Watch Web Research Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DW31J3bEbu9/)**

### ⏰ 3. Proactive Routine Engine

* Converts natural language into scheduled cron jobs.
* Robust background execution system for deferred tasks and recurring routines.
* 🔗 **[Watch Proactive Routine Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DW7DQ8lE-Wr/)**

### 💬 4. WhatsApp Automation

* Autonomous message creation, delivery, and seamless integration with agent workflows.
* 🔗 **[Watch WhatsApp Automation Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYH4hoYR1gC/)**

### 🖥️ 5. UI Actuation & External Communication

* **UI Actuation:** Dynamically change themes, open websites, play media, and copy to clipboard based on conversational context.
* **Serverless Email:** Utilizes a Google Apps Script webhook to bypass SMTP restrictions, ensuring 100% reliable production delivery.
* 🔗 **[Watch UI Actuation Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DWzcz9YE797/)**

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## 💻 Tech Stack

<div align="center">

<img src="https://skillicons.dev/icons?i=react,vite,tailwind,nodejs,express,socketio,mongodb&theme=dark" />

</div>

<br/>

| Category | Technologies |
| --- | --- |
| **Frontend** | React, Vite, Tailwind CSS, Web Speech API |
| **Backend** | Node.js, Express.js, Socket.IO, node-cron |
| **Database** | MongoDB Atlas, Pinecone (Vector RAG) |
| **AI / ML Runtime** | Gemini, Mistral AI, Pixtral |
| **Infrastructure** | Google Apps Script (Webhooks) |

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## ⚙️ Local Setup

### Prerequisites

* Node.js 
* MongoDB Atlas Cluster
* Mistral API Key
* Pinecone API Key

### 1. Clone the Repository

```bash
git clone https://github.com/Aashutosh31/arc-ai-project.git
cd arc-ai-project

```

### 2. Backend Configuration

```bash
cd server
npm install

```

Create a `.env` file in the `server` directory by copying the sample template:

```bash
cp .env.example .env
```

Open `.env` and fill in your API keys and configuration. Note that **`GOOGLE_TOKEN_ENCRYPTION_KEY`** is a strictly mandatory key (32-byte hex/random string) required to encrypt OAuth tokens stored in the database. If missing, the server will fail-fast and crash on startup.

Start the development server:

```bash
npm run dev
```

### 3. Frontend Configuration

```bash
cd ../client
npm install
```

*(Optional)* If you run the backend on a different port than `5000`, configure it by creating a `.env` file in the `client` directory:
```env
VITE_API_URL=your_backend_server_url
```

Start the development server:

```bash
npm run dev
```

### 4. Running with Docker

ARC-AI can be self-hosted using Docker Compose.

#### Requirements
- Docker
- Docker Compose

#### Steps to Run

1. Navigate to the server directory:
   ```bash
   cd server
   ```

2. Copy the sample environment file and configure your API keys:
   ```bash
   cp .env.example .env
   ```

3. Build and start the services:
   ```bash
   docker compose up --build
   ```

4. Visit the backend at:
   ```
   http://localhost:5000
   ```

#### Persistent WhatsApp Sessions
To prevent needing to re-authenticate via QR code on every container restart, the host session directory (e.g. `./.whatsapp-sessions` or a custom configured mount) is intentionally mounted to `/app/.whatsapp-sessions` in the container. This preserves the authentication keys and session state managed by `whatsapp-web.js` (`LocalAuth`).

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

## ⚠️ Attribution Required

This project is open-source under the MIT License. You are free to use, modify, and distribute this code. However:

* You **MUST** provide proper credit to the original author.
* You **MUST** include a link to this repository.
* You **MUST NOT** claim this project as your own work.

<img src="https://capsule-render.vercel.app/api?type=rect&color=0:00fff5,50:b026ff,100:ff2ee6&height=3" width="100%"/>

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