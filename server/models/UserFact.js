const mongoose = require('mongoose');
const { MEMORY_LAYERS } = require('../lib/memoryLayers');

// This schema stores permanent facts about the user
const userFactSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
    fact: {
        type: String,
        required: true
    },
    // Optional: categorization for future complex queries (e.g., 'preferences', 'family')
    category: {
        type: String,
        default: 'general'
    },
    pinned: {
        type: Boolean,
        default: false
    },
    // Phase 3 structured context. Existing facts read as semantic, explicit
    // facts keep their provenance, and confidence/importance feed ranking.
    layer: {
        type: String,
        enum: MEMORY_LAYERS,
        default: 'semantic'
    },
    source: { type: String, default: 'explicit' },
    confidence: { type: Number, default: 0.9, min: 0, max: 1 },
    importance: { type: Number, default: 0.6, min: 0, max: 1 },
    projectKey: { type: String, default: null },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    updatedAt: { type: Date, default: Date.now },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

userFactSchema.index({ fact: 'text', category: 'text' }, {
    weights: {
        fact: 10,
        category: 1
    },
    name: 'user_fact_text_search'
});

userFactSchema.index({ userId: 1, workspaceId: 1, layer: 1, createdAt: -1 });
userFactSchema.index({ userId: 1, workspaceId: 1, pinned: -1, createdAt: -1 });

module.exports = mongoose.model('UserFact', userFactSchema);