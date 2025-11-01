🤖 ARC-AI: The Real-Time Voice Assistant (MERN Stack)

Developed by:  Aashutosh

ARC-AI is a high-performance, portfolio-grade web application built using the MERN stack. It simulates a futuristic, intelligent voice assistant (like Iron Man's Jarvis), showcasing expertise in real-time communication, custom AI orchestration, and modern full-stack architecture.

🚀 Live Demo and Status

Component

Status

URL

Frontend (React)

Deployed Frontend 

[https://arc-ai-project.vercel.app/]

Backend (Node/Express)

Deployed Backend

https://arc-ai-project.onrender.com

AI Model

Functional

Mistral AI (Free Tier)

Database

Functional

MongoDB Atlas (Free Tier)


✨ Key Features

Real-Time Voice I/O: Uses the native Web Speech API for instant Speech-to-Text (STT) transcription and Text-to-Speech (TTS) voice output.

Zero-Latency Communication: Leverages Socket.IO to ensure immediate, bi-directional, and low-latency message delivery between the React client and the Node.js server.

Custom AI Orchestration: The Node/Express server acts as a middleware layer, processing user commands, fetching contextual memory, and communicating with the external LLM to retrieve a structured JSON intent.

Contextual Memory: Integrates MongoDB Atlas to store user-specific conversation history and preferences, enabling context-aware follow-up responses.

Persona Lock: Overrides the LLM's base knowledge to assert the developer's identity. (Ask: "Who created you?")

Action Execution Simulation: Includes a robust system to process tasks (schedule_reminder, get_weather) by mocking external API calls in a dedicated service layer (TaskExecutor.js).

🧠 Architecture Overview

ARC-AI follows a decoupled MERN architecture augmented by a service layer for external intelligence.

Frontend (React): Handles UI, Authentication flow, and the Voice I/O pipeline. Uses React Context for global state management (Auth, Socket, Chat History).

Backend (Node/Express): Manages user sessions (JWT), routes API calls, and hosts the Socket.IO server. Its main function is to funnel user commands to the AI Service and execute the resulting actions.

AI Service (AIService.js): The core intelligence module. It crafts a custom system prompt (including persona lock and history), sends the request via Axios to the Mistral API, and parses the structured JSON output.

Database (MongoDB Atlas): Persists user data, memory history (AIMemory), and pending tasks (Task).

⚙️ Technology Stack

Area

Technology

Reason for Selection

Frontend

React, Styled Components, React Router

Modern UI/UX and efficient SPA routing.

Backend

Node.js, Express, Socket.IO, JWT

Non-blocking, event-driven I/O essential for real-time performance.

Database

MongoDB Atlas, Mongoose

Flexible NoSQL schema ideal for storing unstructured chat history and contextual memory.

AI/NLP

Mistral AI (via Axios)

Chosen for its performance, structured JSON output capability, and availability of a generous free tier, ensuring the project is cost-effective.

Hosting

Vercel (Frontend), Render (Backend/Socket.IO)

Vercel provides excellent hosting for SPAs (with vercel.json routing fix). Render supports persistent connections needed for Socket.IO.

🛠️ Setup and Installation

This project uses a monorepo structure with independent client and server folders.

Prerequisites

Node.js (v18+)

MongoDB Atlas Account

Mistral AI Account (or other LLM service with an API key)

1. Backend Setup (/server)

Navigate to the server directory and install dependencies:

npm install


Create a .env file in the server root and populate it with your credentials:

MONGO_URI=your_mongodb_atlas_connection_string
JWT_SECRET=YOUR_SECURE_SECRET_KEY
MISTRAL_API_KEY=YOUR_MISTRAL_API_KEY
MISTRAL_MODEL=mistral-tiny 
PORT=5000


Run the server:

npm run dev


2. Frontend Setup (/client)

Navigate to the client directory and install dependencies:

npm install


Create a .env file in the client root (using your deployed backend URL):

Run the client locally:

npm run dev


⚠️ Challenges and Solutions (Portfolio Focus)

Silent Network Hang (Challenge): Node.js failed to connect to external HTTPS APIs locally due to firewall/SSL interception, causing silent timeouts.

Solution: Solved by deploying the Node.js backend to an unrestricted cloud environment (Render), proving the application logic was sound, while the local environment was the bottleneck.

SPA Routing on Deployment (Challenge): Refreshing the browser on deep links (e.g., /dashboard) resulted in a 404 error.

Solution: Implemented the vercel.json file with a universal rewrite rule ("source": "/(.*)", "destination": "/index.html") to redirect all non-file paths to the React entry point.

Token Management (Challenge): Managing secure, persistent authentication across the REST API, the Socket.IO connection, and the Mongoose middleware.

Solution: Used JWT for REST authorization and implemented a custom io.use middleware check to protect the WebSocket channel.

Created with dedication by Aashutosh.
