<div align="center">

<h1>🤖 ARC-AI: Autonomous Real-time Conversational Agent</h1>

<p><strong>A MERN-stack Digital Assistant featuring RAG Memory, Live Web Research, Proactive Cron Routines, and Serverless Microservices.</strong></p>

<a href="https://arc-ai-project.vercel.app/" target="_blank">
  <img width="100%" alt="ARC-AI Demo" src="https://github.com/user-attachments/assets/ffa1f39d-89a1-4b3e-a8f8-740f98a300c1" />
</a>

<p><strong>🔗 Click the image to try the Live Application</strong></p>

<p>
  <a href="https://arc-ai-project.vercel.app/"><img src="https://img.shields.io/badge/Live-Demo-brightgreen?style=for-the-badge" /></a>
  <a href="https://github.com/Aashutosh31/arc-ai-project"><img src="https://img.shields.io/badge/Source-Code-blue?style=for-the-badge" /></a>
</p>

</div>

---

## 🚀 Overview

ARC-AI (Autonomous Real-time Conversational AI) is a full-stack, voice-activated digital assistant that moves beyond traditional reactive chatbots into a **proactive, autonomous agent**.

It can:

* 🌐 Fetch real-time data from the internet
* ⏰ Schedule and execute background tasks
* 🧠 Remember user data using vector embeddings (RAG)
* 🎯 Dynamically control the frontend UI
* 📩 Communicate externally via serverless webhooks

---

## ARC-AI: Persistent AI Workspace

**Major Platform Release** – ARC-AI now evolves from a real-time AI assistant into a **persistent AI workspace platform** similar to ChatGPT, Claude, and Cursor.

### 🚀 New Platform Capabilities

**🧠 Persistent AI Workspace**
* Persistent conversations across sessions
* Complete message history storage & retrieval
* Real-time conversation switching
* Paginated message retrieval pipeline
* Workspace-style AI sessions

**💬 Conversation Infrastructure**
* MongoDB conversation/message architecture
* Dedicated conversation lifecycle management
* Async auto-title generation from first exchange
* Soft-delete archival system
* Conversation metadata tracking

**⚡ Real-time System Upgrades**
* Socket.IO conversation synchronization
* Streaming-compatible persistence pipeline
* Voice + multimodal compatibility fully preserved
* Improved real-time state coordination
* Backward compatible with all existing features

**📱 Responsive Workspace UI**
* New sidebar conversation system
* Mobile/tablet adaptive layouts (desktop, tablet, mobile modes)
* Workspace-style navigation
* Real-time conversation switching
* Relative timestamps & conversation organization

**🏗️ Backend Enhancements**
* New REST APIs for conversation management
* AIService persistence integration
* Message-level storage architecture
* Pagination-ready retrieval pipeline
* Conversation REST endpoints: `/api/conversations`, `/api/conversations/:id`, `/api/conversations/:id/messages`

### ✅ Existing Systems Fully Preserved
* Advanced interruptible voice mode
* Multi-agent swarm workflows
* GPT-4o Live Vision
* WhatsApp automation
* RAG memory system
* Web research tools
* Proactive cron routines
* WebSocket streaming architecture
* Tool calling & execution

**Status**: ✅ Complete & Tested | Build: ✅ 157 modules, zero errors | Mobile Support: ✅ Desktop/Tablet/Mobile responsive

---

## 🔥 ARC-AI  — Provider-Agnostic Runtime & Multimodal Architecture

**A Major Backend Architecture Transformation**

ARC-AI has evolved from a tightly-coupled single-provider system into a **scalable provider-agnostic AI runtime** capable of:

* **Intelligent Provider Routing** – Dynamically select Gemini (reasoning, multimodal) or Mistral (fast, cost-effective) based on workload
* **Multimodal Capability Safety** – Prevent invalid multimodal fallbacks; gracefully fail when no compatible provider exists
* **Interruption-Safe Streaming** – Guaranteed stream finalization, safe cleanup, realtime token lifecycle management
* **Normalized Tool Orchestration** – Multi-step tool continuation across providers with consistent semantics
* **Provider-Independent Runtime** – Foundation for future OpenAI, Claude, Groq, and Ollama adapters
* **Structured Observability** – Route selection, fallback usage, latency tracking, interruption events

**Key Architecture Components**:
- `server/lib/llm/LLMRouter.js` – Intelligent orchestration & provider selection
- `server/lib/llm/StreamingRuntime.js` – Provider-independent streaming & interruption handling
- `server/lib/llm/providers/` – Modular Gemini & Mistral adapters

**Fully Compatible** with existing Socket.IO frontend, MongoDB persistence, Pinecone memory, dynamic tools, and voice workflows.

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DYNhWsDxFG1/

---

## 🎥  Showcase Demo

▶️ https://www.youtube.com/watch?v=jt7q8v5KsrU

---

## 🧠 Architectural Deep Dive

ARC-AI uses a **low-latency pipeline** combining REST APIs and WebSockets.

### Request Lifecycle

1. **Input** – Voice (Web Speech API) or Text
2. **WebSocket Emission** – Frontend sends `ai:stt:final`
3. **Agent Routing** – Context + memory collected
4. **Tool Evaluation** – LLM decides required tools
5. **Execution** – Backend executes tools autonomously
6. **Streaming** – Token-by-token response via sockets
7. **UI Actuation** – Direct frontend control

---

## 🛠️ Core Features

### 🎥 1. GPT-4o Live Vision

* Real-time webcam video feed for live vision input
* Captures the current camera frame when the user speaks
* Pipes the frame directly into the existing `ai:stt:final` socket payload
* Routes visual context to the Pixtral vision model for dynamic understanding

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DX84FejNgwo/

---

### 🧠 1. Infinite Memory (RAG)

* Vector embeddings via Mistral
* Pinecone for semantic search
* Long-term personalized memory

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DW83J1HESyQ/

---

### 🌐 2. Live Web Research

* Real-time scraping using Cheerio
* API-based search, weather, news

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DW31J3bEbu9/

---

### ⏰ 3. Proactive Routine Engine

* Natural language → cron jobs
* Background execution system

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DW7DQ8lE-Wr/

---

### 📩 4. External Communication

* Autonomous email sending
* Serverless webhook integration

---

### 🖥️ 5. UI Actuation

* Change theme
* Open websites
* Play media
* Copy to clipboard

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DWzcz9YE797/

---

### 💬 6. WhatsApp Automation

* Send messages to contacts via WhatsApp
* Autonomous message creation and delivery
* Integration with agent workflow

🎥 Demo:
https://www.instagram.com/aashutosh_vaishnav.31/reel/DYH4hoYR1gC/

---

## 💡 Advanced Engineering Highlights

### 🔹 Multi-Tab WebSocket Broadcasting

* Handles multiple tabs per user
* Prevents duplicate events using timestamp locks

### 🔹 Serverless Email Bypass

* Google Apps Script webhook
* Bypasses SMTP restrictions
* 100% reliable production delivery

---

## 💻 Tech Stack

| Category | Technologies                                 |
| -------- | -------------------------------------------- |
| Frontend | React 18, Vite, Tailwind CSS, Web Speech API |
| Backend  | Node.js, Express.js, Socket.IO, node-cron    |
| Database | MongoDB Atlas, Pinecone                      |
| AI/ML    | Mistral AI, Pixtral                          |
| Infra    | Google Apps Script                           |

---

## ⚙️ Local Setup

### Prerequisites

* Node.js (v18+)
* MongoDB Atlas
* Mistral API Key
* Pinecone API Key

---

### 1. Clone Repo

```bash
git clone https://github.com/Aashutosh31/arc-ai-project.git
cd arc-ai-project
```

### 2. Backend

```bash
cd server
npm install
```

Create `.env`:

```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secret
MISTRAL_API_KEY=your_key
PINECONE_API_KEY=your_key
EMAIL_WEBHOOK=your_webhook
FRONTEND_URL=http://localhost:5173
```

Run:

```bash
npm run dev
```

---

### 3. Frontend

```bash
cd ../client
npm install
npm run dev
```

---

## ⚠️ Attribution Required

This project is open-source under the MIT License.

You are free to use, modify, and distribute this code. However:

* You MUST provide proper credit to the original author
* You MUST include a link to this repository
* You MUST NOT claim this project as your own work

---

## 📝 License

This project is licensed under the MIT License.

---

## 👨‍💻 Author & Original Creator

**Aashutosh Bairagi**

* Built ARC-AI from scratch (architecture, backend, agent system, RAG pipeline, UI actuation)
* First published with live demo and deployment

🔗 GitHub: https://github.com/Aashutosh31
🔗 LinkedIn: https://www.linkedin.com/in/aashutosh-bairagi-559aa530b/
🐦 Twitter/X: https://x.com/Aashutosh_dev31

> If you are viewing this project elsewhere, verify the original source here.

---

⭐ If you found this project interesting, consider starring the repo!
