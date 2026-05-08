const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const contactIndex = require('./contactIndex');

const records = new Map();

const SESSIONS_DIR = path.resolve(__dirname, '../../.whatsapp-sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const BROWSER_CANDIDATES = [
    process.env.CHROMIUM_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
].filter(Boolean);

const TRANSIENT_ERROR_PATTERNS = [
    /Execution context was destroyed/i,
    /No LID for users?/i,
    /Navigation/i,
    /target closed/i,
    /session closed/i,
    /Frame was detached/i,
    /Protocol error/i
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientWhatsAppError = (error) => {
    const message = String(error?.message || error || '');
    const stack = String(error?.stack || '');
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message) || pattern.test(stack));
};

const ensureProcessGuards = () => {
    if (global.__arcWhatsAppProcessGuardsInstalled) return;
    global.__arcWhatsAppProcessGuardsInstalled = true;

    process.on('unhandledRejection', (reason) => {
        if (isTransientWhatsAppError(reason)) {
            console.warn('[WhatsApp] swallowed transient unhandled rejection:', reason?.message || reason);
            return;
        }
    });

    process.on('uncaughtException', (error) => {
        if (isTransientWhatsAppError(error)) {
            console.warn('[WhatsApp] swallowed transient uncaught exception:', error?.message || error);
            return;
        }

        console.error('[WhatsApp] fatal uncaught exception:', error?.stack || error);
        process.exit(1);
    });
};

ensureProcessGuards();

const getExecutablePath = () => {
    for (const candidate of BROWSER_CANDIDATES) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
};

const getRecord = (userId) => records.get(String(userId)) || null;

const emitToSockets = (record, event, payload) => {
    if (!record?.sockets) return;

    for (const socket of record.sockets) {
        if (socket && socket.connected) {
            socket.emit(event, payload);
        }
    }
};

const detachSocket = (userId, socket) => {
    const record = getRecord(userId);
    if (!record || !socket) return;
    record.sockets.delete(socket);
};

const bindSocket = (userId, socket) => {
    if (!socket) return;
    const record = getRecord(userId);
    if (!record) return;
    record.sockets.add(socket);
};

const createClient = (userId) => {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: String(userId), dataPath: SESSIONS_DIR }),
        puppeteer: {
            executablePath: getExecutablePath(),
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions'
            ]
        },
        takeoverOnConflict: true,
        restartOnAuthFail: true
    });

    return client;
};

const scheduleRecovery = (userId, reason) => {
    const record = getRecord(userId);
    if (!record || record.recoveryInProgress) return;
    if (record.reconnectTimer) return;
    if (record.sockets.size === 0) return;

    const delay = Math.min(1500 * Math.max(record.reconnectAttempt || 0, 1), 15000);
    record.reconnectTimer = setTimeout(async () => {
        record.reconnectTimer = null;
        if (record.sockets.size === 0) return;

        try {
            record.recoveryInProgress = true;
            record.reconnectAttempt = (record.reconnectAttempt || 0) + 1;
            console.log(`[WhatsApp] recovering client for user ${userId} after ${reason || 'disconnect'}`);
            await recoverClient(userId, reason);
        } catch (error) {
            console.error('[WhatsApp] recovery failed:', error?.message || error);
        } finally {
            record.recoveryInProgress = false;
        }
    }, delay);
};

const attachClientEvents = (userId, client) => {
    client.on('qr', async (qr) => {
        try {
            const dataUrl = await qrcode.toDataURL(qr);
            const record = getRecord(userId);
            emitToSockets(record, 'whatsapp:qr', { qr, qrcode: dataUrl });
        } catch (error) {
            console.error('[WhatsApp] failed to generate qr data url', error?.message || error);
            const record = getRecord(userId);
            emitToSockets(record, 'whatsapp:qr', { qr });
        }
    });

    client.on('loading_screen', (percent, message) => {
        const record = getRecord(userId);
        emitToSockets(record, 'whatsapp:state', { state: 'loading_screen', percent, message });
    });

    client.on('authenticated', () => {
        const record = getRecord(userId);
        if (record) {
            record.ready = false;
            record.lastAuthenticatedAt = Date.now();
            record.reconnectAttempt = 0;
        }
        console.log(`[WhatsApp] authenticated for user ${userId}`);
        emitToSockets(record, 'whatsapp:authenticated', { userId });
    });

    client.on('ready', () => {
        const record = getRecord(userId);
        if (record) {
            record.ready = true;
            record.lastReadyAt = Date.now();
            record.reconnectAttempt = 0;
        }
        console.log(`[WhatsApp] client ready for user ${userId}`);
        emitToSockets(record, 'whatsapp:ready', { userId });

        syncContacts(userId, client).catch((error) => {
            console.error('[WhatsApp] contact sync failed on ready:', error?.message || error);
            const nextRecord = getRecord(userId);
            emitToSockets(nextRecord, 'whatsapp:contacts_sync_failed', { error: String(error) });
        });
    });

    client.on('auth_failure', (message) => {
        const record = getRecord(userId);
        if (record) record.ready = false;
        console.error(`[WhatsApp] auth failure for user ${userId}:`, message);
        emitToSockets(record, 'whatsapp:auth_failure', { message: String(message) });
    });

    client.on('disconnected', (reason) => {
        const record = getRecord(userId);
        if (record) record.ready = false;
        console.log(`[WhatsApp] disconnected for user ${userId}:`, reason);
        emitToSockets(record, 'whatsapp:disconnected', { reason });

        const shouldRecover = record && record.sockets.size > 0 && !String(reason || '').toLowerCase().includes('logout');
        if (shouldRecover) {
            scheduleRecovery(userId, reason);
        } else {
            // Remove the record only for explicit logout or when there are no listeners left.
            if (record && record.reconnectTimer) {
                clearTimeout(record.reconnectTimer);
            }
            records.delete(String(userId));
        }
    });
};

const recoverClient = async (userId, reason) => {
    const record = getRecord(userId);
    if (!record) return null;

    const sockets = new Set(record.sockets);
    const oldClient = record.client;

    try {
        if (oldClient) {
            oldClient.removeAllListeners();
            await oldClient.destroy();
        }
    } catch (error) {
        if (!isTransientWhatsAppError(error)) {
            console.error('[WhatsApp] error destroying client during recovery:', error?.message || error);
        }
    }

    records.delete(String(userId));
    await initClientForUser(userId, null);
    const nextRecord = getRecord(userId);
    if (nextRecord) {
        sockets.forEach((socket) => nextRecord.sockets.add(socket));
    }
    emitToSockets(nextRecord, 'whatsapp:state', { state: 'recovering', reason: String(reason || 'disconnect') });
    return nextRecord ? nextRecord.client : null;
};

const initClientForUser = async (userId, socket) => {
    if (!userId) throw new Error('userId required to init WhatsApp client');
    const key = String(userId);

    const existing = getRecord(key);
    if (existing) {
        bindSocket(key, socket);
        return existing.client;
    }

    const record = {
        userId: key,
        client: null,
        sockets: new Set(socket ? [socket] : []),
        ready: false,
        reconnectTimer: null,
        reconnectAttempt: 0,
        recoveryInProgress: false,
        initPromise: null
    };

    const client = createClient(key);
    record.client = client;
    records.set(key, record);

    attachClientEvents(key, client);

    record.initPromise = Promise.resolve()
        .then(() => client.initialize())
        .then(() => client)
        .catch(async (error) => {
            record.ready = false;
            record.lastInitError = error;
            console.error('[WhatsApp] failed to initialize client for', key, error?.message || error);

            if (isTransientWhatsAppError(error) && record.sockets.size > 0) {
                scheduleRecovery(key, 'initialize_error');
            }

            return client;
        });

    return client;
};

const getClient = (userId) => {
    return getRecord(userId)?.client || null;
};

const waitForConnectedState = async (userId, client, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const state = typeof client.getState === 'function' ? await client.getState() : 'CONNECTED';
            if (String(state || '').toUpperCase().includes('CONNECTED')) return true;
        } catch (error) {
            if (!isTransientWhatsAppError(error)) {
                throw error;
            }
        }

        await sleep(750);
    }

    throw new Error(`WhatsApp client for user ${userId} did not reach CONNECTED state in time.`);
};

const syncContacts = async (userId, client = getClient(userId), socket) => {
    if (!client) throw new Error('WhatsApp client not initialized for user');
    const record = getRecord(userId);
    if (record?.initPromise) {
        await record.initPromise.catch(() => null);
    }
    await waitForConnectedState(userId, client).catch(async () => {
        await recoverClient(userId, 'sync_contacts_wait');
    });

    const activeClient = getClient(userId);
    if (!activeClient) throw new Error('WhatsApp client not available for contact sync');

    const contacts = await contactIndex.syncContactsFromClient(userId, activeClient);
    if (socket && socket.emit) {
        socket.emit('whatsapp:contacts_synced', { count: contacts.length });
    }
    return contacts;
};

const resolveRecipient = (userId, recipientName) => contactIndex.resolveRecipient(userId, recipientName);

const sendMessage = async (userId, recipientName, text, options = {}) => {
    const record = getRecord(userId);
    const client = record?.client || null;
    if (!client) throw new Error('WhatsApp client not initialized for user');
    if (record?.initPromise) {
        await record.initPromise.catch(() => null);
    }

    const resolution = resolveRecipient(userId, recipientName);
    if (resolution.status === 'not_found') {
        return {
            success: false,
            status: 'not_found',
            message: `No contact found for "${recipientName}".`
        };
    }

    if (resolution.status === 'ambiguous') {
        return {
            success: false,
            status: 'ambiguous',
            message: `Multiple contacts matched "${recipientName}".`,
            matches: resolution.matches.slice(0, 5).map((contact) => ({
                name: contact.name,
                jid: contact.jid,
                phone: contact.phone,
                aliases: contact.aliases || []
            }))
        };
    }

    const contact = resolution.contact;
    const jid = contact.jid || (contact.phone ? `${contact.phone}@c.us` : '');
    if (!jid) {
        return {
            success: false,
            status: 'not_found',
            message: `Could not resolve JID for "${recipientName}".`
        };
    }

    try {
        await waitForConnectedState(userId, client);
        const message = await client.sendMessage(jid, String(text), options);
        return {
            success: true,
            status: 'sent',
            contact: {
                name: contact.name,
                jid: contact.jid,
                phone: contact.phone,
                aliases: contact.aliases || []
            },
            message
        };
    } catch (error) {
        if (isTransientWhatsAppError(error)) {
            console.warn(`[WhatsApp] transient send failure for user ${userId}, retrying once:`, error?.message || error);
            const freshClient = await recoverClient(userId, 'send_retry');
            if (!freshClient) {
                throw error;
            }

            await waitForConnectedState(userId, freshClient, 25000);
            const retriedMessage = await freshClient.sendMessage(jid, String(text), options);
            return {
                success: true,
                status: 'sent',
                retried: true,
                contact: {
                    name: contact.name,
                    jid: contact.jid,
                    phone: contact.phone,
                    aliases: contact.aliases || []
                },
                message: retriedMessage
            };
        }

        throw error;
    }
};

const requestPairingCode = async (userId, phoneNumber) => {
    const record = getRecord(userId);
    if (!record?.client) throw new Error('WhatsApp client not initialized for user');
    if (record?.initPromise) {
        await record.initPromise.catch(() => null);
    }

    const client = getClient(userId);
    if (!client) throw new Error('WhatsApp client not available for pairing');

    const rawPhoneNumber = String(phoneNumber || '').replace(/\D/g, '');
    if (!rawPhoneNumber) {
        throw new Error('phoneNumber required for pairing code request');
    }

    const state = typeof client.getState === 'function' ? await client.getState().catch(() => null) : null;
    if (String(state || '').toUpperCase().includes('CONNECTED')) {
        throw new Error('WhatsApp is already connected for this user. Disconnect first to pair a new device.');
    }

    const code = await client.requestPairingCode(rawPhoneNumber, true);
    const nextRecord = getRecord(userId);
    emitToSockets(nextRecord, 'whatsapp:state', { state: 'pairing_code_requested', phoneNumber: rawPhoneNumber });
    emitToSockets(nextRecord, 'whatsapp:pairing_code', { phoneNumber: rawPhoneNumber, code });
    return { success: true, phoneNumber: rawPhoneNumber, code };
};

module.exports = {
    initClientForUser,
    getClient,
    sendMessage,
    requestPairingCode,
    syncContacts,
    resolveRecipient,
    detachSocket,
    bindSocket,
    recoverClient,
    isTransientWhatsAppError
};
