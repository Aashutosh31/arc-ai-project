const clientManager = require('../providers/whatsapp/clientManager');

module.exports = {
    schema: {
        type: 'function',
        function: {
            name: 'sendWhatsAppMessage',
            description: 'Send a WhatsApp message using the user\'s connected WhatsApp session by recipient contact name. The provider resolves the contact internally.',
            parameters: {
                type: 'object',
                properties: {
                    recipientName: { type: 'string', description: 'Recipient contact name or alias to resolve internally' },
                    message: { type: 'string', description: 'Message text to send' },
                    userId: { type: 'string', description: 'The ARC user ID owning the WhatsApp session' }
                },
                required: ['recipientName', 'message', 'userId']
            }
        }
    },

    execute: async (args, context) => {
        try {
            const userId = args?.userId || context.userId || (context?.user && context.user.id);
            if (!userId) throw new Error('Missing user context for WhatsApp send');

            const { recipientName, message } = args || {};
            if (!recipientName || !message) throw new Error('Missing recipientName or message');

            const result = await clientManager.sendMessage(String(userId), recipientName, message);
            return result;
        } catch (error) {
            console.error('[sendWhatsAppMessage] error', error?.stack || error);
            return { success: false, error: String(error) };
        }
    }
};
