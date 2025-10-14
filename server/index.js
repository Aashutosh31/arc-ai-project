// server/index.js
// server/index.js (Inside io.on('connection'))
const { processCommand } = require('./services/AIService'); // Import service
// Core Dependencies
require('dotenv').config();
// --- FINAL DOTENV CHECK ---
if (!process.env.GOOGLE_API_KEY) {
    console.error('🔴 CRITICAL: GOOGLE_API_KEY is NOT loaded by dotenv. Check .env file path/name.');
} else {
    console.log('✅ GOOGLE_API_KEY successfully loaded from .env.');
}
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); // Required for Socket.IO
const { Server } = require('socket.io'); // Socket.IO server class
const cors = require('cors');
const jwt = require('jsonwebtoken')
const app = express();
const server = http.createServer(app); // Create HTTP server instance
const PORT = process.env.PORT || 5000;

// --- 1. Middleware Setup ---
app.use(cors());
app.use(express.json()); // Body parser for JSON requests

// Import the routes after middleware
const authRoutes = require('./routes/auth');
// Simple REST Test Route (Keep for sanity check)
app.get('/', (req, res) => {
    res.status(200).send('ARC-AI Server Running. Status: Operational.');
});

// Use the authentication routes
app.use('/api/auth', authRoutes);

// --- 2. Database Connection (MongoDB) ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas connected successfully.'))
    .catch(err => console.error('🔴 MongoDB connection error:', err));

// --- 3. Socket.IO Setup ---
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000", // Update this to your React app URL
        methods: ["GET", "POST"]
    }
});

// --- CRITICAL: Socket.IO Authentication Middleware ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.auth.userId;

    if (!token || !userId) {
        console.log('🚫 Socket rejected: Missing auth credentials.');
        return next(new Error('Authentication error: Missing token or userId'));
    }

    try {
        // Verify the token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Attach user data to the socket object for later use
        socket.userId = decoded.id; 
        console.log(`✅ Socket authenticated for user: ${socket.userId}`);
        next();
    } catch (err) {
        console.log('🚫 Socket rejected: Token verification failed.');
        return next(new Error('Authentication error: Invalid token'));
    }
});

// Simple Socket.IO Connection Test
io.on('connection', (socket) => {
      console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);
    // Placeholder for real-time AI logic (Phase 3)
    // socket.on('ai:stt:final', ...); 

  // --- Core AI Command Listener ---
    socket.on('ai:stt:final', async (data) => {
        const { command } = data; // userId is now on socket.userId

        // 1. Get AI response (structured intent and text)
        const aiResponse = await processCommand(command, socket.userId);

        // 2. If it's a conversation or action, send the response text back
        if (aiResponse) {
            const responseText = aiResponse.text_response;

            // 3. Save AI's response to history (before streaming)
            // NOTE: This will require a function in the AI controller/service to save the AI's response text.

            // 4. --- Real-Time Streaming back to client (ai:tts:response:chunk) ---
            // For simplicity, we'll send it as one chunk for now (streaming needs custom implementation)
            // For true streaming: you'd use the Gemini streaming API and pipe chunks here.
            socket.emit('ai:tts:response:chunk', {
                chunk: responseText,
                isFinal: true, // Send as final chunk
                intent: aiResponse
            });

            // 5. Trigger Task Execution (if intent is TASK_EXECUTION)
            if (aiResponse.intent === 'TASK_EXECUTION') {
                // Placeholder: In Phase 5, we'll implement this TaskExecutor
                console.log(`⏰ Task Execution Required: ${aiResponse.action}`);
                // TaskExecutor.execute(aiResponse); 
            }
        }
    });
});

// --- 5. Start Server ---
server.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});