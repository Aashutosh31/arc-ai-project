// server/models/User.js
const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
        minlength: 6
    },
    authProvider: {
        type: String,
        enum: ['local', 'google'],
        default: 'local'
    },
    creditsRemaining: {
        type: Number,
        default: 1000,
        min: 0
    },
    lastLoginAt: {
        type: Date,
        default: null
    },
    googleIdentity: {
        googleId: { type: String, default: '' },
        email: { type: String, default: '' },
        verifiedEmail: { type: Boolean, default: false },
        picture: { type: String, default: '' },
        linkedAt: { type: Date, default: null }
    },
    // AI Preferences (for personality/voice customization)
    preferences: {
        voice: { type: String, default: 'professional' },
        accentColor: { type: String, default: '#00FFFF' }, // Neon Cyan
        memoryLearningEnabled: { type: Boolean, default: true }
    },
    googleCalendar: {
        connected: { type: Boolean, default: false },
        encryptedTokenData: { type: String, default: '' },
        connectedAt: { type: Date, default: null },
        updatedAt: { type: Date, default: null }
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('User', UserSchema);