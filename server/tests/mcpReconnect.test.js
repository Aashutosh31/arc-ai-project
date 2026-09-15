'use strict';

// MCP OAuth reconnect-consistency regression tests.
//
// Run:  cd server && node tests/mcpReconnect.test.js
//
// Gap closed here: every AUTOMATIC reconnect path (agent schema supply,
// continuation schemas, execution fallback) called ensureConnected() WITHOUT
// the silent OAuth provider — so after a backend restart (stored OAuth
// credentials survive, live connections do not) the agent 401'd before any
// tool could be used. /connect and /refresh already passed the provider;
// these paths now share the same behavior via silentProviderForConfig.
// Static/header/stdio configs are untouched (null provider passthrough).
// Nothing here initiates interactive OAuth.
//
// DB-free: OAuth fixture server + memory credential backend (same harness
// as mcpOAuth.test.js). Names/counts only in output — no tokens.

process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'reconnect-test-encryption-key-only';

const assert = require('assert');
const { McpManager } = require('../lib/mcp/McpManager');
const McpRegistry = require('../lib/mcp/McpRegistry');
const { McpToolSource } = require('../lib/mcp');
const oauthProvider = require('../lib/mcp/oauthProvider');
const oauthTx = require('../lib/mcp/oauthTransactions');
const { createOAuthFixtureServer } = require('./fixtures/mcp/oauthServer');
const { createHttpFixtureServer } = require('./fixtures/mcp/httpServer');
const sdk = require('@modelcontextprotocol/client');

const passed = [];
const failed = [];
function test(name, fn) {
  return (async () => {
    try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
    catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
  })();
}

const oauthDoc = (fx, id) => ({
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

// Full interactive authorization against the fixture (stores encrypted
// tokens in the memory backend for user1/configId).
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

// Isolated McpToolSource: injected manager+registry, seeded with one OAuth
// config, NO live connection (post-restart shape).
const isolatedSource = (fx, id) => {
  const registry = new McpRegistry();
  const manager = new McpManager({ registry });
  const { docToConfig } = require('../lib/mcp/configStore');
  registry.register(docToConfig(oauthDoc(fx, id)));
  McpToolSource.init({ manager, registry });
  return { registry, manager };
};

const main = async () => {
  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const fx = await createOAuthFixtureServer();

  await test('CON-01 agent schema supply reconnects silently with stored credentials', async () => {
    const id = 'cfg_recon_agent';
    await doFullAuth(fx, { configId: id });
    isolatedSource(fx, id);
    try {
      const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws1', isGuest: false, userId: 'user1' });
      assert.ok(pick.schemas.length > 0, `expected discovered schemas, got failures=${JSON.stringify(pick.failures)}`);
      const names = pick.schemas.map((s) => s?.function?.name).filter(Boolean);
      assert.ok(names.every((n) => n.startsWith('mcp_')), 'wire names only');
      console.log(`         discovered ${names.length} schemas via automatic reconnect`);
    } finally {
      await McpToolSource.shutdown().catch(() => {});
    }
  });

  await test('CON-02 schema supply without userId degrades without connecting', async () => {
    const id = 'cfg_recon_nouser';
    await doFullAuth(fx, { configId: id });
    isolatedSource(fx, id);
    try {
      const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws1', isGuest: false });
      assert.strictEqual(pick.schemas.length, 0, 'no silent provider, no schemas');
      assert.ok(pick.failures.length > 0, 'failure recorded (old behavior preserved)');
    } finally {
      await McpToolSource.shutdown().catch(() => {});
    }
  });

  await test('CON-03 expired access token recovers via refresh on the agent path', async () => {
    const id = 'cfg_recon_refresh';
    await doFullAuth(fx, { configId: id });
    const before = await oauthProvider.loadTokens('user1', id, fx.issuer);
    fx.revokeAccessToken(before.access_token);
    const refreshes = fx.counts.refreshes;
    isolatedSource(fx, id);
    try {
      const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws1', isGuest: false, userId: 'user1' });
      assert.ok(pick.schemas.length > 0, `expected recovery, got ${JSON.stringify(pick.failures)}`);
      assert.strictEqual(fx.counts.refreshes, refreshes + 1, 'exactly one refresh');
    } finally {
      await McpToolSource.shutdown().catch(() => {});
    }
  });

  await test('CON-04 refresh failure classifies auth_required (UI path takes over)', async () => {
    const id = 'cfg_recon_badrefresh';
    await doFullAuth(fx, { configId: id });
    const current = await oauthProvider.loadTokens('user1', id, fx.issuer);
    fx.revokeAccessToken(current.access_token);
    await oauthProvider.saveTokens('user1', id,
      { ...current, refresh_token: 'rt_invalid_poisoned', expires_at: Math.floor(Date.now() / 1000) - 100 },
      { issuer: fx.issuer }
    );
    isolatedSource(fx, id);
    try {
      const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws1', isGuest: false, userId: 'user1' });
      assert.strictEqual(pick.schemas.length, 0, 'no schemas on dead credentials');
      // Direct classification proof: the underlying failure is authRequired,
      // which routes surface as 401 + authorize (never silent garbage).
      const { manager } = isolatedSource(fx, id);
      const { docToConfig } = require('../lib/mcp/configStore');
      let err = null;
      try {
        await manager.ensureConnected(docToConfig(oauthDoc(fx, id)), {
          authProvider: oauthProvider.silentProviderForConfig(docToConfig(oauthDoc(fx, id)), 'user1')
        });
      } catch (e) { err = e; }
      assert.ok(err && err.authRequired === true, `expected authRequired, got ${err?.name}`);
      await manager.shutdown().catch(() => {});
    } finally {
      await McpToolSource.shutdown().catch(() => {});
    }
  });

  await test('CON-05 static config regression (no provider, unchanged behavior)', async () => {
    const holder = await createHttpFixtureServer(() => {});
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    const { docToConfig } = require('../lib/mcp/configStore');
    registry.register(docToConfig({
      _id: 'cfg_recon_static', name: 'static', slug: 'static',
      owner: 'user1', scope: 'workspace', workspace: 'ws1',
      transport: 'streamable-http', url: `http://127.0.0.1:${holder.port}/mcp`,
      auth: { type: 'none' }, enabled: true, allowedTools: [], deniedTools: []
    }));
    McpToolSource.init({ manager, registry });
    try {
      // No userId at all: static path must not need one.
      const pick = await McpToolSource.schemasForRequest({ workspaceId: 'ws1', isGuest: false });
      assert.ok(pick.schemas.length > 0, `static discovery intact, failures=${JSON.stringify(pick.failures)}`);
    } finally {
      await McpToolSource.shutdown().catch(() => {});
      await holder.close();
    }
  });

  await test('CON-06 execution fallback resolves + executes with userId, absent connection', async () => {
    const id = 'cfg_recon_exec';
    await doFullAuth(fx, { configId: id });
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    const { docToConfig } = require('../lib/mcp/configStore');
    const cfg = docToConfig(oauthDoc(fx, id));
    registry.register(cfg);
    try {
      assert.strictEqual(manager.getConnection(id), null, 'precondition: no live connection');
      const resolved = await manager.resolveTool(
        (await (async () => {
          const c = await manager.ensureConnected(cfg, {
            authProvider: oauthProvider.silentProviderForConfig(cfg, 'user1')
          });
          const n = c.tools.map((t) => t?.function?.name).find((n) => n && n.endsWith('_echo'));
          await manager.disconnect(id);
          return n;
        })()),
        { workspaceId: 'ws1', isGuest: false, userId: 'user1' }
      );
      assert.ok(resolved && resolved.schema, 'tool resolves through automatic reconnect');
      const out = await resolved.execute({ text: 'hello-reconnect' }, { userId: 'user1', workspaceId: 'ws1' }, null);
      assert.ok(out && out.success !== false, `execution failed: ${JSON.stringify(out).slice(0, 200)}`);
    } finally {
      await manager.shutdown().catch(() => {});
    }
  });

  try { await fx.close(); } catch { /* best effort */ }
  oauthProvider.__resetCredentialBackend();
  McpToolSource.shutdown().catch(() => {});
  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => { console.error('Harness error:', err); process.exit(1); });
