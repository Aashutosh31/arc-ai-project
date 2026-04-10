🤖 ARC-AI: Real-Time Voice-Activated AI Agent

ARC-AI is an advanced, real-time, hybrid (Voice + Text) AI assistant built on the MERN stack. More than just a chatbot, ARC-AI is an autonomous Agent equipped with a dynamic Tool Registry, long-term memory, and the ability to execute physical UI actions on the client's machine.

✨ Core Features

🎙️ Hybrid Interaction (Voice & Text)

Seamlessly switch between clicking the glowing microphone to speak naturally using the Web Speech API, or typing silently using the sleek terminal-style chat interface.

⚡ Real-Time Streaming & Audio Sync

ARC-AI does not wait for the entire response to generate. It pipes tokens directly from the Mistral API through WebSockets to the frontend. A custom Sentence Buffer collects these tokens and feeds them to the browser's Text-to-Speech (TTS) engine, allowing ARC-AI to start speaking instantly while it continues to "think."

🛑 "Jarvis-Style" Interruption

Don't want to listen to a 5-paragraph response? Simply click "Stop Speaking" or press the Spacebar. This triggers a full-stack interruption protocol:

Silences the browser's TTS engine instantly.

Halts the frontend UI typing animation.

Sends a Socket kill-signal to the Node.js backend to break the LLM generation loop, saving API tokens.

🧠 Agentic Tool Registry

ARC-AI is aware of its limitations and uses Mistral Function Calling to route queries to backend plugins. Out of the box, it includes:

Live News Fetcher: Grabs real-time BBC top headlines via RSS.

Web Search: Queries the Wikipedia API for factual, real-world data.

Time Awareness: Injects real-time system clocks into the AI's context window.

💻 Client Action Pattern (System Control)

ARC-AI can physically control aspects of the user's UI. By utilizing a secure "Client Action" Socket bridge, the Node.js backend can command the React frontend to perform tasks like window.open(). Tell ARC-AI to "Open YouTube", and watch a new tab magically appear.

💾 Persistent Long-Term & Short-Term Memory

Powered by MongoDB, ARC-AI remembers the last 5 conversational turns (Short-term) and maintains a separate collection for permanent user facts (Long-term), allowing for highly personalized interactions.

🏗️ Architecture Deep Dive

The application is split into a React Frontend and a Node/Express Backend, connected via standard HTTP REST (for Auth) and Socket.IO (for real-time Agentic execution).

The Agent Router (AIService.js)

When a user submits a prompt, the Agent Router:

Compiles context (Date, Short-term memory, Long-term facts).

Sends the prompt and available schemas to Mistral.

If Mistral requests a tool (e.g., webSearch), the Router pauses, executes the local Node.js tool, and feeds the data back to the LLM.

Streams the final synthesized response back to the client word-by-word.

Clean TTS Engine (useTextToSpeech.js)

LLMs generate Markdown (e.g., **bold**, ### Headers) and Emojis (😊). If fed directly to a TTS engine, it sounds robotic (e.g., "Asterisk asterisk bold asterisk asterisk smiling face").
Our custom hook uses advanced Regex to strip Markdown, convert URLs to the phrase "a link", and remove emojis right before speech synthesis, ensuring the UI remains visually rich while the audio remains human-natural.

🚀 Installation & Setup

Prerequisites

Node.js (v16+)

MongoDB Atlas Cluster (or local instance)

Mistral AI API Key

Backend Setup

Navigate to the server directory.

Run npm install.

Create a .env file:

PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_super_secret_jwt_key
MISTRAL_API_KEY=your_mistral_key
MISTRAL_MODEL=mistral-tiny
FRONTEND_URL=http://localhost:5173


Start the server: npm run dev

Frontend Setup

Navigate to the client directory.

Run npm install.

Create a .env file:

VITE_API_URL=http://localhost:5000


Start the Vite dev server: npm run dev

🛠️ How to Build a Plugin

ARC-AI is designed to be infinitely extensible. To give ARC-AI a new superpower, you don't need to touch the core routing logic. Just create a new file in server/tools/.

Example: server/tools/openWebsite.js

module.exports = {
    // 1. Define the Schema for the LLM
    schema: {
        type: "function",
        function: {
            name: "openWebsite",
            description: "Open a specific website in the user's browser.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string" },
                    siteName: { type: "string" }
                },
                required: ["url", "siteName"]
            }
        }
    },
    
    // 2. Define the Execution Logic
    execute: async (args, context) => {
        return {
            success: true,
            message: `Opening ${args.siteName}.`,
            // Optional: Trigger a physical UI action on the frontend!
            clientAction: {
                type: 'OPEN_URL',
                url: args.url
            }
        };
    }
};


The tools/index.js file automatically scans the directory, registers the schema with Mistral, and handles the execution dynamically.

🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the issues page.

📝 License

This project is open-source and available under the MIT License.