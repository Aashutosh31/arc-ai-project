'use strict';

// MCP OAuth — server-side developer credential boundary tests.
//
// Run:  cd server && node tests/mcpOAuthServerCreds.test.js
//
// The end user NEVER supplies OAuth client material: pre-registered
// credentials resolve server-side from keyed environment variables
// (MCP_<SLUG_KEY>_OAUTH_CLIENT_ID/_OAUTH_CLIENT_SECRET) with encrypted
// config-doc fields as operator fallback. This suite proves the boundary:
// resolution, precedence, redaction (API + React boundary), rejection of
// user-supplied registration fields, end-user start with zero browser-side
// credentials, and multi-user isolation.
//
// DB-free: memory credential backend, REAL AES-256-GCM blobs, live local
// no-registration fixture (neither CIMD nor DCR — the pre-registered shape).

process.env.MCP_TOKEN_ENCRYPTION_KEY = process.env.MCP_TOKEN_ENCRYPTION_KEY || 'servercreds-test-encryption-key';

const assert = require('assert');

const oauthTx = require('../lib/mcp/oauthTransactions');
const oauthProvider = require('../lib/mcp/oauthProvider');
const { McpServerConnection } = require('../lib/mcp/McpServerConnection');
const { sanitizeConfigForClient, validateConfigInput } = require('../lib/mcp/configApi');
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

// Scoped env helper: sets vars, runs fn, restores prior values.
const withEnv = async (vars, fn) => {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
};

const envOnlyConfig = (url, id, slug) => ({
  id,
  name: `Env ${id}`,
  slug,
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
  deniedTools: []
  // NOTE: no registrationStrategy, no oauthClientId, no secret blob — the
  // end-user document carries public connection config only.
});

const main = async () => {
  oauthProvider.__setCredentialBackend(oauthProvider.createMemoryBackend());
  const gx = await createNoRegistrationFixtureServer();

  await test('S1 slug-derived environment key lookup', async () => {
    assert.strictEqual(oauthProvider.serverKeyForEnv('google_calendar'), 'GOOGLE_CALENDAR', 'snake slug');
    assert.strictEqual(oauthProvider.serverKeyForEnv('Team-Tools 2'), 'TEAM_TOOLS_2', 'dashes/spaces normalized');
    assert.strictEqual(oauthProvider.serverKeyForEnv(''), '', 'empty slug yields empty key');
    assert.strictEqual(oauthProvider.serverKeyForEnv(null), '', 'null-safe');
  });

  await test('S2 complete env pair resolves (doc fields absent)', async () => {
    await withEnv({
      MCP_ENVRESOLVE_OAUTH_CLIENT_ID: 'env-client-id',
      MCP_ENVRESOLVE_OAUTH_CLIENT_SECRET: 'env-client-secret'
    }, async () => {
      const config = envOnlyConfig('https://mcp.example/mcp', 'cfg-s2', 'envresolve');
      assert.strictEqual(oauthProvider.hasPreRegisteredCredentials(config), true, 'env signal detected');
      const info = oauthProvider.getPreRegisteredClientInfo(config);
      assert.strictEqual(info.clientId, 'env-client-id', 'env id supplied');
      assert.strictEqual(info.clientSecret, 'env-client-secret', 'env secret supplied');
      assert.strictEqual(
        oauthProvider.resolveRegistrationMode({ strategy: null, asMetadata: {}, hasPreRegistered: true }),
        'pre_registered', 'auto falls back with unknown metadata'
      );
    });
    const config = envOnlyConfig('https://mcp.example/mcp', 'cfg-s2', 'envresolve');
    assert.strictEqual(oauthProvider.hasPreRegisteredCredentials(config), false, 'no leakage after env restore');
  });

  await test('S3 environment wins over doc storage (halves never mixed)', async () => {
    const docBlob = oauthProvider.encryptClientSecret('doc-secret');
    await withEnv({
      MCP_ENVWIN_OAUTH_CLIENT_ID: 'env-client-id',
      MCP_ENVWIN_OAUTH_CLIENT_SECRET: 'env-client-secret'
    }, async () => {
      const config = {
        ...envOnlyConfig('https://mcp.example/mcp', 'cfg-s3', 'envwin'),
        oauthClientId: 'doc-client-id',
        oauthClientSecretEncrypted: docBlob
      };
      const info = oauthProvider.getPreRegisteredClientInfo(config);
      assert.strictEqual(info.clientId, 'env-client-id', 'env id wins');
      assert.strictEqual(info.clientSecret, 'env-client-secret', 'env secret wins');
    });
  });

  await test('S4 secret never returned by API shapes (env + doc sources)', async () => {
    const docBlob = oauthProvider.encryptClientSecret('doc-secret-value');
    await withEnv({
      MCP_SANITIZE_ME_OAUTH_CLIENT_ID: 'env-id-value',
      MCP_SANITIZE_ME_OAUTH_CLIENT_SECRET: 'env-secret-value'
    }, async () => {
      const out = sanitizeConfigForClient({
        _id: 'cfg-s4', name: 'X', slug: 'sanitize_me', transport: 'streamable-http', url: gx.mcpUrl,
        auth: { type: 'oauth' }, registrationStrategy: 'pre_registered',
        oauthClientId: 'doc-id-value', oauthClientSecretEncrypted: docBlob
      });
      assert.strictEqual(out.auth.clientIdConfigured, true, 'id flag set');
      assert.strictEqual(out.auth.clientSecretConfigured, true, 'secret flag set');
      const json = JSON.stringify(out);
      for (const secret of ['env-id-value', 'env-secret-value', 'doc-id-value', 'doc-secret-value', docBlob]) {
        assert.ok(!json.includes(secret), `value absent from browser payload: ${secret.slice(0, 8)}…`);
      }
      // The React boundary carries no credential VALUES or value-keys either
      // (presence flags like clientSecretConfigured are metadata, not secrets).
      assert.ok(!/"oauthClientId"|"oauthClientSecret"|"client_secret"|"clientSecret":/.test(json), 'no credential value-keys in payload');
    });
  });

  await test('S5 user payloads cannot set registration material', async () => {
    for (const [field, value] of [
      ['registrationStrategy', 'pre_registered'],
      ['registrationStrategy', 'auto'],
      ['oauthClientId', 'cid'],
      ['oauthClientSecret', 'shh']
    ]) {
      const create = validateConfigInput({
        name: 'X', transport: 'streamable-http', url: 'https://mcp.example/mcp',
        auth: { type: 'oauth' }, [field]: value
      }, { isUpdate: false });
      assert.strictEqual(create.ok, false, `create rejects ${field}`);
      assert.match(create.error, /server-side/i, 'server-side error copy');
      const update = validateConfigInput({ [field]: value }, { isUpdate: true });
      assert.strictEqual(update.ok, false, `update rejects ${field}`);
    }
  });

  await test('S6 end-user start works with zero browser-side credentials', async () => {
    await withEnv({
      MCP_ENVFLOW_OAUTH_CLIENT_ID: gx.preregClientId,
      MCP_ENVFLOW_OAUTH_CLIENT_SECRET: gx.preregClientSecret
    }, async () => {
      const configId = 'cfg-s6';
      const config = envOnlyConfig(gx.mcpUrl, configId, 'envflow');
      const tx = oauthTx.createTransaction({ userId: 'user1', configId });
      let authorizationUrl = null;
      const provider = oauthProvider.createInteractiveProvider({
        userId: 'user1', config, transaction: tx,
        onRedirect: async (u) => { authorizationUrl = u; }
      });
      const leg1 = await sdk.auth(provider, { serverUrl: gx.mcpUrl });
      assert.strictEqual(leg1, 'REDIRECT', 'browser redirect issued from env credentials');
      const authUrl = new URL(authorizationUrl);
      assert.strictEqual(authUrl.searchParams.get('client_id'), gx.preregClientId, 'env identity on the authorize URL');
      const redir = await fetch(authorizationUrl, { redirect: 'manual' });
      assert.strictEqual(redir.status, 302, 'provider authorizes env identity');
      const back = new URL(redir.headers.get('location'));
      const consumed = oauthTx.consumeTransaction(oauthTx.txIdFromState(back.searchParams.get('state')));
      const leg2 = await sdk.auth(oauthProvider.createInteractiveProvider({
        userId: 'user1', config, transaction: consumed, onRedirect: null
      }), {
        serverUrl: gx.mcpUrl,
        authorizationCode: back.searchParams.get('code'),
        iss: back.searchParams.get('iss')
      });
      assert.strictEqual(leg2, 'AUTHORIZED', 'exchange completes from env credentials');
      const tokens = await oauthProvider.loadTokens('user1', configId, gx.issuer);
      assert.ok(tokens && tokens.access_token, 'user credential persisted (per-user, encrypted)');
    });
  });

  await test('S7 multi-user isolation with env-sourced developer credentials', async () => {
    await withEnv({
      MCP_ENVISOLATE_OAUTH_CLIENT_ID: gx.preregClientId,
      MCP_ENVISOLATE_OAUTH_CLIENT_SECRET: gx.preregClientSecret
    }, async () => {
      const configId = 'cfg-s7';
      const config = envOnlyConfig(gx.mcpUrl, configId, 'envisolate');
      // userA authorizes…
      const tx = oauthTx.createTransaction({ userId: 'userA', configId });
      let authorizationUrl = null;
      const provider = oauthProvider.createInteractiveProvider({
        userId: 'userA', config, transaction: tx,
        onRedirect: async (u) => { authorizationUrl = u; }
      });
      assert.strictEqual(await sdk.auth(provider, { serverUrl: gx.mcpUrl }), 'REDIRECT', 'userA redirect');
      const back = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location'));
      const consumed = oauthTx.consumeTransaction(oauthTx.txIdFromState(back.searchParams.get('state')));
      const leg2 = await sdk.auth(oauthProvider.createInteractiveProvider({
        userId: 'userA', config, transaction: consumed, onRedirect: null
      }), {
        serverUrl: gx.mcpUrl,
        authorizationCode: back.searchParams.get('code'),
        iss: back.searchParams.get('iss')
      });
      assert.strictEqual(leg2, 'AUTHORIZED', 'userA authorized');
      // …userB shares the developer client but NOT the tokens.
      const statusA = await oauthProvider.credentialStatus('userA', configId);
      const statusB = await oauthProvider.credentialStatus('userB', configId);
      assert.strictEqual(statusA.authorized, true, 'userA authorized');
      assert.strictEqual(statusB.authorized, false, 'userB unauthorized');
      assert.strictEqual(await oauthProvider.loadTokens('userB', configId, gx.issuer), undefined, 'no token leakage across users');
    });
  });

  await gx.close();

  console.log(`\nMCP OAuth server creds: ${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((err) => {
  console.error('SERVER CREDS SUITE CRASH:', err);
  process.exit(1);
});
