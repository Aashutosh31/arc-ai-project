require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth.js');
const googleAuthRoutes = require('./routes/googleAuth.js');
const conversationRoutes = require('./routes/conversations.js');
const searchRoutes = require('./routes/search.js');
const memoryRoutes = require('./routes/memory.js');
const workspaceRoutes = require('./routes/workspaces.js');
const voiceRoutes = require('./routes/voice.js');
const AIService = require('./services/AIService.js'); 
const { resolveSocketConversation } = require('./lib/conversationAccess');
const operatorPolicySource = require('./lib/capabilities/operatorPolicySource');
const ticketStore = require('./lib/oneTimeTicketStore');

const isProduction = process.env.NODE_ENV === 'production';

// Startup validation for critical environment variables
const requiredEnvVars = [
    'JWT_SECRET',
    'MONGO_URI',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
];
if (isProduction) {
    requiredEnvVars.push('FRONTEND_URL');
}

// Validate MCP OAuth pre-registered client configurations
// Format: MCP_<SLUG>_OAUTH_CLIENT_ID and MCP_<SLUG>_OAUTH_CLIENT_SECRET
const mcpOAuthClientIds = Object.keys(process.env).filter(k => k.startsWith('MCP_') && k.endsWith('_OAUTH_CLIENT_ID'));
const mcpOAuthClientSecrets = Object.keys(process.env).filter(k => k.startsWith('MCP_') && k.endsWith('_OAUTH_CLIENT_SECRET'));
if (mcpOAuthClientIds.length !== mcpOAuthClientSecrets.length) {
    console.error('❌ MCP OAuth configuration mismatch: each MCP_*_OAUTH_CLIENT_ID must have a corresponding MCP_*_OAUTH_CLIENT_SECRET');
    process.exit(1);
}
for (const clientIdKey of mcpOAuthClientIds) {
    const slug = clientIdKey.replace('MCP_', '').replace('_OAUTH_CLIENT_ID', '');
    const secretKey = `MCP_${slug}_OAUTH_CLIENT_SECRET`;
    if (!process.env[secretKey]) {
        console.error(`❌ Missing MCP OAuth secret for ${slug}: ${secretKey}`);
        process.exit(1);
    }
    if (!process.env[clientIdKey]) {
        console.error(`❌ Missing MCP OAuth client ID for ${slug}: ${clientIdKey}`);
        process.exit(1);
    }
}
if (mcpOAuthClientIds.length > 0) {
    console.log(`🟢 MCP OAuth pre-registered clients configured: ${mcpOAuthClientIds.map(k => k.replace('MCP_', '').replace('_OAUTH_CLIENT_ID', '')).join(', ')}`);
}

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    console.error('❌ JWT_SECRET must be at least 32 characters');
    process.exit(1);
}

const app = express();

// Render (and most PaaS hosts) terminate TLS at an upstream proxy. Without
// this, Express sees http:// and req.secure is false, which breaks secure
// cookie handling and any https-only logic downstream.
app.set('trust proxy', 1);
const server = http.createServer(app); 
const PORT = process.env.PORT || 5000;

global.connectedSockets = new Map(); // 🚀 NOW HOLDS SETS OF SOCKETS
global.userCronJobs = new Map();
global.userWorkspaceContext = new Map(); // Track active workspace per user (per tab) 

const frontendOrigins = (process.env.FRONTEND_URL || '').split(',').map(origin => origin.trim()).filter(Boolean);

const corsOriginHandler = (origin, callback) => {
    // Allow non-browser requests (like server-to-server or curl)
    if (!origin) {
        callback(null, true);
    } else if (frontendOrigins.length === 0) {
        // Reflect origin dynamically for development
        callback(null, origin);
    } else if (frontendOrigins.includes(origin)) {
        callback(null, true);
    } else {
        callback(new Error('Not allowed by CORS'));
    }
};

app.use(cors({
    origin: corsOriginHandler,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true
}));

app.use(cookieParser());

// 8mb allows short base64 voice clips for /api/voice/transcribe; other
// endpoints send small JSON payloads and are unaffected.
//
// The operator policy router is mounted BEFORE the global parser so its own
// 64 KB JSON body cap is authoritative (a policy PUT has no business parsing
// anything large; the strict limit is part of the route contract).
app.use('/api/policy', require('./routes/policy.js'));
app.use(express.json({ limit: '8mb' }));

const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;

mongoose.connect(mongoUri)
    .then(async () => {
        console.log('🟢 MongoDB Atlas connected successfully.');
        try {
            await mongoose.connection.collection('aimemories').dropIndex('userId_1');
        } catch (err) { }
        // Operator policy is THE authoritative policy source once hydrated;
        // the bounded timer keeps the process-local copy fresh. On any
        // hydrate failure the process keeps the seeded guest-deny defaults
        // and the timer retries — the server stays up.
        try {
            await operatorPolicySource.hydrate();
            console.log(`🟢 Operator policy loaded (${operatorPolicySource.getMeta().source === 'mongo' ? 'Mongo authoritative' : 'seeded defaults'}${operatorPolicySource.getMeta().lastError ? `; lastError=${operatorPolicySource.getMeta().lastError}` : ''}).`);
        } catch (err) {
            console.error('⚠️ Operator policy initial hydrate failed; running on seeded defaults (timer will retry).', err && err.message ? err.message : err);
        }
        operatorPolicySource.startRefreshTimer();
    })
    .catch(err => console.error('MongoDB connection error:', err));

const io = new Server(server, {
    cors: {
        origin: corsOriginHandler,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Apply cookie-parser to socket.io handshake
io.use((socket, next) => {
    cookieParser()(socket.handshake, {}, next);
});

// Initialize WhatsApp provider sockets (if present)
try {
    const whatsappProvider = require('./providers/whatsapp');
    if (whatsappProvider && typeof whatsappProvider.init === 'function') {
        whatsappProvider.init(io);
        console.log('[WhatsApp] provider initialized');
    }
} catch (err) {
    console.log('[WhatsApp] provider not available or failed to init:', err?.message || err);
}

io.use((socket, next) => {
    // Handshake auth, in order of production reliability:
    //   1. one-time ticket — the client fetched it over the same-origin
    //      /api proxy (first-party cookie) and presents it here because the
    //      DIRECT cross-site socket handshake would need a third-party
    //      cookie (blocked by Safari/Firefox, phased out in Chrome).
    //   2. httpOnly cookie — first-party setups / permissive browsers.
    //   3. auth.token — legacy clients.
    const ticket = socket.handshake.auth && socket.handshake.auth.ticket;
    if (ticket) {
        const ticketData = ticketStore.consume('socket', ticket);
        if (ticketData && ticketData.userId) {
            socket.userId = String(ticketData.userId);
            socket.authType = ticketData.authType || 'user';
            socket.actor = {
                type: socket.authType === 'guest' ? 'guest' : 'user',
                id: socket.userId
            };
            console.log(`✅ Socket authenticated via one-time ticket: ${socket.userId}`);
            return next();
        }
        // Expired/replayed ticket: fall through to cookie/token so a
        // permissive browser still connects instead of hard-failing.
    }

    // Try to get token from auth object (backwards compatibility)
    let token = socket.handshake.auth.token;
    
    // If not in auth, try to get from cookies
    if (!token && socket.handshake.headers.cookie) {
        const cookies = socket.handshake.headers.cookie.split(';').reduce((acc, cookie) => {
            const [key, value] = cookie.trim().split('=');
            acc[key] = value;
            return acc;
        }, {});
        token = cookies.token;
    }
    
    if (!token) return next(new Error('Authentication error'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const rawId = decoded.id || decoded.userId || decoded._id;
        socket.userId = String(rawId);
        socket.authType = decoded.role || 'user';
        // Same canonical actor as REST (server/lib/actor.js): guests resolve
        // to their sessionId, users to their User ObjectId hex string.
        socket.actor = {
            type: socket.authType === 'guest' ? 'guest' : 'user',
            id: String(rawId)
        };
        console.log(`✅ Socket authenticated for web user: ${socket.userId}`);
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id} (Authenticated ID: ${socket.userId})`);
    
    // 🚀 THE FIX: Add the socket to a Set to support multiple tabs/reloads!
    if (!global.connectedSockets.has(socket.userId)) {
        global.connectedSockets.set(socket.userId, new Set());
    }
    global.connectedSockets.get(socket.userId).add(socket);

    // Realtime-sync Phase A ([planning 05]): every authenticated socket joins
    // its actor's user room so any device of the same user receives
    // `conversation.message.appended` fan-outs (dedupe is client-side, by the
    // canonical message `_id`). Guests join too — `emitMessageAppended`
    // refuses to fan out to guests, so the room stays empty of traffic.
    try {
        socket.join(`user:${socket.userId}`);
        socket.data.userRoom = `user:${socket.userId}`;
    } catch (roomErr) {
        console.warn('[Sync] user-room join failed:', roomErr?.message || roomErr);
    }

    // Initialize workspace context for this socket (will be overridden by client)
    socket.activeWorkspaceId = null;

    socket.on('ai:stream:stop', () => {
        socket.isInterrupted = true; 
        AIService.abortForSocket(socket.id);
    });

    // JARVIS Action Substrate — slice 4C: approval resolution. Payload is
    // { approvalId, decision: 'approve'|'deny' }. The authenticated socket
    // identity (never a client-asserted userId) is bound against the stored
    // approval record; approvalId/executionId/workspaceId/capabilityId were
    // bound server-side at request time and can never be re-targeted from the
    // client. Exactly one terminal decision ever wins (approvalStore CAS).
    //
    // P0 #2 — same-user cross-socket isolation: the record also binds to the
    // INITIATING connection, so `socket.id` is passed from THIS authenticated
    // server socket. A sibling socket of the same user (a second tab) is
    // refused with `socket_mismatch`; one account may not authorize a
    // consequential action raised by a different session. `data.socketId` (or
    // any other client-supplied socket identity) is deliberately NOT read, so
    // a forged payload field cannot re-target or bypass the binding. The ack is
    // the 4D contract and stays uniform; the reason is repo-convention
    // `socket_mismatch`.
    socket.on('agent:approval:resolve', async (data, ack) => {
        let result;
        try {
            const { getStore: getApprovalStore } = require('./lib/capabilities/redisApprovalStore');
            const approvalStore = await getApprovalStore();
            result = await approvalStore.resolve({
                approvalId: data && data.approvalId,
                decision: data && data.decision,
                userId: socket.userId,
                socketId: socket.id,
            });
        } catch (err) {
            console.error('[Approval] resolve error:', err?.message || err);
            result = { ok: false, reason: 'store-error' };
        }
        if (typeof ack === 'function') ack(result);
    });

    // Voice Runtime 2.0 — client barge-in on the streaming voice channel.
    // Cancels in-flight LLM generation (which aborts TTS synthesis via the
    // shared AbortSignal) and marks the socket interrupted so late audio is
    // never delivered. Voice errors never affect chat persistence.
    socket.on('voice:tts:cancel', () => {
        socket.isInterrupted = true;
        AIService.abortForSocket(socket.id);
    });

    // Voice Runtime FINAL — server STT. Microphone frames arrive as binary
    // `voice:stt:audio` packets; the server owns transcription. Also cancel
    // any active STT session when playback/generation starts so ARC's own
    // voice can never be transcribed as a user command.
    try {
        const sttService = require('./services/sttService');
        sttService.bindSocket(socket);
    } catch (err) {
        console.error('[Voice] STT wiring failed:', err?.message || err);
    }

    socket.on('workspace:switch', async (data) => {
        const { workspaceId } = data || {};
        const userId = socket.userId;
        if (!workspaceId) {
            return socket.emit('workspace:error', { error: 'workspaceId required' });
        }

        try {
            const Workspace = require('./models/Workspace');
            const ws = await Workspace.findOne({ _id: workspaceId, owner: userId }).lean();
            if (!ws) {
                return socket.emit('workspace:error', { error: 'Workspace not found or unauthorized' });
            }

            // Update this socket's workspace context
            socket.activeWorkspaceId = workspaceId;
            
            // Broadcast to all sockets for this user that workspace changed
            const userSockets = global.connectedSockets.get(userId);
            if (userSockets && typeof userSockets.forEach === 'function') {
                userSockets.forEach((s) => {
                    s.activeWorkspaceId = workspaceId;
                    s.emit('workspace:switched', {
                        workspaceId: String(workspaceId),
                        name: ws.name,
                        vectorNamespace: ws.vectorNamespace
                    });
                });
            }

            console.info('[Workspace:Switch] user', userId, 'switched to', workspaceId);
        } catch (err) {
            console.error('[Workspace:Switch] error:', err);
            socket.emit('workspace:error', { error: 'Failed to switch workspace' });
        }
    });

    socket.on('ai:stt:final', async (data, ack) => {
        const { command, image, document, conversationId, workspaceId: incomingWorkspaceId, language } = data;
        const userId = socket.userId;
        socket.isInterrupted = false;

        // Turn receipt plumbing. A legacy client (web pre-sync) emits without
        // an ack and is completely unaffected. `clientTurnId` is a client
        // correlation label echoed verbatim — never stored, never interpreted —
        // so a receipt can be bound to one exact optimistic bubble even when
        // turns overlap (preempt/abort re-submits).
        const clientTurnId =
            typeof data?.clientTurnId === 'string' && data.clientTurnId
                ? data.clientTurnId.slice(0, 64)
                : null;
        const emitTurnAck = (info) => {
            if (typeof ack !== 'function') return;
            try {
                ack({ ...info, clientTurnId });
            } catch (ackErr) {
                console.warn('[Turn:Ack] delivery failed:', ackErr?.message || ackErr);
            }
        };

        // P0 conversation ownership boundary (slice 4F). The client asserts
        // conversationId; the AUTHENTICATED socket actor is the authority.
        // Resolved through the ONE shared resolver (lib/conversationAccess.js)
        // that the REST conversation controller also uses, so both transports
        // enforce identical ownership semantics. Malformed, nonexistent,
        // cross-actor and wrong-workspace ids are all denied identically —
        // nothing here reveals whether another user's conversation exists.
        // Runs BEFORE the preemption abort so a forged turn can never cancel
        // the caller's own in-flight generation.
        const access = await resolveSocketConversation({
            socket,
            conversationId,
            workspaceId: socket.activeWorkspaceId || null,
        });
        if (!access.ok) {
            console.warn(`[Conversation:Access] denied turn for user ${userId}: ${access.code}.`);
            // Existing safe rejection channel: no credits charged, no provider
            // call, no message/working-state write. The terminal TTS chunk
            // closes the client stream exactly like the credit-failure path.
            if (socket) {
                socket.emit('bot_error', access.error);
                emitTurnAck({ accepted: false, error: access.error, code: access.code });
                socket.emit('ai:tts:response:chunk', {
                    chunk: '',
                    displayText: '',
                    isFinal: true,
                });
            }
            return;
        }
        const ownedConversationId = access.conversationId;

        // T2 marker: the finalized transcript was accepted and generation
        // about to start (STT loop closed → LLM path in processQuery).
        try { console.log('[VoiceLatency] stt.final.accepted at=%d', Date.now()); } catch { /* telemetry must never break */ }

        // Preempt any prior in-flight generation for this socket.
        AIService.abortForSocket(socket.id);

        // Use socket's active workspace or incoming workspace ID or null.
        // Identity hardening (slice 4E): an incoming workspaceId is only
        // honored when the requesting user owns that workspace — mirrors the
        // owner gate in workspace:switch. A forged/cross-user workspaceId
        // falls back to the socket's active workspace instead of being
        // trusted.
        let effectiveWorkspaceId = socket.activeWorkspaceId || null;
        if (incomingWorkspaceId && !String(userId).startsWith('guest_')) {
            try {
                const Workspace = require('./models/Workspace');
                const owned = await Workspace.findOne({ _id: incomingWorkspaceId, owner: userId }).lean();
                if (owned) {
                    effectiveWorkspaceId = String(incomingWorkspaceId);
                } else {
                    console.warn(`[Workspace:Identity] user ${userId} sent unowned workspaceId ${incomingWorkspaceId}; ignored.`);
                }
            } catch (err) {
                console.warn('[Workspace:Identity] workspace lookup failed:', err?.message || err);
            }
        }

        console.log(`🧠 Processing command from user ${userId} (workspace: ${effectiveWorkspaceId}): "${command}"`);
        // `language` is the per-turn STT auto-detected language (Sarvam), if any.
        // It only shapes the server TTS voice for THIS reply — never stored.
        // `ownedConversationId` was verified against socket.userId above, so no
        // downstream query can address a conversation this actor does not own.
        await AIService.processQuery(userId, command, socket, image, document, ownedConversationId, effectiveWorkspaceId, language, emitTurnAck);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        AIService.abortForSocket(socket.id);
        try { socket.sttSession?.close(); socket.sttSession = null; } catch { /* best effort */ }
        // 🚀 THE FIX: Safely remove ONLY this specific socket, keeping active tabs alive
        const userSockets = global.connectedSockets.get(socket.userId);
        if (userSockets) {
            userSockets.delete(socket);
            if (userSockets.size === 0) {
                global.connectedSockets.delete(socket.userId);
            }
        }
    });
});

app.get('/', (req, res) => res.status(200).send('ARC-AI Server Running. Status: Operational.'));
app.use('/api/auth', authRoutes);
app.use('/api/google', googleAuthRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/mcp', require('./routes/mcp.js'));
app.use('/api/debug', require('./routes/debug.js'));

server.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.info(`\n[Shutdown] Received ${signal}. Starting graceful shutdown...`);

    // Set a timeout of 10 seconds to force shutdown if hanging
    const forceExitTimeout = setTimeout(() => {
        console.error('[Shutdown] Forcefully exiting due to timeout...');
        process.exit(1);
    }, 10000);

    try {
        // 0. Stop the operator policy refresh timer before closing stores
        operatorPolicySource.stopRefreshTimer();

        // 1. Close HTTP & Socket.io server
        console.info('[Shutdown] Closing HTTP server and Socket.io...');
        await new Promise((resolve) => {
            io.close(() => {
                server.close(() => {
                    resolve();
                });
            });
        });
        console.info('[Shutdown] HTTP and Socket.io closed.');

        // 2. Shut down WhatsApp/Puppeteer clients
        try {
            const clientManager = require('./providers/whatsapp/clientManager');
            await clientManager.shutdownAllClients();
            console.info('[Shutdown] All WhatsApp clients destroyed.');
        } catch (err) {
            console.error('[Shutdown] Error shutting down WhatsApp clients:', err);
        }

        // 3. Close MongoDB connection
        if (mongoose.connection.readyState !== 0) {
            console.info('[Shutdown] Closing MongoDB connection...');
            await mongoose.connection.close();
            console.info('[Shutdown] MongoDB connection closed.');
        }

        clearTimeout(forceExitTimeout);
        console.info('[Shutdown] Graceful shutdown completed. Exiting.');
        process.exit(0);
    } catch (err) {
        console.error('[Shutdown] Error during graceful shutdown:', err);
        clearTimeout(forceExitTimeout);
        process.exit(1);
    }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));