const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
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
  // Pending multi-turn tool-call state (argument collection). Set only by
  // the deterministic pending-args flow: { toolName, args, missing, rounds,
  // updatedAt }. Lets fragmentary follow-ups ("success", then "true") merge
  // into the SAME tool call instead of restarting selection each turn.
  // Never holds credentials — just the tool name and user-supplied values.
  pendingToolCall: {
    type: Object,
    default: null
  },
  // Bounded working/agent state: compact structured references for the live
  // task ({ activeMedia, activeSearch, activeResource, activeTask,
  // pendingTool }). Titles/ids/queries and bounded result refs only — never
  // giant tool outputs verbatim. Rebuilt each turn from recent tool activity
  // so follow-ups ("it", "that", "the second one") resolve naturally.
  // Failure-silent: absence degrades to history-only context, never an error.
  workingState: {
    type: Object,
    default: null
  },
  // Bounded rolling summary of older turns that fell outside the recent
  // provider window. Background only — never a substitute for recent turns.
  conversationSummary: {
    type: String,
    default: ''
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
      groq: { type: Number, default: 0 },
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

ConversationSchema.index({ title: 'text', 'lastMessage.content': 'text' }, {
  weights: {
    title: 8,
    'lastMessage.content': 2
  },
  name: 'conversation_text_search'
});

// Auto-update timestamp on save
ConversationSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Conversation', ConversationSchema);
