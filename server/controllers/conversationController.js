const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const LLMRouter = require('../lib/llm/LLMRouter');

const toFallbackTitle = (rawText) => {
  const cleaned = String(rawText || '')
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/["'`]/g, '')
    .trim();

  if (!cleaned) return 'New Conversation';

  const words = cleaned
    .split(' ')
    .map((word) => word.replace(/[^a-zA-Z0-9:-]/g, ''))
    .filter(Boolean)
    .slice(0, 6);

  if (words.length === 0) return 'New Conversation';

  const titled = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return titled.join(' ').slice(0, 80);
};

// Get all conversations for a user
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const query = { userId, archived: false };
    if (workspaceId) query.workspaceId = workspaceId;

    const conversations = await Conversation.find(query)
      .sort({ updatedAt: -1 })
      .select('_id title createdAt updatedAt lastMessage pinned messageCount')
      .lean();

    res.json(conversations);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

// Create a new conversation
exports.createConversation = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title = 'New Conversation' } = req.body;

    const conversation = new Conversation({
      userId,
      workspaceId,
      title
    });

    await conversation.save();
    res.status(201).json(conversation);
  } catch (err) {
    console.error('Error creating conversation:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
};

// Get a specific conversation with all messages
exports.getConversation = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const { conversationId } = req.params;
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const convQuery = { _id: conversationId, userId };
    if (workspaceId) convQuery.workspaceId = workspaceId;

    const conversation = await Conversation.findOne(convQuery);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const msgQuery = { conversationId };
    if (workspaceId) msgQuery.workspaceId = workspaceId;

    const messages = await Message.find(msgQuery)
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      conversation,
      messages
    });
  } catch (err) {
    console.error('Error fetching conversation:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
};

// Get paginated messages for a conversation
exports.getMessages = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const { conversationId } = req.params;
    const workspaceId = req.query?.workspaceId || null;
    const { limit = 50, skip = 0 } = req.query;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Verify user owns this conversation
    const convQuery = { _id: conversationId, userId };
    if (workspaceId) convQuery.workspaceId = workspaceId;

    const conversation = await Conversation.findOne(convQuery);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const msgQuery = { conversationId };
    if (workspaceId) msgQuery.workspaceId = workspaceId;

    const messages = await Message.find(msgQuery)
      .sort({ createdAt: 1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .lean();

    const total = await Message.countDocuments(msgQuery);

    res.json({
      messages,
      total,
      hasMore: skip + limit < total
    });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

// Update conversation (title, pinned status)
exports.updateConversation = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const { conversationId } = req.params;
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    const { title, pinned } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const convQuery = { _id: conversationId, userId };
    if (workspaceId) convQuery.workspaceId = workspaceId;

    const conversation = await Conversation.findOne(convQuery);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (typeof title === 'string') conversation.title = title;
    if (typeof pinned === 'boolean') conversation.pinned = pinned;

    await conversation.save();
    res.json(conversation);
  } catch (err) {
    console.error('Error updating conversation:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
};

// Delete/archive a conversation
exports.deleteConversation = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const { conversationId } = req.params;
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const convQuery = { _id: conversationId, userId };
    if (workspaceId) convQuery.workspaceId = workspaceId;

    const conversation = await Conversation.findOne(convQuery);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Soft delete (archive)
    conversation.archived = true;
    await conversation.save();

    res.json({ success: true, message: 'Conversation archived' });
  } catch (err) {
    console.error('Error deleting conversation:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
};

// Add a message to a conversation (used by AIService)
exports.addMessage = async (conversationId, role, content, metadata = {}, workspaceId = null) => {
  try {
    const message = new Message({
      conversationId,
      workspaceId,
      role,
      content,
      provider: metadata.provider || null,
      model: metadata.model || null,
      metadata: {
        tokens: metadata.tokens || { input: 0, output: 0 },
        streaming: metadata.streaming || false,
        interrupted: metadata.interrupted || false
      },
      attachments: metadata.attachments || [],
      toolCalls: metadata.toolCalls || []
    });

    await message.save();

    // Update conversation's lastMessage and messageCount
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: {
        content: content.substring(0, 100),
        role,
        timestamp: new Date()
      },
      $inc: { messageCount: 1 }
    });

    return message;
  } catch (err) {
    console.error('Error adding message:', err);
    throw err;
  }
};

// Generate conversation title using lightweight prompt (non-blocking)
exports.generateConversationTitle = async (conversationId, firstUserMessage) => {
  try {
    // Don't block the main response - run async
    setImmediate(async () => {
      try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation || conversation.title !== 'New Conversation') {
          return; // Already has custom title or doesn't exist
        }

        // Use lightweight provider route for title generation only
        const router = new LLMRouter();
        const titlePrompt = `Generate a concise 5-7 word title for this AI conversation.
Return ONLY the title, with no quotes and no punctuation at the end.`;

        const result = await router.generate({
          preferredProvider: 'mistral',
          stream: false,
          temperature: 0.2,
          maxTokens: 18,
          systemPrompt: titlePrompt,
          messages: [
            {
              role: 'user',
              content: `User message: ${String(firstUserMessage || '').slice(0, 220)}`
            }
          ],
          tools: []
        });

        const generatedTitle = String(result?.text || '')
          .replace(/[\n\r]+/g, ' ')
          .replace(/^['"`]+|['"`]+$/g, '')
          .trim();

        const finalTitle =
          generatedTitle && generatedTitle.length >= 3 && generatedTitle.length < 100
            ? generatedTitle
            : toFallbackTitle(firstUserMessage);
        
        conversation.title = finalTitle;
        await conversation.save();
        console.log(`Generated title: "${finalTitle}"`);

        // Notify active sockets for realtime sidebar updates
        try {
          const userSockets = global.connectedSockets?.get(String(conversation.userId));
          if (userSockets && typeof userSockets.forEach === 'function') {
            userSockets.forEach((socket) => {
              socket.emit('ai:conversation:title', {
                conversationId: String(conversation._id),
                title: finalTitle,
                workspaceId: conversation.workspaceId ? String(conversation.workspaceId) : null
              });
            });
          }
        } catch (socketErr) {
          console.warn('Title socket notification failed:', socketErr?.message || socketErr);
        }
      } catch (err) {
        console.warn('Title generation failed (non-blocking):', err.message);

        // Last-resort fallback title if generation fails entirely
        try {
          const conversation = await Conversation.findById(conversationId);
          if (conversation && conversation.title === 'New Conversation') {
            conversation.title = toFallbackTitle(firstUserMessage);
            await conversation.save();
          }
        } catch (fallbackErr) {
          console.warn('Fallback title write failed:', fallbackErr.message);
        }
      }
    });
  } catch (err) {
    console.warn('Title generation setup failed:', err.message);
  }
};
