// server/models/AIMemory.js
const mongoose = require('mongoose');
const { MEMORY_LAYERS } = require('../lib/memoryLayers');

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
    // Phase 3 structured context. Defaults preserve every existing document:
    // old conversational memories read as episodic, new explicit writes can
    // pick a layer. Provenance stays first-class so a memory can be audited.
    layer: {
        type: String,
        enum: MEMORY_LAYERS,
        default: 'episodic'
    },
    importance: { type: Number, default: 0.5, min: 0, max: 1 },
    confidence: { type: Number, default: 0.7, min: 0, max: 1 },
    summary: { type: String, default: '' },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    projectKey: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now },
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

// Relevance-first candidate selection and layer-aware dashboards.
AIMemorySchema.index({ userId: 1, workspaceId: 1, layer: 1, timestamp: -1 });
AIMemorySchema.index({ userId: 1, workspaceId: 1, pinned: -1, timestamp: -1 });

module.exports = mongoose.model('AIMemory', AIMemorySchema);