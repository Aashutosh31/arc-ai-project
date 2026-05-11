const express = require('express');
const router = express.Router();
const conversationController = require('../controllers/conversationController');
const { protect } = require('../middleware/authMiddleware');

// All routes require auth
router.use(protect);

// Get all conversations for the user
router.get('/', conversationController.getConversations);

// Create a new conversation
router.post('/', conversationController.createConversation);

// Get a specific conversation with all messages
router.get('/:conversationId', conversationController.getConversation);

// Get paginated messages for a conversation
router.get('/:conversationId/messages', conversationController.getMessages);

// Update conversation (title, pinned)
router.patch('/:conversationId', conversationController.updateConversation);

// Delete/archive a conversation
router.delete('/:conversationId', conversationController.deleteConversation);

module.exports = router;
