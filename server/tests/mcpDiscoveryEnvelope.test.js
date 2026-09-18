'use strict';

// MCP discovery envelope tolerance + discovery-state tests.
//
// Run:  cd server && node tests/mcpDiscoveryEnvelope.test.js
//
// A provider may answer tools/list with a non-2xx HTTP status while the body
// is a VALID JSON-RPC success envelope for that request. The generic rule:
// accept exactly those as discovery (tools/list only — executions never),
// pass everything else through untouched.
//
// DB-free: memory credential backend, REAL AES-256-GCM blobs, live local
// no-registration fixture with switchable authenticated-discovery modes.

process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'envelope-test-encryption-key';

const assert = require('assert');

const oauthTx = require('../lib/mcp/oauthTransactions');
const oauthProvider = require('../lib/mcp/oauthProvider');
const { McpServerConnection } = require('../lib/mcp/McpServerConnection');
const { McpManager } = require('../lib/mcp/McpManager');
const McpRegistry = require('../lib/mcp/McpRegistry');
const { createEnvelopeTolerantFetch } = require('../lib/mcp/transports/discoveryEnvelope');
const { createNoRegistrationFixtureServer } = require('./fixtures/mcp/noRegistrationServer');
const sdk = require('@modelcontextprotocol/client');

const passed = [];
const failed = [];

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed.push(name);
      console.log(`  ok - ${name}`);
    } catch (err) {
      failed.push({ name, err });
      console.error(`  FAIL - ${name}`);
      console.error(`         ${err && err.message}`);
    }
  })();
}

const TOOLS = [
  { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
  { name: 'beta', description: 'b', inputSchema: { type: 'object' } }
];
const envelope = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
const stubFetch = (status, body, contentType = 'application/json') =>
  async () => new Response(body, { status, headers: { 'content-type': contentType } });
const listReq = (id = 7) => ({ body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }) });
const callReq = (id = 9) => ({ body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'alpha', arguments: {} } }) });

const tolerated = [];
const wrap = (fetchFn) => createEnvelopeTolerantFetch({
  fetchFn, configId: 'cfg-env', slug: 'env',
  onTolerated: (info) => { tolerated.push(info); }
});

const baseConfig = (url, id, extra = {}) => ({
  id, name: `Env ${id}`, slug: `env_${id}`,
  ownerUserId: 'user1', scope: 'workspace', workspaceId: 'ws1',
  transport: 'streamable-http', url, auth: { type: 'oauth' },
  oauthScope: null, enabled: true, disabled: false, guestAllowed: false,
  allowedTools: [], deniedTools: [], ...extra
});

const preregConfig = (gx, id) => baseConfig(gx.mcpUrl, id, {
  registrationStrategy: 'pre_registered',
  oauthClientId: gx.preregClientId,
  oauthClientSecretEncrypted: oauthProvider.encryptClientSecret(gx.preregClientSecret)
});

const doFixtureAuth = async (gx, { userId, configId, config }) => {
  const tx = oauthTx.createTransaction({ userId, configId });
  let authorizationUrl = null;
  const startProvider = oauthProvider.createInteractiveProvider({
    userId, config, transaction: tx, onRedirect: async (u) => { authorizationUrl = u; }
  });
  assert.strictEqual(await sdk.auth(startProvider, { serverUrl: config.url }), 'REDIRECT', 'leg 1 redirect');
  const back = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location'));
  const consumed = oauthTx.consumeTransaction(oauthTx.txIdFromState(back.searchParams.get('state')));
  const leg2 = await sdk.auth(oauthProvider.createInteractiveProvider({
    userId, config, transaction: consumed, onRedirect: null
  }), {
    serverUrl: config.url, authorizationCode: back.searchParams.get('code'), iss: back.searchParams.get('iss')
  });
  assert.strictEqual(leg2, 'AUTHORIZED', 'leg 2 exchange');
};

const main = async () => {
  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const gx = await createNoRegistrationFixtureServer();

  await test('D1 200 + valid tools/list passes through untouched', async () => {
    tolerated.length = 0;
    const res = await wrap(stubFetch(200, envelope(7, { tools: TOOLS })))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 200, 'status preserved');
    const body = await res.json();
    assert.strictEqual(body.result.tools.length, 2, 'tools intact');
    assert.strictEqual(tolerated.length, 0, 'no tolerance event on 2xx');
  });

  await test('D2 403 + valid tools/list result is accepted as discovery', async () => {
    tolerated.length = 0;
    const res = await wrap(stubFetch(403, envelope(7, { tools: TOOLS })))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 200, 'rewritten to 200');
    assert.strictEqual(res.headers.get('content-type'), 'application/json', 'json content type');
    const body = await res.json();
    assert.strictEqual(body.result.tools.length, 2, 'tools parsed from tolerated envelope');
    assert.strictEqual(tolerated.length, 1, 'one tolerance event');
    assert.deepStrictEqual(
      Object.keys(tolerated[0]).sort(),
      ['configId', 'slug', 'toolCount', 'upstreamStatus'], 'diagnostic metadata only — no body/token/headers'
    );
    assert.strictEqual(tolerated[0].upstreamStatus, 403, 'upstream status recorded');
  });

  await test('D3 401 + JSON-RPC error passes through (auth pipeline preserved)', async () => {
    tolerated.length = 0;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'unauthorized' } });
    const res = await wrap(stubFetch(401, body))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 401, '401 preserved');
    assert.strictEqual(tolerated.length, 0, 'no tolerance for error envelopes');
  });

  await test('D4 403 + JSON-RPC error passes through (upstream failure)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'forbidden' } });
    const res = await wrap(stubFetch(403, body))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 403, '403 preserved');
    assert.strictEqual(await res.text(), body, 'body intact');
  });

  await test('D5 500 + malformed body passes through (discovery failure)', async () => {
    const res = await wrap(stubFetch(500, 'internal error', 'text/plain'))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 500, '500 preserved');
  });

  await test('D6 mismatched JSON-RPC id is rejected', async () => {
    const res = await wrap(stubFetch(403, envelope(999, { tools: TOOLS })))( 'http://x/mcp', listReq(7));
    assert.strictEqual(res.status, 403, 'id mismatch passes through');
  });

  await test('D7 malformed JSON-RPC version is rejected', async () => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 7, result: { tools: TOOLS } });
    const res = await wrap(stubFetch(403, body))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 403, 'bad version passes through');
  });

  await test('D8 invalid tools shape is rejected', async () => {
    for (const result of [{ tools: 'nope' }, { tools: [{ nodesc: 1 }] }, { tools: [{ name: '' }] }, {}]) {
      const res = await wrap(stubFetch(403, envelope(7, result)))( 'http://x/mcp', listReq());
      assert.strictEqual(res.status, 403, `rejected: ${JSON.stringify(result).slice(0, 40)}`);
    }
    assert.strictEqual(tolerated.length, 0, 'never tolerated');
  });

  await test('D9 executions are never rewritten (tools/call passthrough)', async () => {
    const body = envelope(9, { content: [{ type: 'text', text: 'x' }] });
    const res = await wrap(stubFetch(403, body))( 'http://x/mcp', callReq());
    assert.strictEqual(res.status, 403, 'tool execution failure preserved');
  });

  await test('D10 non-discovery methods pass through (initialize)', async () => {
    const req = { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) };
    const res = await wrap(stubFetch(400, envelope(1, { capabilities: {} })))( 'http://x/mcp', req);
    assert.strictEqual(res.status, 400, 'initialize untouched');
  });

  await test('D11 SSE content-type is normalized on rewrite', async () => {
    const res = await wrap(stubFetch(403, envelope(7, { tools: TOOLS }), 'text/event-stream'))( 'http://x/mcp', listReq());
    assert.strictEqual(res.status, 200, 'rewritten');
    assert.strictEqual(res.headers.get('content-type'), 'application/json', 'normalized for the SDK parser');
  });

  await test('D12 batch requests pass through conservatively', async () => {
    const req = { body: JSON.stringify([{ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }]) };
    const res = await wrap(stubFetch(403, envelope(7, { tools: TOOLS })))( 'http://x/mcp', req);
    assert.strictEqual(res.status, 403, 'arrays untouched');
  });

  await test('D13 tolerance diagnostics never break the transport', async () => {
    const strict = createEnvelopeTolerantFetch({
      fetchFn: stubFetch(403, envelope(7, { tools: TOOLS })),
      onTolerated: () => { throw new Error('diag boom'); }
    });
    const res = await strict('http://x/mcp', listReq());
    assert.strictEqual(res.status, 200, 'rewrite survives diagnostic failure');
  });

  await test('D14 discovery failure classification: auth vs upstream', async () => {
    const oauthCfg = baseConfig('https://mcp.example/mcp', 'cfg-d14');
    const conn = new McpServerConnection(oauthCfg, {});
    conn._client = { listTools: async () => { throw { name: 'UnauthorizedError', message: 'nope' }; } };
    await conn._discoverTools();
    assert.strictEqual(conn.discoveryStatus, 'failed', 'status failed');
    assert.strictEqual(conn.discoveryAuthRequired, true, 'genuine 401 flags auth-required');
    assert.ok(conn.tools.length === 0, 'no tools');

    const conn403 = new McpServerConnection(oauthCfg, {});
    conn403._client = { listTools: async () => { const e = new Error('Error POSTing to endpoint: x'); e.status = 403; throw e; } };
    await conn403._discoverTools();
    assert.strictEqual(conn403.discoveryStatus, 'failed', 'status failed');
    assert.strictEqual(conn403.discoveryAuthRequired, false, 'upstream 403 never flags auth-required');

    const staticCfg = { ...oauthCfg, id: 'cfg-d14s', auth: { type: 'header' } };
    const connStatic = new McpServerConnection(staticCfg, {});
    connStatic._client = { listTools: async () => { throw { name: 'UnauthorizedError', message: 'nope' }; } };
    await connStatic._discoverTools();
    assert.strictEqual(connStatic.discoveryAuthRequired, false, 'static configs never flag auth-required');
  });

  await test('D15 discovery error message truncated (no body retention)', async () => {
    const conn = new McpServerConnection(baseConfig('https://mcp.example/mcp', 'cfg-d15'), {});
    conn._client = { listTools: async () => { throw new Error('x'.repeat(5000)); } };
    await conn._discoverTools();
    assert.ok(conn.lastDiscoveryError && conn.lastDiscoveryError.length <= 300, 'truncated diagnostic');
  });

  await test('D16 quirk 403: authenticated reconnect restores tools + registry', async () => {
    gx.setAuthedDiscoveryMode('quirk403');
    try {
      await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-d16', config: preregConfig(gx, 'cfg-d16') });
      const registry = new McpRegistry();
      const manager = new McpManager({ registry });
      const config = baseConfig(gx.mcpUrl, 'cfg-d16');
      registry.register({ ...config, tools: [] });
      const conn = await manager.ensureConnected(config, {
        authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config })
      });
      assert.ok(conn.connected, 'transport connected');
      assert.strictEqual(conn.discoveryStatus, 'ok', 'envelope accepted as discovery');
      assert.strictEqual(conn.tools.length, 2, 'tools restored despite upstream 403');
      assert.strictEqual(registry.toolCount(config.id), 2, 'registry populated');
      await manager.shutdown();
    } finally {
      gx.setAuthedDiscoveryMode('ok');
    }
  });

  await test('D17 genuine discovery failure: state, no auth loop, credential kept', async () => {
    gx.setAuthedDiscoveryMode('broken500');
    try {
      await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-d17', config: preregConfig(gx, 'cfg-d17') });
      assert.strictEqual(oauthTx._store.size, 0, 'precondition: no pending transactions');
      const config = baseConfig(gx.mcpUrl, 'cfg-d17');
      const conn = new McpServerConnection(config, {});
      await conn.connect({
        authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config }),
        timeoutMs: 20000
      });
      assert.ok(conn.connected, 'transport connected');
      assert.strictEqual(conn.tools.length, 0, 'no tools');
      assert.strictEqual(conn.discoveryStatus, 'failed', 'discovery failed recorded');
      assert.strictEqual(conn.discoveryAuthRequired, false, 'no spurious auth-required');
      assert.strictEqual(oauthTx._store.size, 0, 'no browser OAuth launched');
      const status = await oauthProvider.credentialStatus('user1', 'cfg-d17');
      assert.strictEqual(status.authorized, true, 'stored credential NOT marked invalid');
      await conn.disconnect();
    } finally {
      gx.setAuthedDiscoveryMode('ok');
    }
  });

  await test('D18 retry after failure restores READY without re-authorizing', async () => {
    gx.setAuthedDiscoveryMode('broken500');
    const config = baseConfig(gx.mcpUrl, 'cfg-d18');
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    registry.register({ ...config, tools: [] });
    const silent = () => oauthProvider.createSilentProvider({ userId: 'user1', config });
    try {
      await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-d18', config: preregConfig(gx, 'cfg-d18') });
      const first = await manager.ensureConnected(config, { authProvider: silent() });
      assert.strictEqual(first.discoveryStatus, 'failed', 'first attempt fails discovery');
      // Retry mirrors the refresh route: drop + reconnect with the STORED
      // credential (no browser flow).
      gx.setAuthedDiscoveryMode('ok');
      await manager.disconnect(config.id);
      const second = await manager.ensureConnected(config, { authProvider: silent() });
      assert.strictEqual(second.discoveryStatus, 'ok', 'retry discovers');
      assert.strictEqual(second.tools.length, 2, 'tools restored');
      assert.strictEqual(oauthTx._store.size, 0, 'retry never touched browser OAuth');
      await manager.shutdown();
    } finally {
      gx.setAuthedDiscoveryMode('ok');
    }
  });

  await gx.close();

  console.log(`\nMCP discovery envelope: ${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => {
  console.error('ENVELOPE SUITE CRASH:', err);
  process.exit(1);
});
