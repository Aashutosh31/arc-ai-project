'use strict';

// MCP Phase 3 — OAuth/authorization support tests.
//
// Run:  cd server && node tests/mcpOAuth.test.js
//
// DB-free by design: credential persistence runs against the memory backend
// with REAL AES-256-GCM blobs (same envelope as Mongo), and the OAuth +
// MCP wire runs against a live local fixture (no mocked OAuth except the
// CIMD strategy unit, which cannot use plain-http locally by spec).
//
// Covers the 30 mandatory Phase 3 items:
//   O3-01 401 classified as authorization-required (oauth) / unchanged (static)
//   O3-02 protected-resource metadata discovery
//   O3-03 authorization server discovery
//   O3-04 client registration strategy (DCR live)
//   O3-05 CIMD path where supported (SDK priority + env hook)
//   O3-06 DCR fallback path where required
//   O3-07 PKCE generation/storage
//   O3-08 state generation
//   O3-09 state mismatch rejection
//   O3-10 callback transaction expiry
//   O3-11 callback transaction single-use
//   O3-12 issuer mismatch rejection
//   O3-13 authorization-code exchange
//   O3-14 access-token storage (encrypted)
//   O3-15 refresh-token storage (encrypted)
//   O3-16 issuer preserved on save/load
//   O3-17 token refresh (revoked access token recovers via transport)
//   O3-18 expired access token recovery (no re-authorization)
//   O3-19 refresh failure → AUTH_REQUIRED (no crash, no loop)
//   O3-20 static bearer/header auth regression
//   O3-21 workspace/user credential isolation
//   O3-22 OAuth credential redaction (status + sanitize)
//   O3-23 no credential exposure through API shapes
//   O3-24 successful reconnect after authorization
//   O3-25 tool discovery after authorization
//   O3-26 MCP tool execution after OAuth
//   O3-27 disconnect keeps credentials (explicit forget removes)
//   O3-28 explicit "Forget authorization" removes stored credentials
//   O3-29 one user cannot use another user's MCP authorization
//   O3-30 guest cannot inherit authenticated user's MCP token

process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'phase3-test-encryption-key-only';

const assert = require('assert');

const oauthTx = require('../lib/mcp/oauthTransactions');
const oauthProvider = require('../lib/mcp/oauthProvider');
const secureTokens = require('../lib/mcp/secureTokens');
const { McpServerConnection } = require('../lib/mcp/McpServerConnection');
const { McpManager } = require('../lib/mcp/McpManager');
const McpRegistry = require('../lib/mcp/McpRegistry');
const { sanitizeConfigForClient, validateConfigInput } = require('../lib/mcp/configApi');
const { createOAuthFixtureServer } = require('./fixtures/mcp/oauthServer');
const { createHttpFixtureServer } = require('./fixtures/mcp/httpServer');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const oauthConfig = (fx, id) => ({
  id,
  name: `OAuth ${id}`,
  slug: `oauth_${id}`,
  ownerUserId: 'user1',
  scope: 'workspace',
  workspaceId: 'ws1',
  transport: 'streamable-http',
  url: fx.mcpUrl,
  auth: { type: 'oauth' },
  oauthScope: null,
  enabled: true,
  disabled: false,
  guestAllowed: false,
  allowedTools: [],
  deniedTools: []
});

// Full interactive authorization against the live fixture, mirroring the
// route flow: start tx → SDK leg 1 → browser redirect → validate → consume →
// SDK leg 2 (exchange). Returns { tx, consumed, code, state, iss }.
const doFullAuth = async (fx, { userId = 'user1', configId = 'cfg-auth', scope = null } = {}) => {
  const tx = oauthTx.createTransaction({ userId, configId, scope });
  let authorizationUrl = null;
  const startProvider = oauthProvider.createInteractiveProvider({
    userId,
    config: { id: configId, url: fx.mcpUrl, oauthScope: scope },
    transaction: tx,
    onRedirect: async (u) => { authorizationUrl = u; }
  });
  const leg1 = await sdk.auth(startProvider, { serverUrl: fx.mcpUrl, ...(scope ? { scope } : {}) });
  assert.strictEqual(leg1, 'REDIRECT', 'leg 1 must redirect to the authorization server');
  assert.ok(authorizationUrl, 'authorization URL captured');

  const redir = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.strictEqual(redir.status, 302, 'provider redirects back with a code');
  const back = new URL(redir.headers.get('location'));
  const code = back.searchParams.get('code');
  const state = back.searchParams.get('state');
  const iss = back.searchParams.get('iss');
  assert.ok(code && state, 'code + state returned');

  const txId = oauthTx.txIdFromState(state);
  const loaded = oauthTx.getTransaction(txId);
  assert.ok(loaded, 'transaction resolvable from state');
  assert.ok(oauthTx.statesEqual(state, loaded.state), 'state validates');
  assert.ok(oauthTx.issuerMatches(loaded, iss), 'issuer validates');
  const consumed = oauthTx.consumeTransaction(txId);
  assert.ok(consumed, 'transaction consumable');

  const cbProvider = oauthProvider.createInteractiveProvider({
    userId,
    config: { id: configId, url: fx.mcpUrl, oauthScope: scope },
    transaction: consumed,
    onRedirect: null
  });
  const leg2 = await sdk.auth(cbProvider, {
    serverUrl: fx.mcpUrl,
    authorizationCode: code,
    ...(iss ? { iss } : {}),
    ...(scope ? { scope } : {})
  });
  assert.strictEqual(leg2, 'AUTHORIZED', 'leg 2 exchanges the code');
  return { tx, consumed, code, state, iss, authorizationUrl };
};

const main = async () => {
  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const fx = await createOAuthFixtureServer();

  await test('O3-01 401 classified as authorization-required for oauth configs', async () => {
    assert.ok(oauthProvider.isOAuthAuthorizationRequired({ status: 401 }), 'raw 401');
    assert.ok(oauthProvider.isOAuthAuthorizationRequired({ name: 'UnauthorizedError' }), 'UnauthorizedError');
    assert.ok(
      oauthProvider.isOAuthAuthorizationRequired(new Error('Version negotiation failed: the server requires authorization')),
      'reference-server 401 message'
    );
    // A bare oauth-mode connect with no credentials must flag authRequired…
    const conn = new McpServerConnection(oauthConfig(fx, 'cfg-401'), {});
    let err = null;
    try {
      await conn.connect({ timeoutMs: 15000 });
    } catch (e) { err = e; }
    assert.ok(err, 'connect without credentials fails');
    assert.strictEqual(err.authRequired, true, 'failure flagged authRequired');
    // …while a static config keeps the legacy behavior (no flag).
    const plain = new McpServerConnection({
      ...oauthConfig(fx, 'cfg-401b'), auth: { type: 'none' }
    }, {});
    let err2 = null;
    try {
      await plain.connect({ timeoutMs: 15000 });
    } catch (e) { err2 = e; }
    assert.ok(err2, 'static connect to protected fixture fails');
    assert.strictEqual(err2.authRequired, undefined, 'no authRequired flag for static configs');
  });

  await test('O3-02 protected-resource metadata discovery', async () => {
    const meta = await sdk.discoverOAuthProtectedResourceMetadata(fx.mcpUrl);
    assert.ok(meta, 'metadata discovered');
    assert.strictEqual(meta.resource, fx.mcpUrl, 'resource matches the MCP endpoint');
    assert.ok(
      (meta.authorization_servers || []).includes(fx.issuer),
      'authorization server advertised'
    );
  });

  await test('O3-03 authorization server discovery', async () => {
    const info = await sdk.discoverOAuthServerInfo(fx.mcpUrl);
    assert.ok(info, 'server info discovered');
    assert.strictEqual(String(info.authorizationServerUrl), fx.issuer, 'AS url resolved');
    assert.strictEqual(info.authorizationServerMetadata?.issuer, fx.issuer, 'issuer echo valid');
    assert.ok(info.authorizationServerMetadata?.authorization_endpoint, 'authorize endpoint');
    assert.ok(info.authorizationServerMetadata?.token_endpoint, 'token endpoint');
    assert.ok(info.authorizationServerMetadata?.registration_endpoint, 'registration endpoint');
  });

  await test('O3-04 client registration strategy uses DCR against the fixture', async () => {
    const before = fx.counts.registrations;
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-reg' });
    assert.strictEqual(fx.counts.registrations, before + 1, 'exactly one DCR per authorization');
  });

  await test('O3-05 CIMD preferred where supported (strategy unit)', async () => {
    // The fixture advertises CIMD support; ARC exposes the metadata-document
    // hook via MCP_OAUTH_CLIENT_METADATA_URL (unset by default).
    const info = await sdk.discoverOAuthServerInfo(fx.mcpUrl);
    assert.strictEqual(
      info.authorizationServerMetadata?.client_id_metadata_document_supported, true,
      'fixture advertises CIMD support'
    );
    const prev = process.env.MCP_OAUTH_CLIENT_METADATA_URL;
    try {
      const bare = oauthProvider.createSilentProvider({
        userId: 'user1',
        config: { id: 'cfg-cimd', url: fx.mcpUrl, transport: 'streamable-http', auth: { type: 'oauth' } }
      });
      assert.strictEqual(bare.clientMetadataUrl, undefined, 'no CIMD url by default (DCR path)');
      process.env.MCP_OAUTH_CLIENT_METADATA_URL = 'https://auth.example.com/cimd/arc-client';
      const withCimd = oauthProvider.createSilentProvider({
        userId: 'user1',
        config: { id: 'cfg-cimd', url: fx.mcpUrl, transport: 'streamable-http', auth: { type: 'oauth' } }
      });
      assert.strictEqual(withCimd.clientMetadataUrl, 'https://auth.example.com/cimd/arc-client', 'env hook exposed');
      sdk.validateClientMetadataUrl(withCimd.clientMetadataUrl); // must not throw
      assert.throws(
        () => sdk.validateClientMetadataUrl('http://insecure.example.com/cimd/x'),
        /InvalidClientMetadata|https/i,
        'non-https CIMD url rejected'
      );
      // Strategy proof: stub fetch serves discovery; the SDK must use the
      // CIMD client_id and never touch the registration endpoint.
      let registrations = 0;
      let authorizeUrl = null;
      const stubFetch = async (url, init = {}) => {
        const u = String(url);
        if (u.includes('/.well-known/oauth-protected-resource')) {
          return Response.json({ resource: fx.mcpUrl, authorization_servers: ['https://as.example.com'] });
        }
        if (u.includes('/.well-known/oauth-authorization-server')) {
          return Response.json({
            issuer: 'https://as.example.com',
            authorization_endpoint: 'https://as.example.com/authorize',
            token_endpoint: 'https://as.example.com/token',
            registration_endpoint: 'https://as.example.com/register',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            client_id_metadata_document_supported: true
          });
        }
        if (u === 'https://as.example.com/register') {
          registrations += 1;
          return Response.json({ error: 'must not register on CIMD path' }, { status: 500 });
        }
        throw new Error(`unexpected fetch: ${u}`);
      };
      const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-cimd2' });
      const provider = oauthProvider.createInteractiveProvider({
        userId: 'user1',
        config: { id: 'cfg-cimd2', url: fx.mcpUrl },
        transaction: tx,
        onRedirect: async (u) => { authorizeUrl = u; }
      });
      const result = await sdk.auth(provider, { serverUrl: fx.mcpUrl, fetchFn: stubFetch });
      assert.strictEqual(result, 'REDIRECT', 'CIMD leg redirects');
      assert.strictEqual(registrations, 0, 'no DCR on the CIMD path');
      const clientId = new URL(authorizeUrl).searchParams.get('client_id');
      assert.strictEqual(clientId, 'https://auth.example.com/cimd/arc-client', 'CIMD url used as client_id');
      oauthTx.deleteTransaction(tx.txId);
    } finally {
      if (prev === undefined) delete process.env.MCP_OAUTH_CLIENT_METADATA_URL;
      else process.env.MCP_OAUTH_CLIENT_METADATA_URL = prev;
    }
  });

  await test('O3-06 DCR fallback where CIMD is unavailable', async () => {
    // No clientMetadataUrl configured → live fixture (DCR-only from ARC's
    // perspective) registers dynamically and persists the client.
    const before = fx.counts.registrations;
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-dcr' });
    assert.strictEqual(fx.counts.registrations, before + 1, 'DCR fallback registers');
    const info = await oauthProvider.loadClientInformation('user1', 'cfg-dcr', fx.issuer);
    assert.ok(info && info.client_id, 'registered client persisted with issuer binding');
    assert.strictEqual(info.issuer, fx.issuer, 'client issuer preserved');
  });

  await test('O3-07 PKCE generation/storage (S256, server-side only)', async () => {
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-pkce' });
    let authorizationUrl = null;
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1',
      config: { id: 'cfg-pkce', url: fx.mcpUrl },
      transaction: tx,
      onRedirect: async (u) => { authorizationUrl = u; }
    });
    const result = await sdk.auth(provider, { serverUrl: fx.mcpUrl });
    assert.strictEqual(result, 'REDIRECT');
    assert.ok(tx.codeVerifier && tx.codeVerifier.length >= 43, 'verifier stored on the transaction');
    assert.strictEqual(fx.lastAuthorizeRequest.code_challenge_method, 'S256', 'S256 challenge sent');
    assert.ok(fx.lastAuthorizeRequest.has_challenge, 'challenge present');
    assert.ok(!authorizationUrl.includes(tx.codeVerifier), 'verifier never in the authorize URL');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('O3-08 state generation binds the transaction', async () => {
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-state' });
    assert.ok(tx.state.startsWith(tx.txId + '.'), 'state embeds the tx id');
    assert.strictEqual(oauthTx.txIdFromState(tx.state), tx.txId, 'tx id extractable');
    assert.strictEqual(oauthTx.txIdFromState('garbage'), null, 'garbage state rejected');
    assert.strictEqual(oauthTx.txIdFromState('other_abc.def'), null, 'foreign prefix rejected');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('O3-09 state mismatch rejection', async () => {
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-state2' });
    assert.ok(oauthTx.statesEqual(tx.state, tx.state), 'matching state passes');
    assert.ok(!oauthTx.statesEqual(tx.state, tx.state + 'x'), 'tampered state fails');
    assert.ok(!oauthTx.statesEqual(tx.state, 'mcp_oauth_other.random'), 'foreign state fails');
    assert.ok(!oauthTx.statesEqual(null, tx.state), 'missing state fails');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('O3-10 callback transaction expiry', async () => {
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-exp', ttlMs: 20 });
    assert.ok(oauthTx.getTransaction(tx.txId), 'fresh transaction loads');
    await sleep(40);
    assert.strictEqual(oauthTx.getTransaction(tx.txId), null, 'expired transaction gone');
  });

  await test('O3-11 callback transaction single-use', async () => {
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-once' });
    const first = oauthTx.consumeTransaction(tx.txId);
    assert.ok(first, 'first consume works');
    assert.strictEqual(oauthTx.consumeTransaction(tx.txId), null, 'replay rejected');
    assert.strictEqual(oauthTx.getTransaction(tx.txId), null, 'consumed transaction gone');
  });

  await test('O3-12 issuer mismatch rejection (pre-check + SDK binding)', async () => {
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-iss' });
    tx.issuer = fx.issuer;
    assert.ok(oauthTx.issuerMatches(tx, fx.issuer), 'matching iss passes');
    assert.ok(!oauthTx.issuerMatches(tx, 'http://evil.example/as'), 'mismatched iss rejected');
    assert.ok(oauthTx.issuerMatches(tx, null), 'absent iss param passes (optional per RFC 9207)');
    oauthTx.deleteTransaction(tx.txId);
    // Live: the SDK enforces the SEP-2352 callback-leg binding as well.
    const { consumed } = await (async () => {
      const t = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-iss2' });
      let authorizationUrl = null;
      const p = oauthProvider.createInteractiveProvider({
        userId: 'user1',
        config: { id: 'cfg-iss2', url: fx.mcpUrl },
        transaction: t,
        onRedirect: async (u) => { authorizationUrl = u; }
      });
      assert.strictEqual(await sdk.auth(p, { serverUrl: fx.mcpUrl }), 'REDIRECT');
      const redir = await fetch(authorizationUrl, { redirect: 'manual' });
      const back = new URL(redir.headers.get('location'));
      const c = oauthTx.consumeTransaction(oauthTx.txIdFromState(back.searchParams.get('state')));
      return { consumed: c, code: back.searchParams.get('code') };
    })();
    const evil = oauthProvider.createInteractiveProvider({
      userId: 'user1',
      config: { id: 'cfg-iss2', url: fx.mcpUrl },
      transaction: consumed,
      onRedirect: null
    });
    let err = null;
    try {
      await sdk.auth(evil, {
        serverUrl: fx.mcpUrl,
        authorizationCode: 'code_will_not_validate',
        iss: 'http://evil.example/as'
      });
    } catch (e) { err = e; }
    assert.ok(err, 'mismatched issuer rejected by the SDK binding');
    assert.ok(/mismatch|issuer/i.test(err.name + ' ' + err.message), 'mismatch error surfaced');
  });

  await test('O3-13 authorization-code exchange succeeds', async () => {
    const before = fx.counts.codeExchanges;
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-exchange' });
    assert.strictEqual(fx.counts.codeExchanges, before + 1, 'code exchanged exactly once');
  });

  await test('O3-14 access-token storage is encrypted server-side', async () => {
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-store' });
    const tokens = await oauthProvider.loadTokens('user1', 'cfg-store', fx.issuer);
    assert.ok(tokens && tokens.access_token, 'access token loadable server-side');
    assert.strictEqual(tokens.issuer, fx.issuer, 'issuer stamp preserved');
    // The persisted blob must not contain the plaintext token.
    const raw = await oauthProvider.__readRawBlob('user1', 'cfg-store', fx.issuer);
    assert.ok(raw && typeof raw === 'string', 'raw blob persisted');
    assert.ok(!raw.includes(tokens.access_token), 'blob is encrypted (no plaintext access token)');
    assert.ok(!raw.includes(tokens.refresh_token), 'blob is encrypted (no plaintext refresh token)');
  });

  await test('O3-15 refresh-token storage is encrypted server-side', async () => {
    const tokens = await oauthProvider.loadTokens('user1', 'cfg-store', fx.issuer);
    assert.ok(tokens && tokens.refresh_token, 'refresh token persisted');
  });

  await test('O3-16 issuer preserved on save/load (client + tokens)', async () => {
    const tokens = await oauthProvider.loadTokens('user1', 'cfg-store', fx.issuer);
    const info = await oauthProvider.loadClientInformation('user1', 'cfg-store', fx.issuer);
    assert.strictEqual(tokens.issuer, fx.issuer, 'token issuer preserved');
    assert.strictEqual(info.issuer, fx.issuer, 'client issuer preserved');
    assert.strictEqual(await oauthProvider.loadTokens('user1', 'cfg-store', 'http://other.example/as'), undefined, 'wrong issuer loads nothing');
  });

  await test('O3-17 token refresh recovers a revoked access token', async () => {
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-refresh' });
    const before = await oauthProvider.loadTokens('user1', 'cfg-refresh', fx.issuer);
    fx.revokeAccessToken(before.access_token); // simulate server-side expiry
    const refreshes = fx.counts.refreshes;
    const conn = new McpServerConnection(oauthConfig(fx, 'cfg-refresh'), {});
    const silent = oauthProvider.createSilentProvider({ userId: 'user1', config: oauthConfig(fx, 'cfg-refresh') });
    await conn.connect({ authProvider: silent, timeoutMs: 20000 });
    assert.ok(conn.connected, 'transport refreshed and retried successfully');
    assert.strictEqual(fx.counts.refreshes, refreshes + 1, 'exactly one refresh performed');
    const after = await oauthProvider.loadTokens('user1', 'cfg-refresh', fx.issuer);
    assert.ok(after && after.access_token !== before.access_token, 'rotated token persisted');
    await conn.disconnect();
  });

  await test('O3-18 expired access token recovers without re-authorization', async () => {
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-expired' });
    const current = await oauthProvider.loadTokens('user1', 'cfg-expired', fx.issuer);
    // Backdate the expiry; the SDK must refresh instead of redirecting.
    await oauthProvider.saveTokens('user1', 'cfg-expired',
      { ...current, expires_at: Math.floor(Date.now() / 1000) - 100 },
      { issuer: fx.issuer }
    );
    const refreshes = fx.counts.refreshes;
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-expired' });
    let redirected = null;
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1',
      config: { id: 'cfg-expired', url: fx.mcpUrl },
      transaction: tx,
      onRedirect: async (u) => { redirected = u; }
    });
    const result = await sdk.auth(provider, { serverUrl: fx.mcpUrl });
    assert.strictEqual(result, 'AUTHORIZED', 'refresh path authorizes without browser');
    assert.strictEqual(redirected, null, 'no redirect issued');
    assert.strictEqual(fx.counts.refreshes, refreshes + 1, 'refresh performed');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('O3-19 refresh failure becomes AUTH_REQUIRED (no crash, no loop)', async () => {
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-badrefresh' });
    const current = await oauthProvider.loadTokens('user1', 'cfg-badrefresh', fx.issuer);
    fx.revokeAccessToken(current.access_token);
    // Poison the refresh token both locally and server-side.
    await oauthProvider.saveTokens('user1', 'cfg-badrefresh',
      { ...current, refresh_token: 'rt_invalid_poisoned', expires_at: Math.floor(Date.now() / 1000) - 100 },
      { issuer: fx.issuer }
    );
    const conn = new McpServerConnection(oauthConfig(fx, 'cfg-badrefresh'), {});
    const silent = oauthProvider.createSilentProvider({ userId: 'user1', config: oauthConfig(fx, 'cfg-badrefresh') });
    let err = null;
    try {
      await conn.connect({ authProvider: silent, timeoutMs: 20000 });
    } catch (e) { err = e; }
    assert.ok(err, 'connect fails when refresh is rejected');
    assert.strictEqual(err.authRequired, true, 'failure mapped to AUTH_REQUIRED');
  });

  await test('O3-20 static bearer/header auth regression', async () => {
    process.env.ARC_TEST_STATIC_TOKEN = 'static-header-secret';
    const holder = await createHttpFixtureServer(() => {});
    const port = holder.port;
    const conn = new McpServerConnection({
      id: 'cfg-static', name: 'Static', slug: 'static',
      transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`,
      auth: { type: 'header', headerName: 'Authorization', envVar: 'ARC_TEST_STATIC_TOKEN' },
      enabled: true, disabled: false, allowedTools: [], deniedTools: []
    }, {});
    await conn.connect({ timeoutMs: 15000 });
    assert.ok(conn.connected, 'static header config still connects');
    assert.ok(conn.tools.length > 0, 'static tools discovered');
    await conn.disconnect();
    await holder.close();
    delete process.env.ARC_TEST_STATIC_TOKEN;
    // OAuth validation is additive: oauth requires streamable-http, header unchanged.
    const bad = validateConfigInput({
      name: 'X', transport: 'stdio', command: 'echo',
      auth: { type: 'oauth' }
    }, { isUpdate: false });
    assert.strictEqual(bad.ok, false, 'oauth rejected for stdio');
    const good = validateConfigInput({
      name: 'Y', transport: 'streamable-http', url: 'https://mcp.example.com/mcp',
      auth: { type: 'oauth' }, oauthScope: 'tools:read'
    }, { isUpdate: false });
    assert.strictEqual(good.ok, true, 'oauth accepted for streamable-http');
    assert.strictEqual(good.data.oauthScope, 'tools:read', 'scope hint kept');
  });

  await test('O3-21 workspace/user credential isolation', async () => {
    await doFullAuth(fx, { userId: 'user1', configId: 'cfg-isolated' });
    assert.strictEqual(await oauthProvider.loadTokens('user2', 'cfg-isolated', fx.issuer), undefined, 'user2 sees no tokens');
    assert.strictEqual(await oauthProvider.loadClientInformation('user2', 'cfg-isolated', fx.issuer), undefined, 'user2 sees no client');
    const status = await oauthProvider.credentialStatus('user2', 'cfg-isolated');
    assert.strictEqual(status.authorized, false, 'user2 status unauthorized');
  });

  await test('O3-22 OAuth credential redaction in status/sanitize shapes', async () => {
    const tokens = await oauthProvider.loadTokens('user1', 'cfg-isolated', fx.issuer);
    assert.ok(tokens && tokens.access_token, 'precondition: tokens exist');
    const status = await oauthProvider.credentialStatus('user1', 'cfg-isolated');
    assert.strictEqual(status.authorized, true, 'owner status authorized');
    const statusJson = JSON.stringify(status);
    assert.ok(!statusJson.includes(tokens.access_token), 'access token absent from status');
    assert.ok(!statusJson.includes(tokens.refresh_token), 'refresh token absent from status');
    const sanitized = sanitizeConfigForClient({
      _id: 'cfg-isolated', name: 'X', transport: 'streamable-http', url: fx.mcpUrl,
      auth: { type: 'oauth' }, oauthScope: 'tools:read'
    });
    assert.deepStrictEqual(sanitized.auth, { type: 'oauth', configured: true }, 'oauth sanitized to metadata only');
    const sanJson = JSON.stringify(sanitized);
    assert.ok(!sanJson.includes(tokens.access_token), 'no token in sanitized config');
  });

  await test('O3-23 no credential exposure through API shapes', async () => {
    const tokens = await oauthProvider.loadTokens('user1', 'cfg-isolated', fx.issuer);
    const shapes = [
      sanitizeConfigForClient({ _id: 'cfg-isolated', name: 'X', auth: { type: 'oauth' }, url: fx.mcpUrl }),
      await oauthProvider.credentialStatus('user1', 'cfg-isolated')
    ];
    for (const shape of shapes) {
      const json = JSON.stringify(shape);
      assert.ok(!json.includes(tokens.access_token), 'access token never serialized');
      assert.ok(!json.includes(tokens.refresh_token), 'refresh token never serialized');
      assert.ok(!/code_verifier|authorization_code/.test(json), 'no flow secrets serialized');
    }
    assert.ok(secureTokens.isEncryptionAvailable(), 'encryption facility active');
  });

  await test('O3-24 successful reconnect after authorization', async () => {
    const id = 'cfg-reconnect';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    const registry = new McpRegistry();
    const manager = new McpManager({ registry });
    const config = oauthConfig(fx, id);
    registry.register({ ...config, tools: [] });
    const silent = () => oauthProvider.createSilentProvider({ userId: 'user1', config });
    const first = await manager.ensureConnected(config, { authProvider: silent() });
    assert.ok(first.connected, 'first connect works');
    await manager.disconnect(id);
    assert.strictEqual(manager.getConnection(id), null, 'disconnect drops the connection');
    const second = await manager.ensureConnected(config, { authProvider: silent() });
    assert.ok(second.connected, 'reconnect works after authorization');
    await manager.shutdown();
  });

  await test('O3-25 tool discovery after authorization', async () => {
    const id = 'cfg-discover';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    const config = oauthConfig(fx, id);
    const conn = new McpServerConnection(config, {});
    await conn.connect({
      authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config }),
      timeoutMs: 20000
    });
    assert.ok(conn.tools.length > 0, 'tools discovered');
    assert.ok(conn.toolEntries.size > 0, 'tool entries registered');
    await conn.disconnect();
  });

  await test('O3-26 MCP tool execution after OAuth', async () => {
    const id = 'cfg-exec';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    const config = oauthConfig(fx, id);
    const conn = new McpServerConnection(config, {});
    await conn.connect({
      authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config }),
      timeoutMs: 20000
    });
    const firstName = conn.toolEntries.keys().next().value;
    assert.ok(firstName, 'a tool exists');
    const raw = await conn.callTool(firstName, firstName.includes('echo') ? { text: 'hello-oauth' } : {});
    assert.ok(raw, 'tool returned a result');
    await conn.disconnect();
  });

  await test('O3-27 disconnect keeps credentials (no accidental deletion)', async () => {
    const id = 'cfg-keepcreds';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    const config = oauthConfig(fx, id);
    const conn = new McpServerConnection(config, {});
    await conn.connect({
      authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config }),
      timeoutMs: 20000
    });
    await conn.disconnect();
    assert.strictEqual(conn.connected, false, 'connection closed');
    const status = await oauthProvider.credentialStatus('user1', id);
    assert.strictEqual(status.authorized, true, 'credentials survive disconnect');
  });

  await test('O3-28 explicit Forget authorization removes stored credentials', async () => {
    const id = 'cfg-forget';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    assert.strictEqual((await oauthProvider.credentialStatus('user1', id)).authorized, true, 'precondition: authorized');
    const removed = await oauthProvider.deleteCredentials('user1', id);
    assert.ok(removed >= 1, 'credential document(s) removed');
    assert.strictEqual(await oauthProvider.loadTokens('user1', id, fx.issuer), undefined, 'tokens gone');
    assert.strictEqual((await oauthProvider.credentialStatus('user1', id)).authorized, false, 'status unauthorized');
  });

  await test('O3-29 one user cannot use another user\'s MCP authorization', async () => {
    const id = 'cfg-crossuser';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    const config = oauthConfig(fx, id);
    const conn = new McpServerConnection(config, {});
    const foreign = oauthProvider.createSilentProvider({ userId: 'user2', config });
    let err = null;
    try {
      await conn.connect({ authProvider: foreign, timeoutMs: 20000 });
    } catch (e) { err = e; }
    assert.ok(err, 'cross-user connect fails');
    assert.strictEqual(err.authRequired, true, 'cross-user failure is AUTH_REQUIRED, not a leak');
  });

  await test('O3-30 guest cannot inherit authenticated user\'s MCP token', async () => {
    const id = 'cfg-guest';
    await doFullAuth(fx, { userId: 'user1', configId: id });
    const guestId = 'guest_9f8e7d6c5b4a';
    assert.strictEqual(await oauthProvider.loadTokens(guestId, id, fx.issuer), undefined, 'guest loads no tokens');
    const status = await oauthProvider.credentialStatus(guestId, id);
    assert.strictEqual(status.authorized, false, 'guest status unauthorized');
    const conn = new McpServerConnection(oauthConfig(fx, id), {});
    const guestProvider = oauthProvider.createSilentProvider({ userId: guestId, config: oauthConfig(fx, id) });
    let err = null;
    try {
      await conn.connect({ authProvider: guestProvider, timeoutMs: 20000 });
    } catch (e) { err = e; }
    assert.ok(err, 'guest connect fails');
    assert.strictEqual(err.authRequired, true, 'guest failure is AUTH_REQUIRED');
  });

  await fx.close();
  oauthProvider.__resetCredentialBackend();

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
