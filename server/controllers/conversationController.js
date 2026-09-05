const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const LLMRouter = require('../lib/llm/LLMRouter');
const mongoose = require('mongoose');
const { getActor, isGuestActor } = require('../lib/actor');
const WorkspaceRuntimeManager = require('../services/WorkspaceRuntimeManager');

const workspaceRuntime = new WorkspaceRuntimeManager({ logger: console });

// Request identity comes from the canonical actor (server/lib/actor.js), never
// from provider-specific fields. Guests own no workspaces, so any workspace
// filter they send can only be stale — it is ignored (treated as null) so
// guest conversations stay visible instead of 404ing on a foreign workspace.
const getRequestContext = (req) => {
  const actor = getActor(req);
  const rawWorkspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
  return {
    actor,
    userId: actor?.id || null,
    workspaceId: actor && isGuestActor(actor) ? null : rawWorkspaceId
  };
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

// Ownership lookup with workspace fallback: a workspace-scoped miss is retried
// without the workspace filter (still scoped to the actor), so conversations
// stored before workspace attribution stay reachable instead of 404ing.
// Cross-actor access still 404s — the workspace filter is not a security
// boundary, actor scoping is.
const findOwnedConversation = async (userId, conversationId, workspaceId) => {
  if (!isValidObjectId(conversationId)) return null;
  if (workspaceId) {
    const scoped = await Conversation.findOne({ _id: conversationId, userId, workspaceId });
    if (scoped) return scoped;
  }
  return Conversation.findOne({ _id: conversationId, userId });
};

const rejectInvalidWorkspace = (res, workspaceId) => {
  if (workspaceId && !isValidObjectId(workspaceId)) {
    res.status(400).json({ error: 'Invalid workspace ID.', code: 'INVALID_WORKSPACE_ID' });
    return true;
  }
  return false;
};

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
    const { userId, workspaceId } = getRequestContext(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectInvalidWorkspace(res, workspaceId)) return;

    const query = { userId, archived: false };
    if (workspaceId) query.workspaceId = workspaceId;

    const conversations = await Conversation.find(query)
      .sort({ updatedAt: -1 })
      .select('_id title createdAt updatedAt lastMessage pinned messageCount')
      .lean();

    res.json(conversations);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Failed to fetch conversations', code: 'SERVER_ERROR' });
  }
};

// Create a new conversation
exports.createConversation = async (req, res) => {
  try {
    const { actor, userId, workspaceId: requestedWorkspaceId } = getRequestContext(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectInvalidWorkspace(res, requestedWorkspaceId)) return;

    const { title = 'New Conversation' } = req.body;

    // Users always get a resolved workspace so later workspace-filtered reads
    // match what was stored (same as the Socket/AI path). Guests stay null.
    let workspaceId = requestedWorkspaceId;
    if (!workspaceId && actor && !isGuestActor(actor)) {
      try {
        const resolved = await workspaceRuntime.resolveWorkspace({ userId, workspaceId: null });
        workspaceId = resolved?._id || null;
      } catch (resolveErr) {
        console.warn('[Conversations] workspace auto-resolve failed, storing without workspace:', resolveErr?.message || resolveErr);
        workspaceId = null;
      }
    }

    const conversation = new Conversation({
      userId,
      workspaceId,
      title
    });

    await conversation.save();
    res.status(201).json(conversation);
  } catch (err) {
    console.error('Error creating conversation:', err);
    res.status(500).json({ error: 'Failed to create conversation', code: 'SERVER_ERROR' });
  }
};

// Get a specific conversation with all messages
exports.getConversation = async (req, res) => {
  try {
    const { userId, workspaceId } = getRequestContext(req);
    const { conversationId } = req.params;

    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectInvalidWorkspace(res, workspaceId)) return;

    const conversation = await findOwnedConversation(userId, conversationId, workspaceId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
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
    res.status(500).json({ error: 'Failed to fetch conversation', code: 'SERVER_ERROR' });
  }
};

// Get paginated messages for a conversation
exports.getMessages = async (req, res) => {
  try {
    const { userId, workspaceId } = getRequestContext(req);
    const { conversationId } = req.params;
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const skipNum = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectInvalidWorkspace(res, workspaceId)) return;

    // Verify the actor owns this conversation (with workspace fallback)
    const conversation = await findOwnedConversation(userId, conversationId, workspaceId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    const msgQuery = { conversationId };
    if (workspaceId) msgQuery.workspaceId = workspaceId;

    const messages = await Message.find(msgQuery)
      .sort({ createdAt: 1 })
      .skip(skipNum)
      .limit(limitNum)
      .lean();

    const total = await Message.countDocuments(msgQuery);

    res.json({
      messages,
      total,
      hasMore: skipNum + limitNum < total
    });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages', code: 'SERVER_ERROR' });
  }
};

// Update conversation (title, pinned status)
exports.updateConversation = async (req, res) => {
  try {
    const { userId, workspaceId } = getRequestContext(req);
    const { conversationId } = req.params;
    const { title, pinned } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectInvalidWorkspace(res, workspaceId)) return;

    const conversation = await findOwnedConversation(userId, conversationId, workspaceId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    if (typeof title === 'string') conversation.title = title;
    if (typeof pinned === 'boolean') conversation.pinned = pinned;

    await conversation.save();
    res.json(conversation);
  } catch (err) {
    console.error('Error updating conversation:', err);
    res.status(500).json({ error: 'Failed to update conversation', code: 'SERVER_ERROR' });
  }
};

// Delete/archive a conversation
exports.deleteConversation = async (req, res) => {
  try {
    const { userId, workspaceId } = getRequestContext(req);
    const { conversationId } = req.params;

    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectInvalidWorkspace(res, workspaceId)) return;

    const conversation = await findOwnedConversation(userId, conversationId, workspaceId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    // Soft delete (archive)
    conversation.archived = true;
    await conversation.save();

    res.json({ success: true, message: 'Conversation archived' });
  } catch (err) {
    console.error('Error deleting conversation:', err);
    res.status(500).json({ error: 'Failed to delete conversation', code: 'SERVER_ERROR' });
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
