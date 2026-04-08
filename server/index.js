require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth.js');
const AIService = require('./services/AIService.js'); 

const app = express();
const server = http.createServer(app); 
const PORT = process.env.PORT || 5000;

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

io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);

    socket.on('ai:stream:stop', () => {
        console.log(`🛑 User ${socket.userId} interrupted the stream.`);
        socket.isInterrupted = true; 
    });

    socket.on('ai:stt:final', async (data) => {
        // 🚀 UPGRADE: Extract 'document' from the incoming payload!
        const { command, image, document } = data; 
        const userId = socket.userId; 
        
        socket.isInterrupted = false; 

        console.log(`🧠 Processing command from user ${userId}: "${command}" ${image ? '[+Image]' : ''} ${document ? '[+Document]' : ''}`);
        
        // 🚀 UPGRADE: Pass the document to the Agent Router
        await AIService.processQuery(userId, command, socket, image, document);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

app.get('/', (req, res) => res.status(200).send('ARC-AI Server Running. Status: Operational.'));
app.use('/api/auth', authRoutes);

server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));