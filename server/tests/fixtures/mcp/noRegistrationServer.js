'use strict';

// No-registration OAuth fixture (tests only — NEVER exposed publicly).
//
// Mirrors authorization servers that support NEITHER dynamic client
// registration NOR client-id metadata documents, yet gate MCP tool calls
// behind OAuth (the pre-registered-client shape):
//  - OAuth 2.0 Protected Resource Metadata (RFC 9728)
//  - Authorization Server Metadata (RFC 8414) WITHOUT registration_endpoint
//    and WITHOUT client_id_metadata_document_supported
//  - Authorization endpoint accepting ONE fixed pre-registered client_id
//    (code + PKCE S256 + `iss` echo per RFC 9207)
//  - Token endpoint (authorization_code exchange + refresh_token rotation)
//    requiring the pre-registered client_secret (basic or post)
//  - Minimal JSON-RPC MCP endpoint with SPLIT auth behavior: `initialize`
//    and `tools/list` succeed anonymously (200), while `tools/call` without
//    a valid bearer fails closed (401 + JSON-RPC isError, like servers that
//    allow anonymous discovery but gate execution).
//
// Run:  cd server && node tests/mcpOAuthRegistration.test.js

const http = require('node:http');
const crypto = require('node:crypto');

const rand = (n = 16) => crypto.randomBytes(n).toString('base64url');

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const sendJson = (res, status, obj, extraHeaders = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(body);
};

const createNoRegistrationFixtureServer = async () => {
  // Fixed pre-registered identity, minted per instance (never hardcoded by
  // consumers — tests read fx.preregClientId / fx.preregClientSecret).
  const PREREG_CLIENT_ID = `prereg-fixture-${rand(8)}`;
  const PREREG_CLIENT_SECRET = `prereg-secret-${rand(16)}`;

  const codes = new Map(); // code → { redirect_uri, challenge, scope, used }
  const accessTokens = new Map(); // token → { revoked }
  const refreshTokens = new Map(); // token → {}
  const counts = {
    authorizeRedirects: 0, codeExchanges: 0, refreshes: 0,
    basicAuthUses: 0, postSecretUses: 0, anonymousDiscovers: 0, gatedCalls: 0
  };
  let lastAuthorizeRequest = null;
  // Authenticated discovery behavior: 'ok' (200 + tools), 'quirk403'
  // (non-2xx status with a VALID JSON-RPC success body — provider quirk),
  // 'broken500' (non-2xx malformed body — genuine failure). Anonymous
  // discovery always succeeds. Mutable for retry/recovery tests.
  let authedDiscoveryMode = 'ok';

  let baseUrl = null;
  const issuer = () => `${baseUrl}/as`;
  const mcpUrl = () => `${baseUrl}/mcp`;
  const resourceMetadataUrl = () => `${baseUrl}/.well-known/oauth-protected-resource`;

  // Returns the authenticated client_id, or null. The SDK sends confidential
  // credentials via HTTP Basic (RFC 6749 §2.3.1) when the AS advertises no
  // token_endpoint_auth_methods_supported, with client_id in the header —
  // NOT in the POST body — so both shapes are accepted here.
  const clientAuthOk = (req, params) => {
    const header = req.headers.authorization || '';
    const m = /^Basic (.+)$/.exec(header.trim());
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const id = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const secret = idx >= 0 ? decoded.slice(idx + 1) : '';
      if (id === PREREG_CLIENT_ID && secret === PREREG_CLIENT_SECRET) {
        counts.basicAuthUses += 1;
        return PREREG_CLIENT_ID;
      }
      return null;
    }
    if (params.get('client_id') === PREREG_CLIENT_ID && params.get('client_secret') === PREREG_CLIENT_SECRET) {
      counts.postSecretUses += 1;
      return PREREG_CLIENT_ID;
    }
    return null;
  };

  const validBearer = (req) => {
    const m = /^Bearer (.+)$/.exec((req.headers.authorization || '').trim());
    if (!m) return false;
    const rec = accessTokens.get(m[1]);
    return Boolean(rec && !rec.revoked);
  };

  const TOOLS = [
    {
      name: 'list_items',
      description: 'List items (read-only).',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'create_item',
      description: 'Create an item.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      annotations: { destructiveHint: false }
    }
  ];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      // ---- MCP endpoint: anonymous discovery, gated execution ----
      if (url.pathname === '/mcp') {
        if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
        let msg = null;
        try { msg = JSON.parse(await readBody(req) || 'null'); } catch { /* fall through */ }
        if (!msg || typeof msg !== 'object') { sendJson(res, 400, { error: 'bad_request' }); return; }
        if (msg.method === 'notifications/initialized' || msg.notification) {
          res.writeHead(202); res.end(); return;
        }
        const id = msg.id ?? null;
        if (msg.method === 'initialize') {
          sendJson(res, 200, {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'NoRegServer', version: 'test' }
            }
          });
          return;
        }
        if (msg.method === 'tools/list') {
          if (!validBearer(req)) {
            counts.anonymousDiscovers += 1;
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
            return;
          }
          if (authedDiscoveryMode === 'quirk403') {
            sendJson(res, 403, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
            return;
          }
          if (authedDiscoveryMode === 'broken500') {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('internal error');
            return;
          }
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
          return;
        }
        if (msg.method === 'tools/call') {
          if (!validBearer(req)) {
            counts.gatedCalls += 1;
            sendJson(res, 401, {
              jsonrpc: '2.0', id,
              result: {
                content: [{ type: 'text', text: 'Request is missing required authentication credential.' }],
                isError: true
              }
            }, { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}/tools_call"` });
            return;
          }
          const toolName = msg.params?.name || 'tool';
          sendJson(res, 200, {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: `ok:${toolName}` }] }
          });
          return;
        }
        sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
        return;
      }

      // ---- Protected resource metadata ----
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        sendJson(res, 200, {
          resource: mcpUrl(),
          authorization_servers: [issuer()],
          scopes_supported: ['items.read', 'items.write'],
          bearer_methods_supported: ['header']
        });
        return;
      }

      // ---- AS metadata: NO registration_endpoint, NO CIMD flag ----
      if (url.pathname === '/.well-known/oauth-authorization-server/as' ||
          url.pathname === '/as/.well-known/oauth-authorization-server') {
        sendJson(res, 200, {
          issuer: issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['items.read', 'items.write'],
          authorization_response_iss_parameter_supported: true
        });
        return;
      }

      // ---- Authorization endpoint (pre-registered client only) ----
      if (url.pathname === '/as/authorize' && req.method === 'GET') {
        const clientId = url.searchParams.get('client_id');
        const redirectUri = url.searchParams.get('redirect_uri');
        const responseType = url.searchParams.get('response_type');
        const state = url.searchParams.get('state');
        const challenge = url.searchParams.get('code_challenge');
        const challengeMethod = url.searchParams.get('code_challenge_method');
        const scope = url.searchParams.get('scope') || '';
        lastAuthorizeRequest = {
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: responseType,
          code_challenge_method: challengeMethod,
          scope,
          has_challenge: Boolean(challenge)
        };
        if (responseType !== 'code' || clientId !== PREREG_CLIENT_ID || !redirectUri ||
            !state || !challenge || challengeMethod !== 'S256') {
          sendJson(res, 400, { error: 'invalid_request' });
          return;
        }
        const code = `code_${rand(12)}`;
        codes.set(code, { redirect_uri: redirectUri, challenge, scope, used: false });
        counts.authorizeRedirects += 1;
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', state);
        back.searchParams.set('iss', issuer());
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }

      // ---- Token endpoint ----
      if (url.pathname === '/as/token' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req) || '');
        if (clientAuthOk(req, params) !== PREREG_CLIENT_ID) {
          sendJson(res, 401, { error: 'invalid_client' });
          return;
        }
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          const code = params.get('code');
          const rec = codes.get(code);
          const verifier = params.get('code_verifier') || '';
          const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
          // client_id travels in the Basic header for confidential clients, so
          // a body client_id is optional — but must match when present.
          const bodyId = params.get('client_id');
          if (!rec || rec.used || (bodyId && bodyId !== PREREG_CLIENT_ID) ||
              rec.redirect_uri !== params.get('redirect_uri') || expected !== rec.challenge) {
            sendJson(res, 400, { error: 'invalid_grant' });
            return;
          }
          rec.used = true;
          const at = `at_${rand(12)}`;
          const rt = `rt_${rand(12)}`;
          accessTokens.set(at, { revoked: false });
          refreshTokens.set(rt, {});
          counts.codeExchanges += 1;
          sendJson(res, 200, {
            access_token: at, refresh_token: rt, token_type: 'Bearer',
            expires_in: 3600, scope: rec.scope
          });
          return;
        }
        if (grant === 'refresh_token') {
          const rec = refreshTokens.get(params.get('refresh_token'));
          if (!rec) {
            sendJson(res, 400, { error: 'invalid_grant' });
            return;
          }
          refreshTokens.delete(params.get('refresh_token'));
          const at = `at_${rand(12)}`;
          const newRt = `rt_${rand(12)}`;
          accessTokens.set(at, { revoked: false });
          refreshTokens.set(newRt, {});
          counts.refreshes += 1;
          sendJson(res, 200, {
            access_token: at, refresh_token: newRt, token_type: 'Bearer',
            expires_in: 3600
          });
          return;
        }
        sendJson(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    mcpUrl: mcpUrl(),
    issuer: issuer(),
    resourceMetadataUrl: resourceMetadataUrl(),
    authorizeUrl: `${issuer()}/authorize`,
    tokenUrl: `${issuer()}/token`,
    preregClientId: PREREG_CLIENT_ID,
    preregClientSecret: PREREG_CLIENT_SECRET,
    counts,
    get lastAuthorizeRequest() { return lastAuthorizeRequest; },
    setAuthedDiscoveryMode: (mode) => { authedDiscoveryMode = mode; },
    revokeAccessToken: (token) => {
      const rec = accessTokens.get(token);
      if (rec) rec.revoked = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
};

module.exports = { createNoRegistrationFixtureServer };
