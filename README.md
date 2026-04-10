<img width="1904" height="1015" alt="image" src="https://github.com/user-attachments/assets/ffa1f39d-89a1-4b3e-a8f8-740f98a300c1" />


🚀 Overview

ARC-AI (Autonomous Real-time Conversational AI) is a full-stack, voice-activated digital assistant. It transitions the standard "reactive" chatbot paradigm into a proactive, autonomous agent.

Instead of just answering questions, ARC-AI can fetch live data from the internet, schedule its own background tasks, dynamically control the user's frontend UI, permanently memorize facts using a Vector Database, and communicate with the outside world via custom serverless webhooks.

🎥 Main Showcase Demo : https://www.youtube.com/watch?v=jt7q8v5KsrU

🧠 Architectural Deep Dive

ARC-AI operates via a highly optimized, low-latency pipeline combining REST APIs for authentication and persistent WebSocket connections for real-time AI streaming.

The Request Lifecycle

Input: The user issues a command via Voice (Web Speech API) or Text (with optional Image/PDF attachments).

WebSocket Emission: The React frontend (useSocket.js) emits an ai:stt:final payload to the Express backend.

Agent Routing (AIService.js): The core AI engine collects context (current time, recent chat history from MongoDB, permanent user facts).

Tool Evaluation: The query is routed to Mistral AI along with a dynamic registry of system tools.

Execution (TaskExecutor.js): If the AI decides a tool is needed (e.g., searching the web or checking the database), the Node.js backend executes the JavaScript function autonomously.

Token Streaming: The final output is streamed back to the client token-by-token via Sockets (ai:tts:response:chunk), allowing the frontend UI to type it out and the TTS engine to speak sentences progressively before the full response is even finished.

UI Actuation: The backend can emit ai:client:action payloads, physically controlling the React frontend to open tabs, change CSS themes, play media, or copy data to the clipboard.

🛠️ The Tool Registry & Demos

ARC-AI is equipped with an extensive, dynamic tool registry. The LLM intelligently decides when and how to use these tools based on the user's intent.

1. The Infinite Brain (RAG & Vector Embeddings)

ARC-AI features a multi-tiered memory system. Alongside short-term MongoDB conversational memory, it uses Retrieval-Augmented Generation (RAG) for limitless long-term recall.

memorize: Converts raw text into 1,024-dimensional semantic vectors using mistral-embed and upserts them to a Pinecone Serverless Database, tagged with strict userId filters for absolute privacy.

recallMemory: Performs semantic cosine-similarity searches to instantly retrieve historical facts from the database and inject them into the AI's current context window.

🎥 Watch Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DW83J1HESyQ/

2. Live Web Researcher

ARC-AI is not limited by pre-trained cut-off dates. It physically navigates the live internet.

scrapeWebsite: Uses cheerio to fetch live URLs, strip away HTML/CSS/JS bloat, and feed pure, token-optimized text into the AI's context window for summarization and analysis.

webSearch / getTopNews / getWeather: Interacts with REST APIs to pull real-time global data.

🎥 Watch Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DW31J3bEbu9/

3. Proactive Routine Engine

ARC-AI manages time and schedules background tasks autonomously using node-cron.

setReminder: Converts natural language into valid cron expressions and schedules background jobs in the Node server's global memory map.

stopReminder: A "Kill Switch" that iterates through the global.userCronJobs map to safely destroy active routines.

🎥 Watch Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DW7DQ8lE-Wr/

4. External Communication

sendEmail: Autonomously drafts formatted HTML emails and dispatches them to external recipients via a secure Serverless Webhook.

🎥 Watch Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DW7DQ8lE-Wr/

5. UI Actuation & OS Control

changeTheme / playMedia / copyToClipboard / openWebsite: Tools that bypass standard text generation to physically actuate the React DOM.

🎥 Watch Demo: https://www.instagram.com/aashutosh_vaishnav.31/reel/DWzcz9YE797/

💡 Advanced Engineering Highlights

1. Multi-Tab WebSocket Broadcasting & React Deduplication

The Problem: Traditional WebSockets track one connection per user. If a background Cron job triggers a reminder while a user has 4 tabs open (or refreshes React), the payload drops or hits a "ghost tab".
The Solution: * Overhauled the backend socket.io architecture to map users to a Set() of active connections (global.connectedSockets.set(userId, new Set())).

When a background task fires, it iterates through the Set and blasts the payload to all active browser tabs simultaneously.

Engineered a global timestamp lock in the React useSocket hook to debounce simultaneous incoming socket events, guaranteeing the UI only renders the notification once, preventing duplicate speech and rendering errors.

2. Google Cloud Serverless Webhook Bypass

The Problem: Modern cloud providers (like Render Free Tier) enforce strict outbound firewalls on standard SMTP ports (465/587) to prevent spam, and third-party APIs (Resend) sandbox domains, breaking standard Node.js email functionality in production.
The Solution: * Engineered a custom Serverless Microservice using Google Cloud Apps Script.

Re-routed the Node.js sendEmail tool to use native fetch, tunneling the payload via standard HTTP POST (Port 443) directly to Google's infrastructure.

This entirely bypasses the hosting provider's firewall and the API sandbox restrictions, resulting in a 100% reliable, zero-cost production email pipeline.

💻 Tech Stack

Category

Technologies

Frontend

React 18, Vite, Tailwind CSS, Web Speech API (STT/TTS)

Backend

Node.js, Express.js, Socket.IO, node-cron, Cheerio

Database

MongoDB Atlas (Mongoose), Pinecone (Vector DB)

AI / ML

Mistral AI (LLM & Embeddings), Pixtral (Vision)

Infrastructure

Google Cloud Apps Script (Serverless Webhooks)

⚙️ Local Setup & Installation

Want to run ARC-AI on your own machine? Follow these steps.

Prerequisites

Node.js (v18+ recommended)

MongoDB Atlas Cluster URI

Mistral AI API Key

Pinecone API Key (1024 Dimensions, Cosine Metric)

1. Clone the Repository

git clone https://github.com/Aashutosh31/arc-ai-project.git
cd arc-ai-project


2. Backend Setup

cd server
npm install


Create a .env file in the server directory (DO NOT COMMIT THIS FILE):

PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_super_secret_jwt_key
MISTRAL_API_KEY=your_mistral_api_key
PINECONE_API_KEY=your_pinecone_api_key
EMAIL_WEBHOOK=your_google_apps_url
FRONTEND_URL=http://localhost:5173


Start the server:

npm run dev


3. Frontend Setup

cd ../client
npm install


Create a .env file in the client directory:

VITE_API_URL=http://localhost:5000
VITE_SOCKET_URL=http://localhost:5000


Start the Vite development server:

npm run dev


Security Warning: Never commit your .env files to GitHub. Ensure .env is included in both your client/.gitignore and server/.gitignore files. If you fork this project, regenerate any keys that may have been accidentally exposed.

## 👨‍💻 Author & Original Creator

**Aashutosh Bairagi**

* Built ARC-AI from scratch (architecture, backend, agent system, RAG pipeline, and UI actuation)
* First published with live demo and deployment

🔗 GitHub: https://github.com/Aashutosh31
🔗 LinkedIn: https://www.linkedin.com/in/aashutosh-bairagi-559aa530b/
🐦 Twitter/X: https://x.com/Aashutosh_dev31

> If you are viewing a copy of this project elsewhere, please verify the original source here.
If you found this project interesting, please consider dropping a ⭐ on the repository!
