'use strict';

// MCP OAuth — generic pre-registered client registration tests.
//
// Run:  cd server && node tests/mcpOAuthRegistration.test.js
//
// DB-free by design: config-level secrets use REAL AES-256-GCM blobs, user
// credentials run against the memory backend, and the wire runs against live
// local fixtures (no mocked OAuth):
//   - oauthServer.js fixture: CIMD + DCR capable (existing paths unchanged)
//   - noRegistrationServer.js fixture: NEITHER CIMD NOR DCR (pre-registered
//     shape — anonymous discovery, gated tool calls, fixed client identity)
//
// Covers: CIMD unchanged, DCR unchanged, auto priority (CIMD > DCR >
// pre-registered > clear error), explicit pre_registered, validation errors,
// secret redaction + encryption, issuer/PKCE/state preservation, exchange,
// refresh, reconnect, static regression, DCR-only regression, end-to-end
// no-registration acceptance.

process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'prereg-test-encryption-key-only';

const assert = require('assert');

const oauthTx = require('../lib/mcp/oauthTransactions');
const oauthProvider = require('../lib/mcp/oauthProvider');
const { McpServerConnection } = require('../lib/mcp/McpServerConnection');
const McpRegistry = require('../lib/mcp/McpRegistry');
const { sanitizeConfigForClient, validateConfigInput } = require('../lib/mcp/configApi');
const { createOAuthFixtureServer } = require('./fixtures/mcp/oauthServer');
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

const baseConfig = (url, id, extra = {}) => ({
  id,
  name: `Reg ${id}`,
  slug: `reg_${id}`,
  ownerUserId: 'user1',
  scope: 'workspace',
  workspaceId: 'ws1',
  transport: 'streamable-http',
  url,
  auth: { type: 'oauth' },
  oauthScope: null,
  enabled: true,
  disabled: false,
  guestAllowed: false,
  allowedTools: [],
  deniedTools: [],
  ...extra
});

const preregConfig = (gx, id, strategy = 'pre_registered') => baseConfig(gx.mcpUrl, id, {
  registrationStrategy: strategy,
  oauthClientId: gx.preregClientId,
  oauthClientSecretEncrypted: oauthProvider.encryptClientSecret(gx.preregClientSecret)
});

// Full interactive authorization against a fixture, mirroring the route flow:
// start tx → SDK leg 1 → authorize redirect → consume → SDK leg 2.
const doFixtureAuth = async (fx, { userId = 'user1', configId, config }) => {
  const tx = oauthTx.createTransaction({ userId, configId });
  let authorizationUrl = null;
  const startProvider = oauthProvider.createInteractiveProvider({
    userId,
    config,
    transaction: tx,
    onRedirect: async (u) => { authorizationUrl = u; }
  });
  const leg1 = await sdk.auth(startProvider, { serverUrl: config.url });
  assert.strictEqual(leg1, 'REDIRECT', 'leg 1 must redirect');
  assert.ok(authorizationUrl, 'authorization URL captured');

  const redir = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.strictEqual(redir.status, 302, 'provider redirects back with a code');
  const back = new URL(redir.headers.get('location'));
  const code = back.searchParams.get('code');
  const state = back.searchParams.get('state');
  const iss = back.searchParams.get('iss');
  assert.ok(code && state, 'code + state returned');

  const txId = oauthTx.txIdFromState(state);
  assert.ok(oauthTx.statesEqual(state, oauthTx.getTransaction(txId).state), 'state validates');
  const consumed = oauthTx.consumeTransaction(txId);
  const cbProvider = oauthProvider.createInteractiveProvider({
    userId, config, transaction: consumed, onRedirect: null
  });
  const leg2 = await sdk.auth(cbProvider, {
    serverUrl: config.url, authorizationCode: code, ...(iss ? { iss } : {})
  });
  assert.strictEqual(leg2, 'AUTHORIZED', 'leg 2 exchanges the code');
  return { tx, consumed, code, state, iss, authorizationUrl };
};

const main = async () => {
  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const fx = await createOAuthFixtureServer();
  const gx = await createNoRegistrationFixtureServer();

  await test('R1 explicit cimd never shadows the SDK mechanism', async () => {
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: 'cimd', asMetadata: null, hasPreRegistered: true }),
      'cimd', 'explicit cimd resolves cimd'
    );
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-r1' });
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1',
      config: preregConfig(gx, 'cfg-r1', 'cimd'),
      transaction: tx, onRedirect: null
    });
    assert.strictEqual(await provider.clientInformation({ issuer: gx.issuer }), undefined, 'no pre-reg supply under explicit cimd');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('R2 existing DCR path unchanged (full auth, one registration)', async () => {
    const before = fx.counts.registrations;
    await doFixtureAuth(fx, { configId: 'cfg-r2', config: baseConfig(fx.mcpUrl, 'cfg-r2') });
    assert.strictEqual(fx.counts.registrations, before + 1, 'exactly one DCR per authorization');
  });

  await test('R3 auto chooses CIMD where advertised', async () => {
    const prev = process.env.MCP_OAUTH_CLIENT_METADATA_URL;
    try {
      process.env.MCP_OAUTH_CLIENT_METADATA_URL = 'https://auth.example.com/cimd/arc-client';
      const info = await sdk.discoverOAuthServerInfo(fx.mcpUrl);
      const mode = oauthProvider.resolveRegistrationMode({
        strategy: 'auto',
        asMetadata: info.authorizationServerMetadata,
        clientMetadataUrl: 'https://auth.example.com/cimd/arc-client',
        hasPreRegistered: true
      });
      assert.strictEqual(mode, 'cimd', 'CIMD wins in auto even with pre-reg configured');
      const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-r3' });
      tx.discoveryState = { authorizationServerMetadata: info.authorizationServerMetadata };
      const provider = oauthProvider.createInteractiveProvider({
        userId: 'user1', config: preregConfig(gx, 'cfg-r3', 'auto'), transaction: tx, onRedirect: null
      });
      assert.strictEqual(await provider.clientInformation({ issuer: fx.issuer }), undefined, 'pre-reg does not shadow CIMD');
      oauthTx.deleteTransaction(tx.txId);
    } finally {
      if (prev === undefined) delete process.env.MCP_OAUTH_CLIENT_METADATA_URL;
      else process.env.MCP_OAUTH_CLIENT_METADATA_URL = prev;
    }
  });

  await test('R4 auto chooses DCR when CIMD unsupported', async () => {
    const dcrOnlyMeta = { issuer: 'https://as.example/', registration_endpoint: 'https://as.example/register' };
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: 'auto', asMetadata: dcrOnlyMeta, hasPreRegistered: true }),
      'dcr', 'DCR wins over pre-reg in auto'
    );
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-r4' });
    tx.discoveryState = { authorizationServerMetadata: dcrOnlyMeta };
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1', config: preregConfig(gx, 'cfg-r4', 'auto'), transaction: tx, onRedirect: null
    });
    assert.strictEqual(await provider.clientInformation({ issuer: 'https://as.example/' }), undefined, 'pre-reg does not shadow DCR');
    oauthTx.deleteTransaction(tx.txId);
    // Live fixture metadata without the CIMD env hook resolves DCR too.
    const live = await sdk.discoverOAuthServerInfo(fx.mcpUrl);
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: null, asMetadata: live.authorizationServerMetadata, hasPreRegistered: false }),
      'dcr', 'legacy (strategy-less) config resolves DCR'
    );
  });

  await test('R5 auto chooses pre_registered when CIMD + DCR unavailable', async () => {
    const live = await sdk.discoverOAuthServerInfo(gx.mcpUrl);
    assert.strictEqual(live.authorizationServerMetadata.registration_endpoint, undefined, 'precondition: no DCR endpoint');
    assert.strictEqual(live.authorizationServerMetadata.client_id_metadata_document_supported, undefined, 'precondition: no CIMD flag');
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: 'auto', asMetadata: live.authorizationServerMetadata, hasPreRegistered: true }),
      'pre_registered', 'auto falls back to pre-registered'
    );
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: null, asMetadata: live.authorizationServerMetadata, hasPreRegistered: false }),
      null, 'auto with no avenue resolves null (clear error downstream)'
    );
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-r5' });
    tx.discoveryState = { authorizationServerMetadata: live.authorizationServerMetadata };
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1', config: preregConfig(gx, 'cfg-r5', 'auto'), transaction: tx, onRedirect: null
    });
    const info = await provider.clientInformation({ issuer: gx.issuer });
    assert.ok(info, 'pre-registered info supplied');
    assert.strictEqual(info.client_id, gx.preregClientId, 'configured client id supplied');
    assert.strictEqual(info.client_secret, gx.preregClientSecret, 'configured secret supplied');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('R6 explicit pre_registered supplies identity regardless of metadata', async () => {
    const live = await sdk.discoverOAuthServerInfo(fx.mcpUrl);
    assert.ok(live.authorizationServerMetadata.registration_endpoint, 'precondition: DCR capable');
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: 'pre_registered', asMetadata: live.authorizationServerMetadata, hasPreRegistered: true }),
      'pre_registered', 'explicit pre-registered wins'
    );
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-r6' });
    tx.discoveryState = { authorizationServerMetadata: live.authorizationServerMetadata };
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1', config: preregConfig(gx, 'cfg-r6', 'pre_registered'), transaction: tx, onRedirect: null
    });
    const info = await provider.clientInformation({ issuer: fx.issuer });
    assert.strictEqual(info.client_id, gx.preregClientId, 'no DCR attempt path — configured identity used');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('R7 user-supplied registration fields rejected (developer boundary)', async () => {
    for (const field of ['registrationStrategy', 'oauthClientId', 'oauthClientSecret']) {
      const body = {
        name: 'X', transport: 'streamable-http', url: 'https://mcp.example/mcp',
        auth: { type: 'oauth' }, [field]: field === 'registrationStrategy' ? 'pre_registered' : 'value'
      };
      const { ok, error } = validateConfigInput(body, { isUpdate: false });
      assert.strictEqual(ok, false, `create with ${field} rejected`);
      assert.match(error, /server-side/i, 'clear server-side error');
      const upd = validateConfigInput({ [field]: 'value' }, { isUpdate: true });
      assert.strictEqual(upd.ok, false, `update with ${field} rejected`);
    }
    // Ordinary oauth create/update without registration fields still passes.
    const clean = validateConfigInput({
      name: 'X', transport: 'streamable-http', url: 'https://mcp.example/mcp',
      auth: { type: 'oauth' }
    }, { isUpdate: false });
    assert.strictEqual(clean.ok, true, 'plain oauth config validates');
    assert.strictEqual('registrationStrategy' in clean.data, false, 'no strategy emitted');
  });

  await test('R8 incomplete server-side material fails clearly at use time', async () => {
    // Half-configured environment (ID without secret) is a server
    // misconfiguration: the provider fails with a precise error, never a
    // confusing SDK fallback.
    const prevId = process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_ID;
    const prevSecret = process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_SECRET;
    try {
      process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_ID = 'half-client-id';
      delete process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_SECRET;
      const config = baseConfig('https://mcp.example/mcp', 'cfg-r8', { slug: 'half_fixture' });
      assert.strictEqual(oauthProvider.hasPreRegisteredCredentials(config), true, 'half signal detected');
      assert.throws(
        () => oauthProvider.getPreRegisteredClientInfo(config),
        /both required/i, 'clear incomplete-configuration error'
      );
    } finally {
      if (prevId === undefined) delete process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_ID;
      else process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_SECRET;
      else process.env.MCP_HALF_FIXTURE_OAUTH_CLIENT_SECRET = prevSecret;
    }
  });

  await test('R9 clientSecret never returned by API shapes', async () => {
    const blob = oauthProvider.encryptClientSecret(gx.preregClientSecret);
    const out = sanitizeConfigForClient({
      _id: 'cfg-r9', name: 'X', transport: 'streamable-http', url: gx.mcpUrl,
      auth: { type: 'oauth' }, registrationStrategy: 'pre_registered',
      oauthClientId: gx.preregClientId, oauthClientSecretEncrypted: blob
    });
    assert.strictEqual(out.auth.registrationStrategy, 'pre_registered', 'strategy visible');
    assert.strictEqual(out.auth.clientIdConfigured, true, 'id presence flag');
    assert.strictEqual(out.auth.clientSecretConfigured, true, 'secret presence flag');
    const json = JSON.stringify(out);
    assert.ok(!json.includes(gx.preregClientSecret), 'secret absent from sanitized config');
    assert.ok(!json.includes(gx.preregClientId), 'client ID absent from sanitized config');
    assert.ok(!json.includes(blob), 'encrypted blob absent from sanitized config');
    // Legacy docs keep the exact historical shape.
    const legacy = sanitizeConfigForClient({ _id: 'cfg-r9b', name: 'Y', auth: { type: 'oauth' }, url: fx.mcpUrl });
    assert.deepStrictEqual(legacy.auth, { type: 'oauth', configured: true }, 'legacy shape unchanged');
  });

  await test('R10 clientSecret encrypted at rest', async () => {
    const blob = oauthProvider.encryptClientSecret(gx.preregClientSecret);
    assert.ok(typeof blob === 'string' && blob.length > 0, 'blob produced');
    assert.ok(!blob.includes(gx.preregClientSecret), 'no plaintext in blob');
    assert.strictEqual(oauthProvider.decryptClientSecret(blob), gx.preregClientSecret, 'round-trips');
    assert.throws(
      () => oauthProvider.decryptClientSecret(blob.slice(0, -4) + 'AAAA'),
      /decrypt/i, 'tampered blob fails closed'
    );
  });

  await test('R11 issuer binding preserved for pre-registered flow', async () => {
    await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-r11', config: preregConfig(gx, 'cfg-r11') });
    const info = await oauthProvider.loadClientInformation('user1', 'cfg-r11', gx.issuer);
    assert.ok(info, 'stored client info loads');
    assert.strictEqual(info.issuer, gx.issuer, 'issuer stamped on save');
    assert.strictEqual(info.client_id, gx.preregClientId, 'stored identity matches configured');
    assert.strictEqual(
      await oauthProvider.loadClientInformation('user1', 'cfg-r11', 'https://wrong.example/as'),
      undefined, 'wrong issuer loads nothing'
    );
  });

  await test('R12 PKCE preserved on the pre-registered leg', async () => {
    const { tx } = await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-r12', config: preregConfig(gx, 'cfg-r12') });
    assert.ok(tx.codeVerifier, 'verifier stored in transaction');
    assert.strictEqual(gx.lastAuthorizeRequest.code_challenge_method, 'S256', 'S256 challenge sent');
    assert.ok(gx.lastAuthorizeRequest.has_challenge, 'challenge present');
    assert.strictEqual(gx.lastAuthorizeRequest.client_id, gx.preregClientId, 'configured id on the authorize URL');
  });

  await test('R13 state validation preserved', async () => {
    const { tx, state } = await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-r13', config: preregConfig(gx, 'cfg-r13') });
    assert.ok(oauthTx.statesEqual(state, tx.state), 'honest state validates');
    assert.strictEqual(oauthTx.statesEqual(state + 'x', tx.state), false, 'tampered state rejected');
    assert.strictEqual(oauthTx.txIdFromState(state), tx.txId, 'tx id binds state');
  });

  await test('R14 callback exchange works with pre-registered client', async () => {
    const before = gx.counts.codeExchanges;
    await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-r14', config: preregConfig(gx, 'cfg-r14') });
    assert.strictEqual(gx.counts.codeExchanges, before + 1, 'code exchanged');
    const tokens = await oauthProvider.loadTokens('user1', 'cfg-r14', gx.issuer);
    assert.ok(tokens && tokens.access_token && tokens.refresh_token, 'tokens persisted');
    assert.ok(gx.counts.basicAuthUses >= 1, 'secret transmitted via token endpoint auth');
  });

  await test('R15 token refresh works with pre-registered client', async () => {
    await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-r15', config: preregConfig(gx, 'cfg-r15') });
    const before = await oauthProvider.loadTokens('user1', 'cfg-r15', gx.issuer);
    gx.revokeAccessToken(before.access_token);
    const refreshes = gx.counts.refreshes;
    // Discovery is anonymous on this shape, so the refresh engages on the
    // first gated tool call (401 → SDK refresh → retry).
    const config = baseConfig(gx.mcpUrl, 'cfg-r15');
    const conn = new McpServerConnection(config, {});
    await conn.connect({
      authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config }),
      timeoutMs: 20000
    });
    assert.ok(conn.connected, 'anonymous discovery connects');
    const result = await conn.callTool('list_items', {}, { timeoutMs: 20000 });
    assert.strictEqual(result.isError || false, false, 'call succeeds after refresh');
    assert.strictEqual(gx.counts.refreshes, refreshes + 1, 'exactly one refresh performed');
    const after = await oauthProvider.loadTokens('user1', 'cfg-r15', gx.issuer);
    assert.ok(after && after.access_token !== before.access_token, 'rotated token persisted');
    await conn.disconnect();
  });

  await test('R16 reconnect uses stored client registration', async () => {
    await doFixtureAuth(gx, { userId: 'user1', configId: 'cfg-r16', config: preregConfig(gx, 'cfg-r16') });
    const config = baseConfig(gx.mcpUrl, 'cfg-r16');
    const silent = oauthProvider.createSilentProvider({ userId: 'user1', config });
    const info = await silent.clientInformation({ issuer: gx.issuer });
    assert.ok(info, 'stored registration loads on reconnect');
    assert.strictEqual(info.client_id, gx.preregClientId, ' reconnect reuses stored identity');
    const conn = new McpServerConnection(config, {});
    await conn.connect({ authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config }), timeoutMs: 20000 });
    assert.ok(conn.connected, 'reconnect works after authorization');
    await conn.disconnect();
  });

  await test('R17 static/header MCP regression', async () => {
    const bad = validateConfigInput({
      name: 'X', transport: 'streamable-http', url: 'https://x.example/mcp',
      auth: { type: 'header', headerName: 'Authorization', envVar: 'T' },
      registrationStrategy: 'pre_registered'
    }, { isUpdate: false });
    assert.strictEqual(bad.ok, false, 'strategy rejected for non-oauth');
    assert.match(bad.error, /server-side/i, 'clear server-side error');
    const out = sanitizeConfigForClient({
      _id: 's1', name: 'S', scope: 'global', transport: 'streamable-http', url: 'https://x.example/mcp',
      auth: { type: 'header', headerName: 'Authorization', envVar: 'T' }
    });
    assert.deepStrictEqual(out.auth, {
      type: 'header', headerName: 'Authorization', envVar: 'T', configured: true
    }, 'header shape unchanged');
    // Registry never retains client identities or secrets.
    const registry = new McpRegistry();
    const reg = registry.register({
      id: 'cfg-r17', name: 'R', scope: 'global', transport: 'streamable-http', url: gx.mcpUrl,
      auth: { type: 'oauth' }, registrationStrategy: 'pre_registered',
      oauthClientId: gx.preregClientId,
      oauthClientSecretEncrypted: oauthProvider.encryptClientSecret(gx.preregClientSecret)
    });
    assert.strictEqual(reg.oauthClientId, undefined, 'client id dropped by registry');
    assert.strictEqual(reg.oauthClientSecretEncrypted, undefined, 'secret dropped by registry');
  });

  await test('R18 DCR-only server regression (no pre-reg configured)', async () => {
    const dcrOnlyMeta = { issuer: 'https://as.example/', registration_endpoint: 'https://as.example/register' };
    assert.strictEqual(
      oauthProvider.resolveRegistrationMode({ strategy: 'auto', asMetadata: dcrOnlyMeta, hasPreRegistered: false }),
      'dcr', 'auto still resolves DCR'
    );
    const tx = oauthTx.createTransaction({ userId: 'user1', configId: 'cfg-r18' });
    tx.discoveryState = { authorizationServerMetadata: dcrOnlyMeta };
    const provider = oauthProvider.createInteractiveProvider({
      userId: 'user1', config: baseConfig('https://mcp.example/mcp', 'cfg-r18'), transaction: tx, onRedirect: null
    });
    assert.strictEqual(await provider.clientInformation({ issuer: 'https://as.example/' }), undefined, 'SDK DCR path untouched');
    oauthTx.deleteTransaction(tx.txId);
  });

  await test('R19 no-registration acceptance: anonymous discovery, gated calls, pre-reg auth, working tools', async () => {
    // Anonymous discovery succeeds with tools (the reported Google shape).
    const anonConfig = baseConfig(gx.mcpUrl, 'cfg-r19');
    const anon = new McpServerConnection(anonConfig, {});
    await anon.connect({ timeoutMs: 20000 });
    assert.ok(anon.connected, 'anonymous transport connects');
    assert.strictEqual(anon.tools.length, 2, 'tools discovered without auth');
    // …but real calls fail closed with an auth-credential error. The SDK
    // transport throws on HTTP 401 (it never surfaces the JSON-RPC isError).
    let gatedErr = null;
    try {
      await anon.callTool('list_items', {}, { timeoutMs: 20000 });
    } catch (e) { gatedErr = e; }
    assert.ok(gatedErr, 'call gated without bearer');
    assert.ok(
      gatedErr.name === 'UnauthorizedError' || gatedErr.status === 401 || gatedErr.statusCode === 401 ||
      /401|unauthorized|credential|auth/i.test(String(gatedErr.message || '')),
      `auth-flavored failure (got ${gatedErr.name}: ${String(gatedErr.message || '').slice(0, 120)})`
    );
    await anon.disconnect();
    // Pre-registered authorization completes end to end (no DCR involved).
    const { authorizationUrl } = await doFixtureAuth(gx, {
      userId: 'user1', configId: 'cfg-r19', config: preregConfig(gx, 'cfg-r19')
    });
    const authUrl = new URL(authorizationUrl);
    assert.strictEqual(authUrl.searchParams.get('client_id'), gx.preregClientId, 'authorize URL carries configured id');
    // Silent reconnect executes tools successfully.
    const authed = new McpServerConnection(baseConfig(gx.mcpUrl, 'cfg-r19'), {});
    await authed.connect({
      authProvider: oauthProvider.createSilentProvider({ userId: 'user1', config: baseConfig(gx.mcpUrl, 'cfg-r19') }),
      timeoutMs: 20000
    });
    assert.ok(authed.connected, 'silent reconnect works');
    const result = await authed.callTool('list_items', {}, { timeoutMs: 20000 });
    assert.strictEqual(result.isError || false, false, 'call succeeds with bearer');
    assert.match(JSON.stringify(result.content), /ok:list_items/, 'tool executed');
    await authed.disconnect();
  });

  await fx.close();
  await gx.close();

  console.log(`\nMCP OAuth registration: ${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => {
  console.error('REGISTRATION SUITE CRASH:', err);
  process.exit(1);
});
