'use strict';

// OAuth-capable MCP integration fixture (tests only — NEVER exposed publicly).
//
// A local HTTP server on 127.0.0.1 with an ephemeral port implementing:
//  - OAuth 2.0 Protected Resource Metadata (RFC 9728)
//  - Authorization Server Metadata (RFC 8414)
//  - Dynamic Client Registration (RFC 7591) — backwards-compat path
//  - Authorization endpoint (code + PKCE S256 + `iss` echo per RFC 9207)
//  - Token endpoint (authorization_code exchange + refresh_token rotation)
//  - A real Streamable HTTP MCP endpoint (official @modelcontextprotocol/server
//    handler) gated by bearer tokens: missing/invalid/revoked → 401 with a
//    `WWW-Authenticate` challenge carrying `resource_metadata`
//  - A static Client ID Metadata Document (served for CIMD unit reference)
//
// Run:  cd server && node tests/mcpOAuth.test.js
//
// Usage:
//   const { createOAuthFixtureServer } = require('./fixtures/mcp/oauthServer');
//   const fx = await createOAuthFixtureServer();
//   // fx.mcpUrl, fx.issuer, fx.authorizeUrl, fx.tokenUrl, fx.registrationUrl ...
//   await fx.close();

const http = require('node:http');
const crypto = require('node:crypto');
const { createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { createFixtureServer } = require('./testMcpServer');

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

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

const createOAuthFixtureServer = async () => {
  const clients = new Map(); // client_id → { redirect_uris, ... }
  const codes = new Map(); // code → { client_id, redirect_uri, challenge, scope, used }
  const accessTokens = new Map(); // token → { scope, revoked }
  const refreshTokens = new Map(); // token → { scope }
  const counts = { registrations: 0, authorizeRedirects: 0, codeExchanges: 0, refreshes: 0, mcpCalls: 0, unauthorized: 0 };
  let lastAuthorizeRequest = null;

  const mcpHandler = createMcpHandler(createFixtureServer);
  const mcpNodeHandler = toNodeHandler(mcpHandler);

  let baseUrl = null;
  const issuer = () => `${baseUrl}/as`;
  const mcpUrl = () => `${baseUrl}/mcp`;
  const resourceMetadataUrl = () => `${baseUrl}/.well-known/oauth-protected-resource`;

  const validBearer = (req) => {
    const header = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(header.trim());
    if (!m) return false;
    const rec = accessTokens.get(m[1]);
    return Boolean(rec && !rec.revoked);
  };

  const unauthorized = (res) => {
    counts.unauthorized += 1;
    sendJson(res, 401, { error: 'authorization required' }, {
      'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}", scope="tools:read tools:write"`
    });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      // ---- MCP endpoint (bearer-gated) ----
      if (url.pathname === '/mcp') {
        counts.mcpCalls += 1;
        if (!validBearer(req)) {
          unauthorized(res);
          return;
        }
        await mcpNodeHandler(req, res);
        return;
      }

      // ---- Protected resource metadata (any suffix variant → same doc) ----
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        sendJson(res, 200, {
          resource: mcpUrl(),
          authorization_servers: [issuer()],
          scopes_supported: ['tools:read', 'tools:write'],
          bearer_methods_supported: ['header']
        });
        return;
      }

      // ---- Authorization server metadata (RFC 8414 path-inserted form) ----
      if (url.pathname === '/.well-known/oauth-authorization-server/as' ||
          url.pathname === '/as/.well-known/oauth-authorization-server') {
        sendJson(res, 200, {
          issuer: issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          registration_endpoint: `${issuer()}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['tools:read', 'tools:write'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true
        });
        return;
      }

      // ---- Dynamic client registration ----
      if (url.pathname === '/as/register' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const clientId = `fixture-client-${rand(8)}`;
        clients.set(clientId, {
          redirect_uris: body.redirect_uris || [],
          client_name: body.client_name || null,
          grant_types: body.grant_types || ['authorization_code', 'refresh_token']
        });
        counts.registrations += 1;
        sendJson(res, 201, {
          client_id: clientId,
          redirect_uris: body.redirect_uris || [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        });
        return;
      }

      // ---- Authorization endpoint ----
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
        const reg = clients.get(clientId);
        if (responseType !== 'code' || !reg || !redirectUri || !state || !challenge || challengeMethod !== 'S256') {
          sendJson(res, 400, { error: 'invalid_request' });
          return;
        }
        const code = `code_${rand(16)}`;
        codes.set(code, { client_id: clientId, redirect_uri: redirectUri, challenge, scope, used: false });
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
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          const code = params.get('code');
          const rec = codes.get(code);
          const verifier = params.get('code_verifier') || '';
          const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
          if (!rec || rec.used || rec.client_id !== params.get('client_id') ||
              rec.redirect_uri !== params.get('redirect_uri') || expected !== rec.challenge) {
            sendJson(res, 400, { error: 'invalid_grant' });
            return;
          }
          rec.used = true;
          const at = `at_${rand(16)}`;
          const rt = `rt_${rand(16)}`;
          accessTokens.set(at, { scope: rec.scope, revoked: false });
          refreshTokens.set(rt, { scope: rec.scope });
          counts.codeExchanges += 1;
          sendJson(res, 200, {
            access_token: at,
            refresh_token: rt,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: rec.scope
          });
          return;
        }
        if (grant === 'refresh_token') {
          const rt = params.get('refresh_token');
          const rec = refreshTokens.get(rt);
          if (!rec) {
            sendJson(res, 400, { error: 'invalid_grant' });
            return;
          }
          refreshTokens.delete(rt); // rotation
          const at = `at_${rand(16)}`;
          const newRt = `rt_${rand(16)}`;
          accessTokens.set(at, { scope: rec.scope, revoked: false });
          refreshTokens.set(newRt, { scope: rec.scope });
          counts.refreshes += 1;
          sendJson(res, 200, {
            access_token: at,
            refresh_token: newRt,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: rec.scope
          });
          return;
        }
        sendJson(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      // ---- Static Client ID Metadata Document (CIMD reference) ----
      if (url.pathname === '/cimd/client.json') {
        sendJson(res, 200, {
          client_name: 'ARC MCP Client (fixture CIMD)',
          redirect_uris: [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        });
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
    registrationUrl: `${issuer()}/register`,
    counts,
    get lastAuthorizeRequest() { return lastAuthorizeRequest; },
    revokeAccessToken: (token) => {
      const rec = accessTokens.get(token);
      if (rec) rec.revoked = true;
    },
    hasRefreshToken: (token) => refreshTokens.has(token),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
};

module.exports = { createOAuthFixtureServer };
