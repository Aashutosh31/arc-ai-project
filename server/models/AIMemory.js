// server/models/AIMemory.js
const mongoose = require('mongoose');

const AIMemorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
    query: {
        type: String,
        required: true
    },
    response: {
        type: String,
        required: true
    },
    tags: {
        type: [String],
        default: []
    },
    pinned: {
        type: Boolean,
        default: false
    },
    source: {
        type: String,
        default: 'conversation'
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

AIMemorySchema.index({ query: 'text', response: 'text', tags: 'text' }, {
    weights: {
        query: 8,
        response: 4,
        tags: 2
    },
    name: 'ai_memory_text_search'
});

module.exports = mongoose.model('AIMemory', AIMemorySchema);