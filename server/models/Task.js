// server/models/Task.js
const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    actionType: {
        type: String,
        enum: ['REMINDER', 'SEND_EMAIL', 'OPEN_LINK', 'MOCK_ACTION'],
        required: true
    },
    title: {
        type: String,
        required: true
    },
    details: {
        type: String // Additional details like email body or link URL
    },
    scheduledTime: {
        type: Date,
        required: true
    },
    isCompleted: {
        type: Boolean,
        default: false
    },
    completedAt: {
        type: Date
    }
});

module.exports = mongoose.model('Task', TaskSchema);