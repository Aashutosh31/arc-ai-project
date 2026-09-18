'use strict';

// MCP refresh-path regression tests.
//
// Run:  cd server && node tests/mcpRefresh.test.js
//
// Root cause pinned here: POST /servers/:id/refresh ran
// manager.ensureConnected(config) WITHOUT the silent OAuth provider that
// /connect, oauth/start (AUTHORIZED) and the OAuth callback all pass — so
// every refresh of an OAuth streamable-http server deterministically 401'd
// right after refresh's own disconnect(), surfacing as 502
// "Failed to refresh tools from MCP server." Meanwhile the UI kept showing
// the last-known tool count (client state) next to "Not connected"
// (live snapshot), plus "OAuth authorized" (DB credential status).
//
// DB-free: OAuth fixture server + memory credential backend, same as
// mcpOAuth.test.js. No tokens or secrets are logged (names/counts only).

process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'refresh-test-encryption-key-only';

const assert = require('assert');
const { McpManager } = require('../lib/mcp/McpManager');
const McpRegistry = require('../lib/mcp/McpRegistry');
const oauthProvider = require('../lib/mcp/oauthProvider');
const oauthTx = require('../lib/mcp/oauthTransactions');
const { connectForRefresh } = require('../routes/mcp');
const { createOAuthFixtureServer } = require('./fixtures/mcp/oauthServer');
const sdk = require('@modelcontextprotocol/client');

const passed = [];
const failed = [];
function test(name, fn) {
  return (async () => {
    try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
    catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
  })();
}

const docFor = (fx, id) => ({
  _id: id,
  name: `OAuth ${id}`,
  slug: `oauth_${id}`,
  owner: 'user1',
  scope: 'workspace',
  workspace: 'ws1',
  transport: 'streamable-http',
  url: fx.mcpUrl,
  auth: { type: 'oauth' },
  oauthScope: null,
  enabled: true,
  allowedTools: [],
  deniedTools: []
});
const fakeReq = { actor: { id: 'user1' } };

// Full interactive authorization against the fixture (mirrors the route
// flow). Stores encrypted tokens in the memory backend.
const doFullAuth = async (fx, { userId = 'user1', configId } = {}) => {
  const tx = oauthTx.createTransaction({ userId, configId, scope: null });
  let authorizationUrl = null;
  const startProvider = oauthProvider.createInteractiveProvider({
    userId,
    config: { id: configId, url: fx.mcpUrl, oauthScope: null },
    transaction: tx,
    onRedirect: async (u) => { authorizationUrl = u; }
  });
  assert.strictEqual(await sdk.auth(startProvider, { serverUrl: fx.mcpUrl }), 'REDIRECT');
  const redir = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.strictEqual(redir.status, 302);
  const back = new URL(redir.headers.get('location'));
  const consumed = oauthTx.consumeTransaction(oauthTx.txIdFromState(back.searchParams.get('state')));
  const cbProvider = oauthProvider.createInteractiveProvider({
    userId,
    config: { id: configId, url: fx.mcpUrl, oauthScope: null },
    transaction: consumed,
    onRedirect: null
  });
  assert.strictEqual(await sdk.auth(cbProvider, {
    serverUrl: fx.mcpUrl,
    authorizationCode: back.searchParams.get('code'),
    iss: back.searchParams.get('iss')
  }), 'AUTHORIZED');
};

const main = async () => {
  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const fx = await createOAuthFixtureServer();

  await test('REF-01 refresh-path connect succeeds with stored OAuth credentials', async () => {
    const id = 'cfg-refresh-ok';
    await doFullAuth(fx, { configId: id });
    const conn = await connectForRefresh(docFor(fx, id), fakeReq);
    assert.ok(conn.connected, 'must be connected');
    assert.ok(Array.isArray(conn.tools) && conn.tools.length > 0, 'must discover tools');
    const names = conn.tools.map((t) => t?.function?.name).filter(Boolean);
    assert.ok(names.every((n) => n.startsWith('mcp_')), `wire names expected, got ${names.slice(0, 3)}`);
    console.log(`         discovered ${names.length} tools (e.g. ${names.slice(0, 2).join(', ')})`);
    await require('../lib/mcp').McpToolSource.manager.disconnect(id).catch(() => {});
  });

  await test('REF-02 refresh-path connect without credentials fails closed with authRequired', async () => {
    let err = null;
    try {
      await connectForRefresh(docFor(fx, 'cfg-refresh-nocreds'), fakeReq);
    } catch (e) { err = e; }
    assert.ok(err, 'must reject');
    assert.ok(err.authRequired, `must flag authRequired (got name=${err?.name} category=${err?.category})`);
  });

  await test('REF-03 bare ensureConnected without provider 401s (the old refresh bug)', async () => {
    const id = 'cfg-refresh-bare';
    await doFullAuth(fx, { configId: id });
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    const { docToConfig } = require('../lib/mcp/configStore');
    let err = null;
    try {
      // Exactly what refreshTools used to do: no authProvider even though
      // stored credentials exist for this user/config.
      await manager.ensureConnected(docToConfig(docFor(fx, id)));
    } catch (e) { err = e; }
    assert.ok(err, 'must reject without a provider');
    assert.ok(err.authRequired, `must be authorization failure (got ${err?.name})`);
    await manager.shutdown().catch(() => {});
  });

  await test('REF-04 non-OAuth refresh path unchanged (null provider passthrough)', async () => {
    const { createHttpFixtureServer } = require('./fixtures/mcp/httpServer');
    const httpFx = await createHttpFixtureServer(() => {});
    const doc = {
      _id: 'cfg-refresh-plain', name: 'plain', slug: 'plain',
      owner: 'user1', scope: 'workspace', workspace: 'ws1',
      transport: 'streamable-http', url: `http://127.0.0.1:${httpFx.port}/mcp`,
      auth: { type: 'none' }, enabled: true, allowedTools: [], deniedTools: []
    };
    try {
      const conn = await connectForRefresh(doc, fakeReq);
      assert.ok(conn.connected && conn.tools.length > 0, 'plain refresh still connects');
    } finally {
      await require('../lib/mcp').McpToolSource.manager.disconnect('cfg-refresh-plain').catch(() => {});
      await httpFx.close();
    }
  });

  try { await fx.close(); } catch { /* best effort */ }
  oauthProvider.__resetCredentialBackend();
  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => { console.error('Harness error:', err); process.exit(1); });
