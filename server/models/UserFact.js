const mongoose = require('mongoose');

// This schema stores permanent facts about the user
const userFactSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    fact: {
        type: String,
        required: true
    },
    // Optional: categorization for future complex queries (e.g., 'preferences', 'family')
    category: {
        type: String,
        default: 'general'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('UserFact', userFactSchema);