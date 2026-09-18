/**
 * MCP OAuth UI-state matrix tests (generic — no vendor names, URLs, or tool
 * names anywhere in the helper contract).
 *
 * Run: cd client && node tests/mcpOAuthUiState.test.mjs
 *
 * Covers:
 *   A. disconnected + unauthorized
 *   B. connected + unauthorized + tools (the reported bug: Authorize hidden)
 *   C. connected + authorized + tools
 *   D. disconnected + authorized credentials
 *   E. authorization canceled (still unauthorized, still connected)
 *   F. authorization succeeds while already connected (state transition)
 *   G. static/non-OAuth MCP regression
 *   H. Notion-shaped OAuth regression (401-at-initialize + authorized)
 * Plus: unknown-status (not yet loaded), not_owner privacy, expired label.
 */
import assert from 'node:assert';
import { getOAuthUiState, getOAuthStatusLine, getConnectionUiState } from '../src/lib/mcpOAuthUi.js';

const passed = [];
const failed = [];

const test = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed.push({ name, err });
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err && err.message}`);
  }
};

const unauth = { oauth: true, authorized: false, reason: 'no_credentials' };
const authed = (over = {}) => ({ oauth: true, authorized: true, authorizationServers: ['https://as.example/'], scopes: ['default'], ...over });

// A. disconnected + unauthorized → Authorize visible, legacy copy
await test('A. disconnected + unauthorized shows Authorize', () => {
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'disconnected', toolCount: 0, oauthStatus: unauth });
  assert.strictEqual(ui.authState, 'required');
  assert.strictEqual(ui.showAuthorize, true);
  assert.strictEqual(ui.authorizeLabel, 'Authorize');
  const line = getOAuthStatusLine({ authType: 'oauth', connectionState: 'disconnected', oauthStatus: unauth });
  assert.strictEqual(line.tone, 'warn');
  assert.match(line.text, /connect, then authorize/);
});

// B. connected + unauthorized + tools → Authorize STILL visible (bug fix)
await test('B. connected + unauthorized + tools still shows Authorize', () => {
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: unauth });
  assert.strictEqual(ui.connected, true);
  assert.strictEqual(ui.hasTools, true);
  assert.strictEqual(ui.authState, 'required');
  assert.strictEqual(ui.showAuthorize, true, 'Authorize must survive an already-connected transport');
  assert.strictEqual(ui.authorizeLabel, 'Authorize');
  const line = getOAuthStatusLine({ authType: 'oauth', connectionState: 'connected', oauthStatus: unauth });
  assert.strictEqual(line.tone, 'warn');
  assert.match(line.text, /Connected — authorization required/);
});

// C. connected + authorized + tools → authorized, no Authorize
await test('C. connected + authorized + tools hides Authorize', () => {
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: authed() });
  assert.strictEqual(ui.authState, 'authorized');
  assert.strictEqual(ui.showAuthorize, false);
});

// D. disconnected + authorized credentials → no Authorize (connect will succeed)
await test('D. disconnected + authorized shows no Authorize', () => {
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'disconnected', toolCount: 0, oauthStatus: authed() });
  assert.strictEqual(ui.authState, 'authorized');
  assert.strictEqual(ui.showAuthorize, false);
});

// E. authorization canceled → still connected, still required, Authorize stays
await test('E. canceled authorization keeps connected + required + Authorize', () => {
  const before = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: unauth });
  assert.strictEqual(before.showAuthorize, true);
  // Cancel persists the same unauthorized status: no misleading authorized state.
  const after = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: unauth });
  assert.strictEqual(after.authState, 'required');
  assert.strictEqual(after.connected, true);
  assert.strictEqual(after.showAuthorize, true);
});

// F. authorization succeeds while already connected → transition to authorized
await test('F. success while connected transitions to authorized, hides Authorize', () => {
  const before = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: unauth });
  assert.strictEqual(before.showAuthorize, true);
  const after = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: authed() });
  assert.strictEqual(after.authState, 'authorized');
  assert.strictEqual(after.connected, true);
  assert.strictEqual(after.hasTools, true);
  assert.strictEqual(after.showAuthorize, false);
});

// G. static/non-OAuth regression → never Authorize, no OAuth line
await test('G. static header/none auth never shows Authorize', () => {
  for (const authType of ['header', 'none', undefined]) {
    for (const connectionState of ['connected', 'disconnected']) {
      const ui = getOAuthUiState({ authType, connectionState, toolCount: 3, oauthStatus: undefined });
      assert.strictEqual(ui.authState, 'not_oauth', `authType=${authType}`);
      assert.strictEqual(ui.showAuthorize, false, `authType=${authType} state=${connectionState}`);
      const line = getOAuthStatusLine({ authType, connectionState, oauthStatus: undefined });
      assert.strictEqual(line.text, null);
    }
  }
});

// H1. Notion-shaped: 401 at initialize → disconnected + unauthorized + no tools
await test('H1. initialize-gated OAuth keeps legacy disconnected Authorize path', () => {
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'disconnected', toolCount: 0, oauthStatus: unauth });
  assert.strictEqual(ui.showAuthorize, true);
  assert.strictEqual(ui.authorizeLabel, 'Authorize');
});

// H2. Notion-shaped authorized: connected + authorized + tools → no Authorize
await test('H2. authorized OAuth with tools hides Authorize', () => {
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 44, oauthStatus: authed() });
  assert.strictEqual(ui.authState, 'authorized');
  assert.strictEqual(ui.showAuthorize, false);
});

// Unknown status (not yet loaded): no flash when connected, legacy gate when not
await test('unknown status does not flash Authorize on connected cards', () => {
  const connected = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 5, oauthStatus: undefined });
  assert.strictEqual(connected.authState, 'unknown');
  assert.strictEqual(connected.showAuthorize, false);
  const idle = getOAuthUiState({ authType: 'oauth', connectionState: 'disconnected', toolCount: 0, oauthStatus: undefined });
  assert.strictEqual(idle.authState, 'unknown');
  assert.strictEqual(idle.showAuthorize, true);
  const line = getOAuthStatusLine({ authType: 'oauth', connectionState: 'connected', oauthStatus: undefined });
  assert.strictEqual(line.text, null);
});

// not_owner privacy: Authorize hidden (start would 403), private copy shown
await test('not_owner status hides Authorize with private copy', () => {
  const status = { oauth: true, authorized: false, reason: 'not_owner' };
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'disconnected', toolCount: 0, oauthStatus: status });
  assert.strictEqual(ui.authState, 'private');
  assert.strictEqual(ui.showAuthorize, false);
  const line = getOAuthStatusLine({ authType: 'oauth', connectionState: 'disconnected', oauthStatus: status });
  assert.match(line.text, /private to the owning account/);
});

// Expired credential → Reauthorize label (matches Forget/Reauthorize affordance)
await test('expired credential labels the button Reauthorize', () => {
  const status = { oauth: true, authorized: false, expired: true };
  const ui = getOAuthUiState({ authType: 'oauth', connectionState: 'connected', toolCount: 9, oauthStatus: status });
  assert.strictEqual(ui.showAuthorize, true);
  assert.strictEqual(ui.authorizeLabel, 'Reauthorize');
});

// ---- user-first readiness (transport × authorization × discovery) ----

await test('READY: authorized + connected + tools', () => {
  assert.strictEqual(getConnectionUiState({
    connectionState: 'connected', toolCount: 9, discoveryStatus: 'ok',
    oauthStatus: authed(), authType: 'oauth'
  }), 'READY');
});

await test('DISCOVERY_FAILED: authorized + connected + zero tools, discovery failed', () => {
  assert.strictEqual(getConnectionUiState({
    connectionState: 'connected', toolCount: 0, discoveryStatus: 'failed',
    oauthStatus: authed(), authType: 'oauth'
  }), 'DISCOVERY_FAILED');
});

await test('AUTH_REQUIRED: unauthorized + connected (discovery irrelevant)', () => {
  for (const discoveryStatus of ['ok', 'failed', 'pending', 'unknown']) {
    assert.strictEqual(getConnectionUiState({
      connectionState: 'connected', toolCount: 0, discoveryStatus,
      oauthStatus: unauth, authType: 'oauth'
    }), 'AUTH_REQUIRED', `discovery=${discoveryStatus}`);
  }
});

await test('DISCONNECTED when transport is down', () => {
  for (const connectionState of ['disconnected', 'connecting', undefined]) {
    assert.strictEqual(getConnectionUiState({
      connectionState, toolCount: 0, discoveryStatus: 'idle', oauthStatus: authed(), authType: 'oauth'
    }), 'DISCONNECTED');
  }
});

await test('DISCOVERING while discovery pending', () => {
  assert.strictEqual(getConnectionUiState({
    connectionState: 'connected', toolCount: 0, discoveryStatus: 'pending',
    oauthStatus: authed(), authType: 'oauth'
  }), 'DISCOVERING');
});

await test('EMPTY only when discovery genuinely found zero tools', () => {
  assert.strictEqual(getConnectionUiState({
    connectionState: 'connected', toolCount: 0, discoveryStatus: 'ok',
    oauthStatus: authed(), authType: 'oauth'
  }), 'EMPTY');
});

await test('non-OAuth servers skip the authorization gate', () => {
  assert.strictEqual(getConnectionUiState({
    connectionState: 'connected', toolCount: 3, discoveryStatus: 'ok',
    oauthStatus: undefined, authType: 'header'
  }), 'READY');
  assert.strictEqual(getConnectionUiState({
    connectionState: 'connected', toolCount: 0, discoveryStatus: 'failed',
    oauthStatus: undefined, authType: 'none'
  }), 'DISCOVERY_FAILED');
});

console.log(`\nMCP OAuth UI state: ${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
