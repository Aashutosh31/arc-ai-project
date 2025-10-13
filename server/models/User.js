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
    // AI Preferences (for personality/voice customization)
    preferences: {
        voice: { type: String, default: 'professional' },
        accentColor: { type: String, default: '#00FFFF' } // Neon Cyan
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('User', UserSchema);