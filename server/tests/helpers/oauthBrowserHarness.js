'use strict';

// Test-only orchestrator for the real-browser OAuth QA.
//
// Flow: starts the OAuth fixture → runs SDK leg 1 → prints the browser
// authorization URL → waits for the browser to complete the provider leg →
// finishes validation + exchange + MCP connect + tool call on /finish.
//
// Nothing here is exposed publicly; used by
// client/tests/qa/test_mcp_oauth_browser.py with real Chromium.

const http = require('node:http');

const CONTROL_PORT = Number(process.env.OAUTH_HARNESS_PORT || 45991);

const main = async () => {
  process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'browser-qa-key-only';
  const callbackBase = process.env.PUBLIC_BACKEND_URL;
  if (!callbackBase) {
    console.error('PUBLIC_BACKEND_URL must be set to the QA recorder origin.');
    process.exit(1);
  }

  const { createOAuthFixtureServer } = require('../fixtures/mcp/oauthServer');
  const oauthTx = require('../../lib/mcp/oauthTransactions');
  const oauthProvider = require('../../lib/mcp/oauthProvider');
  const { McpServerConnection } = require('../../lib/mcp/McpServerConnection');
  const { auth: sdkAuth } = require('@modelcontextprotocol/client');

  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const fx = await createOAuthFixtureServer();

  const userId = 'user-browser-qa';
  const configId = 'cfg-browser-qa';
  const config = {
    id: configId, name: 'Browser QA', slug: 'browser_qa',
    transport: 'streamable-http', url: fx.mcpUrl, auth: { type: 'oauth' },
    enabled: true, disabled: false, allowedTools: [], deniedTools: []
  };

  const tx = oauthTx.createTransaction({ userId, configId });
  let authorizationUrl = null;
  const startProvider = oauthProvider.createInteractiveProvider({
    userId, config, transaction: tx,
    onRedirect: async (u) => { authorizationUrl = u; }
  });
  const leg1 = await sdkAuth(startProvider, { serverUrl: fx.mcpUrl });
  if (leg1 !== 'REDIRECT' || !authorizationUrl) {
    console.error('leg 1 did not produce an authorization URL');
    process.exit(1);
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/finish') {
        const { code, state, iss } = JSON.parse(await readBody(req) || '{}');
        const out = { ok: false };
        const txId = oauthTx.txIdFromState(state);
        const loaded = txId ? oauthTx.getTransaction(txId) : null;
        out.stateValid = Boolean(loaded) && oauthTx.statesEqual(state, loaded.state);
        out.issuerValid = Boolean(loaded) && oauthTx.issuerMatches(loaded, iss);
        if (!out.stateValid || !out.issuerValid || !code) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
          return;
        }
        const consumed = oauthTx.consumeTransaction(txId);
        const cbProvider = oauthProvider.createInteractiveProvider({
          userId, config, transaction: consumed, onRedirect: null
        });
        out.leg2 = await sdkAuth(cbProvider, {
          serverUrl: fx.mcpUrl, authorizationCode: code, ...(iss ? { iss } : {})
        });
        const conn = new McpServerConnection(config, {});
        await conn.connect({
          authProvider: oauthProvider.createSilentProvider({ userId, config }),
          timeoutMs: 20000
        });
        out.connected = conn.connected;
        out.toolCount = conn.tools.length;
        const firstName = conn.toolEntries.keys().next().value;
        out.firstTool = firstName || null;
        if (firstName) {
          const raw = await conn.callTool(firstName, firstName.includes('echo') ? { text: 'browser-qa' } : {});
          out.toolResultType = raw && raw.content ? 'content' : typeof raw;
        }
        const status = await oauthProvider.credentialStatus(userId, configId);
        out.statusAuthorized = status.authorized === true;
        await conn.disconnect();
        out.ok = out.leg2 === 'AUTHORIZED' && out.connected && out.toolCount > 0 && out.statusAuthorized;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }));
    }
  });

  await new Promise((resolve) => server.listen(CONTROL_PORT, '127.0.0.1', resolve));
  // Machine-readable handshake for the Python driver (no secrets printed).
  console.log(JSON.stringify({
    ready: true,
    controlPort: CONTROL_PORT,
    fixturePort: fx.port,
    authorizationUrl,
    expectedIssuer: tx.issuer,
    txIdPrefix: 'mcp_oauth_'
  }));

  const shutdown = async () => {
    try { await fx.close(); } catch { /* noop */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Failsafe: never linger longer than the QA run.
  setTimeout(shutdown, 120000).unref();
};

main().catch((err) => { console.error(err); process.exit(1); });
