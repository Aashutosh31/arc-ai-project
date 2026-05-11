const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true
  },
  role: {
    type: String,
    enum: ['user', 'ai'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  attachments: [
    {
      type: String,
      url: String,
      mimeType: String,
      size: Number
    }
  ],
  toolCalls: [
    {
      toolName: String,
      input: mongoose.Schema.Types.Mixed,
      output: mongoose.Schema.Types.Mixed,
      status: {
        type: String,
        enum: ['pending', 'success', 'failed'],
        default: 'pending'
      }
    }
  ],
  provider: {
    type: String,
    default: null
  },
  model: {
    type: String,
    default: null
  },
  metadata: {
    tokens: {
      input: { type: Number, default: 0 },
      output: { type: Number, default: 0 }
    },
    streaming: {
      type: Boolean,
      default: false
    },
    interrupted: {
      type: Boolean,
      default: false
    }
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for conversation querying
MessageSchema.index({ conversationId: 1, createdAt: 1 });

// Auto-update timestamp on save
MessageSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Message', MessageSchema);
