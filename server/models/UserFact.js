const mongoose = require('mongoose');

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

module.exports = mongoose.model('UserFact', userFactSchema);