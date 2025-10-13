// server/models/AIMemory.js
const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

const AIMemorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true // Each user has one memory document
    },
    // Short-term/Recent conversation history
    conversationHistory: [ConversationSchema],
    // Long-term/Key facts the AI should remember about the user
    keyFacts: {
        type: Map,
        of: String,
        default: {}
    }
});

module.exports = mongoose.model('AIMemory', AIMemorySchema);