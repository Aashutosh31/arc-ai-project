// client/tests/qa/approvalHarnessServer.mjs
//
// JARVIS Action Substrate — slice 4D: browser-QA harness server.
//
// A standalone Socket.IO + TaskExecutor harness (NO database, NO providers —
// the same pattern as the 4C transport test) that lets a real browser drive
// the approval UI end to end:
//   - real auth bootstrap endpoints (guest session) so the Vite dev client
//     connects exactly like production;
//   - the same `agent:approval:resolve` handler shape as `server/index.js`,
//     backed by the REAL `approvalStore` CAS;
//   - `POST /__qa/request` creates real approval state and pushes the real
//     `agent:approval:requested` event to the browser:
//       case 'native' — the REAL `TaskExecutor.executeTool('getTime')` gate
//       (approval_required policy on native:getTime), so approve → the tool
//       actually executes once; deny/expire → zero executions;
//       case 'mcp' — an MCP-shaped record (source 'mcp', consequential) so the
//       UI handles the MCP payload shape end to end;
//       case 'timeout' — a short TTL so the card expires while open;
//       case 'multi' — several pending approvals to exercise the stack.
//
// Run from repo root: PORT=5000 node client/tests/qa/approvalHarnessServer.mjs
// (the Vite dev client already defaults to http://localhost:5000).
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..', '..', '..');
const req = createRequire(join(repoRoot, 'server', 'package.json'));

const { Server: IOServer } = req('socket.io');
const TaskExecutor = req(join(repoRoot, 'server', 'services', 'TaskExecutor.js'));
const approvalStore = req(join(repoRoot, 'server', 'lib', 'capabilities', 'approvalStore.js'));

const PORT = Number(process.env.PORT || 5000);
const QA_USER = 'qa-user-1';

const userSockets = new Map();
const requestLog = [];

const server = http.createServer(handleHttp);
const io = new IOServer(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
});

// Mirror the server auth middleware contract minimally: stamp socket.userId
// from the handshake token (never a client-asserted identity in the payload).
io.use((socket, next) => {
  const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
  console.log('[Harness] handshake token =', JSON.stringify(token));
  if (!token) return next(new Error('missing token'));
  socket.userId = token;
  next();
});

io.on('connection', (socket) => {
  if (!userSockets.has(socket.userId)) userSockets.set(socket.userId, new Set());
  userSockets.get(socket.userId).add(socket);
  socket.on('disconnect', () => {
    userSockets.get(socket.userId)?.delete(socket);
  });

  // Same handler shape as server/index.js (slice 4C): server-bound identity.
  socket.on('agent:approval:resolve', (data, ack) => {
    let result;
    try {
      result = approvalStore.resolve({
        approvalId: data && data.approvalId,
        decision: data && data.decision,
        userId: socket.userId,
      });
    } catch (err) {
      console.error('[Harness] approval resolve error:', err && err.message);
      result = { ok: false, reason: 'store-error' };
    }
    if (typeof ack === 'function') ack(result);
  });
});

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

const qaSockets = () => Array.from(userSockets.get(QA_USER) || []);

const emitToQa = (event, payload) => {
  for (const socket of qaSockets()) socket.emit(event, payload);
};

const requestPayload = (approval) => ({
  approvalId: approval.approvalId,
  executionId: approval.executionId,
  capabilityId: approval.capabilityId,
  toolName: approval.toolName,
  source: approval.source,
  risk: approval.risk,
  scope: approval.scope,
  reason: approval.reason,
  expiresAt: new Date(approval.expiresAt).toISOString(),
  state: approval.state,
});

const findNativeApproval = () =>
  approvalStore
    .list()
    .filter((r) => r.toolName === 'getTime' && r.userId === QA_USER)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;

// Real native gate: approval_required on the harmless getTime capability.
// Approve → the tool body actually executes exactly once (real executor);
// deny/expire/cancel → zero executions (normalized authorization failure).
const runNative = async (ttlMs) => {
  const socket = qaSockets()[0];
  if (!socket) return { error: 'no authenticated session yet' };
  const entry = { id: `native-${Date.now()}`, case: 'native', ttlMs: ttlMs || 30000, createdAt: Date.now() };
  requestLog.push(entry);

  TaskExecutor.executeTool('getTime', {}, QA_USER, socket, {
    skipCreditCharge: true,
    approvalTtlMs: ttlMs || 30000,
    authorizationPolicy: {
      entries: [
        {
          id: 'native:getTime',
          action: 'approval_required',
          reason: 'QA harness approval-required policy on getTime',
        },
      ],
    },
  })
    .then((result) => {
      const authorization = (result && result.authorization) || {};
      entry.approvalId = authorization.approvalId || (findNativeApproval() || {}).approvalId || null;
      entry.state = authorization.approvalState
        || (result && result.success ? 'APPROVED' : null);
      entry.executed = Boolean(result && result.success);
      entry.resultSummary = {
        success: Boolean(result && result.success),
        error: result && result.error ? String(result.error).slice(0, 120) : null,
        approvalState: authorization.approvalState || null,
        cancelled: Boolean(result && result.cancelled),
      };
      console.log(`[Harness] native ${entry.id}: state=${entry.state} executed=${entry.executed}`);
    })
    .catch((err) => {
      entry.error = err && err.message;
      console.error('[Harness] native executeTool failed:', err && err.message);
    });

  // Best-effort approvalId capture (created synchronously in the gate).
  setTimeout(() => {
    if (!entry.approvalId) {
      const found = findNativeApproval();
      if (found) entry.approvalId = found.approvalId;
    }
  }, 100);
  return { ok: true, id: entry.id };
};

// Direct store record for the MCP-shaped and timeout scenarios. The 4C chain
// for real MCP tools is proven by the server suites; here we exercise the UI
// and transport against the exact MCP payload shape.
const createDirect = (name) => {
  const approval = approvalStore.create({
    executionId: `exec-${name}-${Date.now()}`,
    userId: QA_USER,
    capabilityId: 'mcp.qa-fixture.deep-x',
    source: 'mcp',
    toolName: 'mcp__qa__deep-x',
    risk: 'high',
    scope: 'consequential',
    reason: 'MCP server requests approval before running a consequential tool',
    ttlMs: name === 'timeout' ? 2500 : 30000,
  });
  const entry = {
    id: `${name}-${Date.now()}`,
    case: name,
    approvalId: approval.approvalId,
    ttlMs: approval.expiresAt - approval.createdAt,
    createdAt: Date.now(),
  };
  requestLog.push(entry);
  emitToQa('agent:approval:requested', requestPayload(approval));
  return { ok: true, id: entry.id, approvalId: approval.approvalId, expiresAt: approval.expiresAt };
};

const currentStoreState = (entry) => {
  if (!entry.approvalId) return null;
  const record = approvalStore.read(entry.approvalId);
  return record ? record.state : null;
};

function handleHttp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'POST' && pathname === '/api/auth/guest') {
    return sendJson(res, 200, {
      token: QA_USER,
      _id: QA_USER,
      authType: 'guest',
      username: 'QA User',
      creditsRemaining: 100000,
      googleLinked: false,
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const ok = String(req.headers.authorization || '') === `Bearer ${QA_USER}`;
    return ok
      ? sendJson(res, 200, { user: { _id: QA_USER, authType: 'guest', username: 'QA User' } })
      : sendJson(res, 401, { error: 'unauthorized' });
  }

  const workspace = { _id: 'ws-qa', name: 'QA Workspace', description: '', visibility: 'private' };

  if (req.method === 'GET' && pathname === '/api/workspaces/active') {
    return sendJson(res, 200, { workspace });
  }
  if (req.method === 'GET' && pathname === '/api/workspaces') {
    return sendJson(res, 200, { workspaces: [workspace] });
  }
  if (req.method === 'POST' && pathname === '/api/workspaces') {
    return sendJson(res, 200, { workspace });
  }

  if (req.method === 'GET' && pathname === '/api/conversations') {
    return sendJson(res, 200, { conversations: [] });
  }
  if (req.method === 'POST' && pathname === '/api/conversations') {
    return sendJson(res, 200, { conversation: { _id: 'conv-qa', title: 'QA', workspaceId: 'ws-qa', messages: [] } });
  }
  if (/^\/api\/conversations\/[^/]+\/messages/.test(pathname) && req.method === 'GET') {
    return sendJson(res, 200, { messages: [], hasMore: false, total: 0, oldestId: null });
  }

  if (req.method === 'POST' && pathname === '/__qa/request') {
    readBody(req).then((body) => {
      const kind = String(body.case || 'native');
      try {
        if (kind === 'mcp' || kind === 'timeout') {
          const out = createDirect(kind);
          return sendJson(res, 200, out);
        }
        if (kind === 'multi') {
          const out = [];
          for (let i = 0; i < (Number(body.count) || 2); i += 1) {
            out.push(createDirect('multi'));
          }
          return sendJson(res, 200, { ok: true, items: out });
        }
        return runNative(Number(body.ttlMs) || 30000).then((out) => sendJson(res, 200, out));
      } catch (err) {
        return sendJson(res, 500, { error: err && err.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/__qa/results') {
    return sendJson(res, 200, {
      entries: requestLog.map((entry) => ({
        id: entry.id,
        case: entry.case,
        created: entry.createdAt,
        approved: __qaEntryApproved(entry),
        state: __qaEntryState(entry),
        executed: Boolean(entry.executed),
        resultSummary: entry.resultSummary || null,
        error: entry.error || null,
      })),
    });
  }

  if (req.method === 'GET' && pathname === '/__qa/metrics') {
    const records = approvalStore.list();
    return sendJson(res, 200, {
      requested: requestLog.length,
      sockets: qaSockets().length,
      pending: records.filter((r) => r.state === approvalStore.STATES.PENDING).length,
      terminal: records.filter((r) => r.state !== approvalStore.STATES.PENDING).length,
      storeSize: records.length,
    });
  }

  return sendJson(res, 404, { error: 'not found', pathname });
}

const __qaEntryApproved = (entry) => entry.state === 'APPROVED' || currentStoreState(entry) === approvalStore.STATES.APPROVED;
const __qaEntryState = (entry) => entry.state || currentStoreState(entry);

server.listen(PORT, () => {
  console.log(`[Approval QA harness] listening on :${PORT} (user=${QA_USER})`);
});