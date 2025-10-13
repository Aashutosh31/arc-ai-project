// server/index.js

// Core Dependencies
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); // Required for Socket.IO
const { Server } = require('socket.io'); // Socket.IO server class
const cors = require('cors');

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

// Simple Socket.IO Connection Test
io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id}`);

    // Placeholder for real-time AI logic (Phase 3)
    // socket.on('ai:stt:final', ...); 

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// --- 5. Start Server ---
server.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});