// server/index.js (COMPLETE CODE - FINAL AUTH FIX)

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
const { executeTask } = require('./services/TaskExecutor'); 

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
        // Adjust origin based on your deployed web app and local client (if needed)
        origin: ["https://arc-ai-project.vercel.app", "http://localhost:19000", "http://10.0.2.2:19000"], 
        methods: ["GET", "POST"]
    }
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = socket.handshake.auth.userId;

    // --- CRITICAL FIX: MOBILE APP STATIC TOKEN BYPASS ---
    const MOCK_USER_ID = '68ed56d7602c9b4cea260704'; // King Aashutosh's registered ID

    if (token === `STATIC_MOBILE_TOKEN_FOR_${MOCK_USER_ID}` && userId === MOCK_USER_ID) {
        // If the static token matches the expected pattern, trust the mobile client.
        socket.userId = MOCK_USER_ID; 
        console.log('✅ Socket authenticated via STATIC MOBILE BYPASS.');
        return next();
    }
    // ----------------------------------------------------

    if (!token || !userId) {
        console.log('🚫 Socket rejected: Missing auth credentials.');
        return next(new Error('Authentication error: Missing token or userId'));
    }

    try {
        // Original JWT verification logic for web app
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id; 
        console.log(`✅ Socket authenticated for web user: ${socket.userId}`);
        next();
    } catch (err) {
        console.log('🚫 Socket rejected: Token verification failed (Invalid token).');
        return next(new Error('Authentication error: Invalid token'));
    }
});

// --- 4. Socket.IO Connection and AI Listener ---
io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);

    // Listener for the final transcribed command
    socket.on('ai:stt:final', async (data) => {
        const { command } = data; 
        const userId = socket.userId; 

        console.log(`🧠 Processing command from user ${userId}: "${command}"`);

        const aiResponse = await processCommand(command, userId);

        if (aiResponse) {
            let finalResponseText = aiResponse.text_response;

            if (aiResponse.intent === 'TASK_EXECUTION' || aiResponse.intent === 'DATA_QUERY') {
                const taskResult = await executeTask(aiResponse, userId);
                finalResponseText = `[Task Status: ${taskResult}] ${finalResponseText}`;
            }

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
