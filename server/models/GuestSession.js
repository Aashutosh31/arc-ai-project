const mongoose = require('mongoose');

const GuestSessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    displayName: {
        type: String,
        default: 'Guest'
    },
    creditsRemaining: {
        type: Number,
        default: 12,
        min: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActiveAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
        expires: 0
    }
});

module.exports = mongoose.model('GuestSession', GuestSessionSchema);