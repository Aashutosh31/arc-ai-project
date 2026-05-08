require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth.js');
const googleAuthRoutes = require('./routes/googleAuth.js');
const AIService = require('./services/AIService.js'); 

const app = express();
const server = http.createServer(app); 
const PORT = process.env.PORT || 5000;

global.connectedSockets = new Map(); // 🚀 NOW HOLDS SETS OF SOCKETS
global.userCronJobs = new Map(); 

const frontendOrigins = (process.env.FRONTEND_URL || '').split(',').map(origin => origin.trim()).filter(Boolean);

app.use(cors({
    origin: frontendOrigins.length > 0 ? frontendOrigins : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log('🟢 MongoDB Atlas connected successfully.');
        try {
            await mongoose.connection.collection('aimemories').dropIndex('userId_1');
        } catch (err) { }
    })
    .catch(err => console.error('MongoDB connection error:', err));

const io = new Server(server, {
    cors: { origin: frontendOrigins.length > 0 ? frontendOrigins : '*', methods: ['GET', 'POST'] }
});

// Initialize WhatsApp provider sockets (if present)
try {
    const whatsappProvider = require('./providers/whatsapp');
    if (whatsappProvider && typeof whatsappProvider.init === 'function') {
        whatsappProvider.init(io);
        console.log('[WhatsApp] provider initialized');
    }
} catch (err) {
    console.log('[WhatsApp] provider not available or failed to init:', err?.message || err);
}

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const rawId = decoded.id || decoded.userId || decoded._id;
        socket.userId = String(rawId); 
        socket.authType = decoded.role || 'user';
        console.log(`✅ Socket authenticated for web user: ${socket.userId}`);
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);
    
    // 🚀 THE FIX: Add the socket to a Set to support multiple tabs/reloads!
    if (!global.connectedSockets.has(socket.userId)) {
        global.connectedSockets.set(socket.userId, new Set());
    }
    global.connectedSockets.get(socket.userId).add(socket);

    socket.on('ai:stream:stop', () => {
        socket.isInterrupted = true; 
        AIService.abortForSocket(socket.id);
    });

    socket.on('ai:stt:final', async (data) => {
        const { command, image, document } = data; 
        const userId = socket.userId; 
        socket.isInterrupted = false; 

        // Preempt any prior in-flight generation for this socket.
        AIService.abortForSocket(socket.id);

        console.log(`🧠 Processing command from user ${userId}: "${command}"`);
        await AIService.processQuery(userId, command, socket, image, document);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        AIService.abortForSocket(socket.id);
        // 🚀 THE FIX: Safely remove ONLY this specific socket, keeping active tabs alive
        const userSockets = global.connectedSockets.get(socket.userId);
        if (userSockets) {
            userSockets.delete(socket);
            if (userSockets.size === 0) {
                global.connectedSockets.delete(socket.userId);
            }
        }
    });
});

app.get('/', (req, res) => res.status(200).send('ARC-AI Server Running. Status: Operational.'));
app.use('/api/auth', authRoutes);
app.use('/api/google', googleAuthRoutes);

server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));