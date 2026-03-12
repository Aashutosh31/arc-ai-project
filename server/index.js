// server/index.js (COMPLETE CODE - FINAL AUTH FIX)

// Core Dependencies
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const {marked} = require('marked');
const emojiRegex = require('emoji-regex');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Import services and middleware
const { protect } = require('./middleware/authMiddleware.js'); // For REST routes
const authRoutes = require('./routes/auth.js');
const { processCommand } = require('./services/AIService.js'); // AI Core
const { executeTask } = require('./services/TaskExecutor.js'); 

const app = express();
const server = http.createServer(app); 
const PORT = process.env.PORT || 5000;
const frontendOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

// Enhanced function to prepare text for speech synthesis, removing emojis and normalizing spacing
function prepareTextForSpeech(markdown) {
  // Convert markdown → plain text
  const html = marked.parse(markdown);
  let text = html.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities like &#39; 
  text = text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  // Remove emojis completely
  text = text.replace(emojiRegex(), '');

  // Normalize spacing
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

// --- 1. Middleware Setup ---
app.use(cors({
    origin: frontendOrigins.length ? frontendOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true
}));
app.use(express.json()); 

// --- 2. Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas connected successfully.'))
    .catch(err => console.error('🔴 MongoDB connection error:', err));

// --- 3. Socket.IO Setup with Auth Middleware ---
const io = new Server(server, {
    cors: {
        origin: frontendOrigins.length ? frontendOrigins : false,
        methods: ["GET", "POST"],
        credentials: true
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
            const rawText = aiResponse.text_response;        // for UI
            const speechText = prepareTextForSpeech(rawText); // for TTS

            if (aiResponse.intent === 'TASK_EXECUTION' || aiResponse.intent === 'DATA_QUERY') {
                const taskResult = await executeTask(aiResponse, userId);
                finalResponseText = `[Task Status: ${taskResult}] ${finalResponseText}`;
            }

            socket.emit('ai:tts:response:chunk', {
                chunk: speechText,
                displayText: rawText,
                isFinal: true, 
                intent: aiResponse.intent
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
