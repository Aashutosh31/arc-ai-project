// server/index.js (COMPLETE CODE - Focus on Socket.IO)

// Core Dependencies
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Import services and middleware
const { protect } = require('./middleware/authMiddleware'); // For REST routes
const authRoutes = require('./routes/auth');
const { processCommand } = require('./services/AIService'); // AI Core
const { executeTask } = require('./services/TaskExecutor'); // Placeholder for Phase 5.1

const app = express();
const server = http.createServer(app); 
const PORT = process.env.PORT || 5000;

// --- 1. Middleware Setup ---
app.use(cors());
app.use(express.json()); 

// --- 2. Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas connected successfully.'))
    .catch(err => console.error('🔴 MongoDB connection error:', err));

// --- 3. Socket.IO Setup with Auth Middleware ---
const io = new Server(server, {
    cors: {
        origin: "http://localhost:5000", // Adjust port if needed
        methods: ["GET", "POST"]
    }
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.auth.userId;

    if (!token || !userId) {
        console.log('🚫 Socket rejected: Missing auth credentials.');
        return next(new Error('Authentication error: Missing token or userId'));
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id; 
        console.log(`✅ Socket authenticated for user: ${socket.userId}`);
        next();
    } catch (err) {
        console.log('🚫 Socket rejected: Token verification failed.');
        return next(new Error('Authentication error: Invalid token'));
    }
});

// --- 4. Socket.IO Connection and AI Listener ---
io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);

    // Listener for the final transcribed command
    socket.on('ai:stt:final', async (data) => {
        const { command } = data; 
        const userId = socket.userId; // Get user ID from authenticated socket

        console.log(`🧠 Processing command from user ${userId}: "${command}"`);

        // 1. Get structured intent from the AI model
        const aiResponse = await processCommand(command, userId);

        if (aiResponse) {
            let finalResponseText = aiResponse.text_response;

            // 2. Trigger Task Execution if needed (Phase 5.1)
            if (aiResponse.intent === 'TASK_EXECUTION') {
                const taskResult = await executeTask(aiResponse, userId);
                // Prepend task status to the user's response
                finalResponseText = `[Task Status: ${taskResult}] ${finalResponseText}`;
            }

            // 3. Send the final response back to the client
            socket.emit('ai:tts:response:chunk', {
                chunk: finalResponseText,
                isFinal: true, 
                intent: aiResponse
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// --- 5. Define and Use REST Routes ---
app.get('/', (req, res) => {
    res.status(200).send('ARC-AI Server Running. Status: Operational.');
});
app.use('/api/auth', authRoutes);


// --- 6. Start Server ---
server.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});