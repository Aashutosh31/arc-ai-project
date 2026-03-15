// server/index.js

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Import services and middleware
const authRoutes = require('./routes/auth.js');
const AIService = require('./services/AIService.js'); // 🚀 Using our new Agent Router!

const app = express();
const server = http.createServer(app); 
const PORT = process.env.PORT || 5000;

// Dynamic CORS configuration based on your original setup
const frontendOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin: frontendOrigins.length > 0 ? frontendOrigins : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 MongoDB Atlas connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));

// Socket.IO Setup
const io = new Server(server, {
    cors: {
        origin: frontendOrigins.length > 0 ? frontendOrigins : '*',
        methods: ['GET', 'POST']
    }
});

// Socket Authentication Middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id;
        console.log(`✅ Socket authenticated for web user: ${socket.userId}`);
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

// Socket Connection Handling
io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);

    // Listener for the transcribed command
    socket.on('ai:stt:final', async (data) => {
        const { command } = data; 
        const userId = socket.userId; 

        console.log(`🧠 Processing command from user ${userId}: "${command}"`);

        // 🚀 THE MAGIC: We pass the socket directly to the Agent Router!
        // The router will handle tools, memory, and stream chunks right back to the client.
        await AIService.processQuery(userId, command, socket);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// REST Routes
app.get('/', (req, res) => {
    res.status(200).send('ARC-AI Server Running. Status: Operational.');
});
app.use('/api/auth', authRoutes);

// Start Server
server.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});