const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    default: 'New Conversation'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  lastMessage: {
    content: { type: String, default: '' },
    role: { type: String, enum: ['user', 'ai'], default: 'user' },
    timestamp: { type: Date, default: Date.now }
  },
  pinned: {
    type: Boolean,
    default: false
  },
  archived: {
    type: Boolean,
    default: false
  },
  messageCount: {
    type: Number,
    default: 0
  },
  metadata: {
    providerUsage: {
      gemini: { type: Number, default: 0 },
      mistral: { type: Number, default: 0 },
      other: { type: Number, default: 0 }
    },
    multimodal: {
      type: Boolean,
      default: false
    },
    toolsUsed: [String],
    memoryEnabled: {
      type: Boolean,
      default: true
    }
  }
});

// Auto-update timestamp on save
ConversationSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Conversation', ConversationSchema);
