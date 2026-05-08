const clientManager = require('./clientManager');

const init = (io) => {
    if (!io) return;

    io.on('connection', (socket) => {
        // socket.userId available from auth middleware in index.js
        socket.on('disconnect', () => {
            clientManager.detachSocket(socket.userId, socket);
        });

        if (socket.userId && clientManager.isWhatsAppConnected(socket.userId)) {
            clientManager.bindSocket(socket.userId, socket);
            socket.emit('whatsapp:state', { state: 'connected' });
            socket.emit('whatsapp:ready', { userId: socket.userId, restored: true });
            socket.emit('whatsapp:connect_ack', { success: true, restored: true });
        }

        socket.on('whatsapp:connect', async (payload) => {
            try {
                const userId = socket.userId;
                await clientManager.initClientForUser(userId, socket);
                clientManager.bindSocket(userId, socket);
                socket.emit('whatsapp:state', { state: 'connecting' });
                socket.emit('whatsapp:connect_ack', { success: true });
                if (clientManager.isWhatsAppConnected(userId)) {
                    socket.emit('whatsapp:state', { state: 'connected' });
                    socket.emit('whatsapp:ready', { userId, restored: true });
                }
            } catch (err) {
                console.error('[WhatsApp] connect failed', err?.message || err);
                socket.emit('whatsapp:connect_ack', { success: false, error: String(err) });
            }
        });

        socket.on('whatsapp:pair_with_phone', async (payload, cb) => {
            try {
                const userId = socket.userId;
                const { phoneNumber } = payload || {};
                if (!phoneNumber) throw new Error('Missing phoneNumber');

                await clientManager.initClientForUser(userId, socket);
                clientManager.bindSocket(userId, socket);
                const result = await clientManager.requestPairingCode(userId, phoneNumber);

                if (typeof cb === 'function') cb(null, result);
            } catch (err) {
                console.error('[WhatsApp] pair_with_phone failed', err?.message || err);
                socket.emit('whatsapp:pairing_failed', { success: false, error: String(err) });
                if (typeof cb === 'function') cb(String(err));
            }
        });

        socket.on('whatsapp:cancel_pairing', async (payload, cb) => {
            try {
                const userId = socket.userId;
                await clientManager.cancelPairingCode(userId);
                socket.emit('whatsapp:pairing_cancelled', { success: true });
                if (typeof cb === 'function') cb(null, { success: true });
            } catch (err) {
                console.error('[WhatsApp] cancel_pairing failed', err?.message || err);
                socket.emit('whatsapp:pairing_cancelled', { success: false, error: String(err) });
                if (typeof cb === 'function') cb(String(err));
            }
        });

        socket.on('whatsapp:sync_contacts', async (payload, cb) => {
            try {
                const userId = socket.userId;
                const client = clientManager.getClient(userId);
                const contacts = await clientManager.syncContacts(userId, client, socket);
                if (typeof cb === 'function') cb(null, { success: true, count: contacts.length });
                socket.emit('whatsapp:contacts_synced', { count: contacts.length });
            } catch (err) {
                console.error('[WhatsApp] sync_contacts failed', err?.message || err);
                if (typeof cb === 'function') cb(String(err));
                socket.emit('whatsapp:contacts_sync_failed', { error: String(err) });
            }
        });

        socket.on('whatsapp:send', async (data, cb) => {
            try {
                const userId = socket.userId;
                const { recipientName, message } = data || {};
                if (!recipientName || !message) throw new Error('Missing recipientName or message');
                const result = await clientManager.sendMessage(userId, recipientName, message);

                if (!result?.success) {
                    const eventName = result?.status === 'ambiguous' ? 'whatsapp:recipient_ambiguous' : 'whatsapp:recipient_not_found';
                    socket.emit(eventName, result);
                    if (typeof cb === 'function') cb(null, result);
                    return;
                }

                socket.emit('whatsapp:message_sent', {
                    success: true,
                    id: result.message?.id || null,
                    contact: result.contact
                });
                if (typeof cb === 'function') cb(null, result);
            } catch (err) {
                console.error('[WhatsApp] send failed', err?.message || err);
                socket.emit('whatsapp:message_failed', { success: false, error: String(err) });
                if (typeof cb === 'function') cb(String(err));
            }
        });
    });
};

module.exports = { init };
