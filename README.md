<div align="center">

<h1>🤖 ARC-AI: Autonomous Real-time Conversational Agent</h1>

<p><strong>A MERN-stack Digital Assistant featuring RAG Memory, Live Web Research, Proactive Cron Routines, and Serverless Microservices.</strong></p>

<a href="https://arc-ai-project.vercel.app/" target="_blank">
  <img width="100%" alt="ARC-AI Demo" src="https://github.com/user-attachments/assets/3f9fd56f-263c-4fdd-b6fd-391612ba7807" />
</a>

<p><strong>🔗 Click the image to try the Live Application</strong></p>

<p>
  <a href="https://arc-ai-project.vercel.app/"><img src="https://img.shields.io/badge/Live-Demo-brightgreen?style=for-the-badge" /></a>
  <a href="https://github.com/Aashutosh31/arc-ai-project"><img src="https://img.shields.io/badge/Source-Code-blue?style=for-the-badge" /></a>
</p>

</div>

---

## 🚀 Overview

**ARC-AI (Autonomous Real-time Conversational AI)** is a full-stack, voice-activated digital assistant that moves beyond traditional reactive chatbots into a **proactive, autonomous agent**.

Evolving rapidly into a persistent AI workspace platform (similar to ChatGPT, Claude, and Cursor), ARC-AI is built on a highly modular, provider-agnostic runtime capable of real-time execution, semantic memory retrieval, and dynamic frontend actuation.

### 🎥 Main Showcase Demo

▶️ **[Watch the Full YouTube Demo](https://www.youtube.com/watch?v=jt7q8v5KsrU)**

---

## 🔥 LATEST MAJOR RELEASE: v0.12.0-beta

### *Runtime Architecture Evolution & Multi-Workspace System*

ARC-AI is no longer operating as a simple `LLM → Tool → Response` pipeline. Over the last few weeks, the system has been restructured into a more autonomous, execution-oriented runtime architecture. ARC-AI has officially evolved from an "AI assistant" into an **"execution-aware AI runtime infrastructure."**

#### Update 1 — Execution & Provider Safety

Recovery logic now lives ABOVE the provider layer instead of mutating provider continuation chains directly. This preserves streaming continuity, provider compatibility, `tool_call` consistency, and execution integrity.

* ⚡ Execution orchestration & Planner/runtime separation
* 🔄 Autonomous recovery flows & Execution metadata lifecycle
* 🔒 Provider-safe continuation chains & Canonical tool reconstruction
* 🌊 Streaming-safe execution recovery
* 🔗 **[Watch Architecture Update 1 Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYfdVKmRQOf/)**

#### Update 2 — Multi-Workspace Runtime Architecture

The next major evolution transforms ARC-AI from a "single global AI session" into a **"true multi-workspace intelligent operating environment."**

* **Workspace Partitioning:** Every major runtime entity (conversations, memories, executions, tasks, retrievals, tool state) now requires a `workspaceId`. No cross-workspace leakage is permitted.
* **Active Workspace Context:** Governed by `WorkspaceRuntimeManager.js` to dynamically inject workspace context and orchestrate runtime metadata.
* **Memory & Vector Isolation:** Memory recall and semantic search are strictly workspace-aware. Each workspace maintains its own isolated Pinecone vector namespace.
* **Execution Isolation:** Task planners, executors, and recovery managers operate strictly within workspace boundaries.
* 🔗 **[Watch Workspace Orchestration Update 2 Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYiHRfKRnqU/)**

---

## 🧠 v0.11.0-beta: Intelligent Workspace & Provider-Orchestrated Runtime

This phase established the intelligence layer on top of the persistent workspace foundation, introducing advanced memory governance and a scalable backend.

* **Intelligent Provider Routing:** Dynamically selects Gemini (reasoning, multimodal, planning) or Mistral (fast, cost-effective, summarization). Prepared for future OpenAI, Claude, and Groq adapters.
* **Semantic Workspace Search:** Keyword and semantic retrieval across conversation titles, historical messages, and contextual discussions (e.g., *"mongodb architecture discussion"*).
* **Advanced Memory Lifecycle:** Clear separation of Conversation History, Working Context, Semantic Memory, and Long-Term User Facts. Includes pinned memories and editable long-term facts.
* **Intelligent Retrieval Layer:** Utilizes relevance scoring, recency weighting, and duplicate suppression to fetch prioritized, low-noise context instead of naive context dumping.
* **Production Runtime Hardening:** Interruption-safe streaming, guaranteed stream finalization, capability-aware multimodal fallbacks, and normalized tool orchestration.
* 🔗 **[Watch Provider Routing Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYNhWsDxFG1/)** | 🔗 **[Watch Runtime Demo](https://www.instagram.com/aashutosh_vaishnav.31/reel/DYXqoNMtwjL/)**

---

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

---

## 💻 Tech Stack

| Category | Technologies |
| --- | --- |
| **Frontend** | React 18, Vite, Tailwind CSS, Web Speech API |
| **Backend** | Node.js, Express.js, Socket.IO, node-cron |
| **Database** | MongoDB Atlas, Pinecone (Vector RAG) |
| **AI / ML Runtime** | Gemini, Mistral AI, Pixtral |
| **Infrastructure** | Google Apps Script (Webhooks) |

---

## ⚙️ Local Setup

### Prerequisites

* Node.js (v18+)
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

Create a `.env` file in the `server` directory:

```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secret
MISTRAL_API_KEY=your_key
PINECONE_API_KEY=your_key
EMAIL_WEBHOOK=your_webhook
FRONTEND_URL=http://localhost:5173

```

Start the development server:

```bash
npm run dev

```

### 3. Frontend Configuration

```bash
cd ../client
npm install
npm run dev

```

---

## ⚠️ Attribution Required

This project is open-source under the MIT License. You are free to use, modify, and distribute this code. However:

* You **MUST** provide proper credit to the original author.
* You **MUST** include a link to this repository.
* You **MUST NOT** claim this project as your own work.

---

## 📝 License

This project is licensed under the MIT License.

---

## 👨‍💻 Author & Original Creator

**Aashutosh Bairagi**
*Built ARC-AI from scratch (architecture, backend, agent system, RAG pipeline, UI actuation). First published with live demo and deployment.*

* 🔗 **GitHub:** [Aashutosh31](https://github.com/Aashutosh31)
* 🔗 **LinkedIn:** [Aashutosh Bairagi](https://www.linkedin.com/in/aashutosh-bairagi-559aa530b/)
* 🐦 **Twitter/X:** [@Aashutosh_dev31](https://x.com/Aashutosh_dev31)

> *If you are viewing this project elsewhere, verify the original source here.*
---

⭐ If you found this project interesting, consider starring the repo!


