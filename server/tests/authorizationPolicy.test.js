/* JARVIS Action Substrate — slice 4A: authorization policy.
 *
 * Run with: node tests/authorizationPolicy.test.js
 *
 * Verifies:
 *   - verdict model: UNSPECIFIED / AUTO / APPROVAL_REQUIRED / DENIED
 *   - scope/risk-derived defaults (read / reversible / consequential)
 *   - explicit operator policy (deny / auto / approval_required / unspecified)
 *   - guest + workspace context gating
 *   - MCP authority cannot be weakened (denial is never converted to allow)
 *   - capability identity cannot be substituted / forged
 *   - malformed/missing metadata fails safe
 *   - engine is pure, deterministic, provider/model-free, Jev-free
 *   - complete native classification surfaces through the substrate
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const caps = require('../lib/capabilities');
const {
  authorizeCapability,
  isAuthorized,
  VERDICT_STATE,
  POLICY_SOURCE,
  REASON,
  DEFAULT_POLICY,
  MODE_TRANSITIONAL,
  MODE_ENFORCE,
  MODES,
} = caps.authorizationPolicy;

let pass = 0;
let fail = 0;

async function test(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err.message}`);
  }
}

// ---- fixture builders (mirror discover.js capability shape) ----------------

const nativeCap = (name, scope, risk) => ({
  id: `native:${name}`,
  source: 'native',
  name,
  wireName: name,
  serverSlug: null,
  description: `${name} fixture`,
  scope,
  risk,
  inputSchema: { type: 'object', properties: {} },
  annotations: null,
  metadata: {
    workspaceId: null,
    isGuest: false,
    serverId: null,
    configName: null,
    configScope: null,
  },
  timeoutMs: null,
  cancellation: 'cooperative',
  idempotency: 'safe',
  observability: 'line',
});

const mcpCap = (slug, tool, annotations, scope, risk) => ({
  id: `mcp.${slug}.${tool}`,
  source: 'mcp',
  name: tool,
  wireName: `mcp_${slug}_${tool}`,
  serverSlug: slug,
  description: `${tool} fixture`,
  scope,
  risk,
  inputSchema: { type: 'object', properties: {} },
  annotations: annotations || null,
  metadata: {
    workspaceId: null,
    isGuest: false,
    serverId: 'srv-1',
    configName: slug,
    configScope: 'workspace',
  },
  timeoutMs: null,
  cancellation: 'cooperative',
  idempotency: 'safe',
  observability: 'line',
});

const ctx = (overrides = {}) => ({
  userId: 'user-1',
  workspaceId: 'workspace-1',
  isGuest: false,
  ...overrides,
});

const main = async () => {

// ---- verdict-model basics ---------------------------------------------------

await test('read/low-risk capability is auto-allowed', () => {
  const v = authorizeCapability(nativeCap('getWeather', 'read', 'low'), ctx());
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.requiresApproval, false);
  assert.strictEqual(v.state, VERDICT_STATE.AUTO);
  assert.strictEqual(v.reason, REASON.AUTO_READ);
  assert.strictEqual(v.policySource, POLICY_SOURCE.CAPABILITY);
  assert.strictEqual(v.risk, 'low');
  assert.strictEqual(v.scope, 'read');
  assert.strictEqual(isAuthorized(v), true);
});

await test('reversible action is auto-allowed by default', () => {
  const v = authorizeCapability(nativeCap('playMedia', 'reversible', 'low'), ctx());
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.requiresApproval, false);
  assert.strictEqual(v.state, VERDICT_STATE.AUTO);
  assert.strictEqual(v.reason, REASON.AUTO_REVERSIBLE);
});

await test('consequential action requires approval (verdict only in 4A)', () => {
  const v = authorizeCapability(nativeCap('sendEmail', 'consequential', 'high'), ctx());
  assert.strictEqual(v.requiresApproval, true);
  assert.strictEqual(v.state, VERDICT_STATE.APPROVAL_REQUIRED);
  assert.strictEqual(v.reason, REASON.APPROVAL_CONSEQUENTIAL);
  assert.strictEqual(v.policySource, POLICY_SOURCE.CAPABILITY);
  // Transitional: approval-required is NOT silently treated as denied.
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.risk, 'high');
  assert.strictEqual(v.scope, 'consequential');
  assert.strictEqual(isAuthorized(v), false);
});

await test('explicit deny fails authorization even for a read capability', () => {
  const policy = {
    ...DEFAULT_POLICY,
    entries: [
      Object.freeze({ id: 'native:getWeather', action: 'deny', reason: 'operator-rule' }),
    ],
  };
  const v = authorizeCapability(nativeCap('getWeather', 'read', 'low'), ctx(), { policy });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.requiresApproval, false);
  assert.strictEqual(v.state, VERDICT_STATE.DENIED);
  assert.strictEqual(v.reason, 'operator-rule');
  assert.strictEqual(v.policySource, POLICY_SOURCE.POLICY_CONFIG);
});

await test('unspecified capability preserves legacy behavior', () => {
  const v = authorizeCapability(nativeCap('uncataloguedTool', null, null), ctx());
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.requiresApproval, false);
  assert.strictEqual(v.state, VERDICT_STATE.UNSPECIFIED);
  assert.strictEqual(v.reason, REASON.UNSPECIFIED);
  assert.strictEqual(v.policySource, POLICY_SOURCE.UNSPECIFIED);
});

await test('explicit operator approval_required and unspecified entries override scope', () => {
  const approvalPolicy = {
    ...DEFAULT_POLICY,
    entries: [
      Object.freeze({ id: 'native:checkCalendar', action: 'approval_required', reason: 'sensitive-read' }),
    ],
  };
  const a = authorizeCapability(nativeCap('checkCalendar', 'read', 'low'), ctx(), {
    policy: approvalPolicy,
  });
  assert.strictEqual(a.requiresApproval, true);
  assert.strictEqual(a.state, VERDICT_STATE.APPROVAL_REQUIRED);
  assert.strictEqual(a.reason, 'sensitive-read');

  const unspecifiedPolicy = {
    ...DEFAULT_POLICY,
    entries: [
      Object.freeze({ id: 'native:webSearch', action: 'unspecified' }),
    ],
  };
  const u = authorizeCapability(nativeCap('webSearch', 'read', 'low'), ctx(), {
    policy: unspecifiedPolicy,
  });
  assert.strictEqual(u.state, VERDICT_STATE.UNSPECIFIED);
  assert.strictEqual(u.allowed, true);
});

// ---- native classification --------------------------------------------------

await test('every registered native tool is classified (metadata complete)', () => {
  const native = caps.discoverNative();
  assert.ok(native.length >= 20, `expected >= 20 native tools, got ${native.length}`);
  const unclassified = native
    .filter((c) => c.scope === null || c.risk === null)
    .map((c) => c.name);
  assert.deepStrictEqual(unclassified, [], `unclassified: ${unclassified.join(', ')}`);
});

await test('specified native classifications match implementations', () => {
  const native = caps.discoverNative();
  const byName = (n) => native.find((c) => c.name === n);
  const expect = {
    getTime: ['read', 'low'],
    getWeather: ['read', 'low'],
    getTopNews: ['read', 'low'],
    webSearch: ['read', 'low'],
    scrapeWebsite: ['read', 'low'],
    checkCalendar: ['read', 'low'],
    recallMemory: ['read', 'low'],
    executeCode: ['read', 'medium'],
    deepResearchSwarm: ['read', 'medium'],
    playMedia: ['reversible', 'low'],
    stopMedia: ['reversible', 'low'],
    changeTheme: ['reversible', 'low'],
    openWebsite: ['reversible', 'low'],
    copyToClipboard: ['reversible', 'low'],
    createReminder: ['reversible', 'low'],
    setReminder: ['reversible', 'low'],
    stopReminder: ['reversible', 'low'],
    memorize: ['reversible', 'low'],
    storeUserFact: ['reversible', 'low'],
    sendEmail: ['consequential', 'high'],
    sendWhatsAppMessage: ['consequential', 'high'],
    scheduleMeeting: ['consequential', 'high'],
  };
  for (const [name, [scope, risk]] of Object.entries(expect)) {
    const cap = byName(name);
    assert.ok(cap, `native tool ${name} missing from discovery`);
    assert.strictEqual(`${cap.name}:${cap.scope}`, `${name}:${scope}`);
    assert.strictEqual(`${cap.name}:${cap.risk}`, `${name}:${risk}`);
  }
});

// ---- MCP annotations + authority -------------------------------------------

await test('MCP readOnlyHint capability is auto-allowed once MCP-authorised', () => {
  const cap = mcpCap('linear', 'list-issues', { readOnlyHint: true }, 'read', 'low');
  const v = authorizeCapability(cap, ctx(), { mcpAuthorized: true });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.requiresApproval, false);
  assert.strictEqual(v.reason, REASON.AUTO_READ);
});

await test('MCP consequential capability gets capability-tier approval on top of MCP allow', () => {
  const cap = mcpCap('linear', 'create-issue', { openWorldHint: true }, 'consequential', 'medium');
  const v = authorizeCapability(cap, ctx(), { mcpAuthorized: true });
  assert.strictEqual(v.requiresApproval, true);
  assert.strictEqual(v.state, VERDICT_STATE.APPROVAL_REQUIRED);
  assert.strictEqual(v.reason, REASON.APPROVAL_CONSEQUENTIAL);
});

await test('MCP denial can never be converted into allow', () => {
  const cap = mcpCap('notion', 'read-page', { readOnlyHint: true }, 'read', 'low');
  const policy = {
    ...DEFAULT_POLICY,
    entries: [Object.freeze({ id: cap.id, action: 'auto' })],
  };
  const v = authorizeCapability(cap, ctx(), { policy, mcpAuthorized: false });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.state, VERDICT_STATE.DENIED);
  assert.strictEqual(v.reason, REASON.MCP_DENIED);
  assert.strictEqual(v.policySource, POLICY_SOURCE.MCP_AUTHORITY);
  // The most permissive operator override cannot flip an MCP denial.
  const vUnconfirmed = authorizeCapability(cap, ctx(), { policy });
  assert.strictEqual(vUnconfirmed.allowed, false);
  assert.strictEqual(vUnconfirmed.reason, REASON.MCP_UNCONFIRMED);
});

await test('unannotated MCP capability stays unspecified (legacy-compatible)', () => {
  const cap = mcpCap('some-server', 'mystery-tool', null, null, null);
  const v = authorizeCapability(cap, ctx(), { mcpAuthorized: true });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.state, VERDICT_STATE.UNSPECIFIED);
});

// ---- context (guest / workspace) -------------------------------------------

await test('guest context is enforced via operator policy', () => {
  const policy = {
    ...DEFAULT_POLICY,
    guestDenied: Object.freeze(['native:storeUserFact']),
  };
  const guest = ctx({ isGuest: true });
  const deniedV = authorizeCapability(nativeCap('storeUserFact', 'reversible', 'low'), guest, {
    policy,
  });
  assert.strictEqual(deniedV.allowed, false);
  assert.strictEqual(deniedV.reason, REASON.GUEST_DENIED);
  assert.strictEqual(deniedV.state, VERDICT_STATE.DENIED);

  // Same capability, authenticated user -> unaffected.
  const allowedV = authorizeCapability(nativeCap('storeUserFact', 'reversible', 'low'), ctx(), {
    policy,
  });
  assert.strictEqual(allowedV.allowed, true);

  // Guest without a rule -> legacy behavior preserved.
  const other = authorizeCapability(nativeCap('getTime', 'read', 'low'), guest, {
    policy,
  });
  assert.strictEqual(other.allowed, true);
});

await test('workspace context is enforced via operator policy', () => {
  const policy = {
    ...DEFAULT_POLICY,
    workspaceRestricted: Object.freeze([
      Object.freeze({ id: 'native:sendEmail', workspaceIds: Object.freeze(['allowed-ws']) }),
    ]),
  };
  const out = authorizeCapability(nativeCap('sendEmail', 'consequential', 'high'), ctx({
    workspaceId: 'other-ws',
  }), { policy });
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.reason, REASON.WORKSPACE_DENIED);

  const in_ = authorizeCapability(nativeCap('sendEmail', 'consequential', 'high'), ctx({
    workspaceId: 'allowed-ws',
  }), { policy });
  assert.strictEqual(in_.allowed, true);

  // No matching rule -> no gating.
  const none = authorizeCapability(nativeCap('getTime', 'read', 'low'), ctx({
    workspaceId: 'other-ws',
  }), { policy });
  assert.strictEqual(none.allowed, true);
});

// ---- identity / malformed safety -------------------------------------------

await test('capability ID/source cannot be substituted', () => {
  const substituted = { ...nativeCap('getTime', 'read', 'low'), name: 'getWeather' };
  const v = authorizeCapability(substituted, ctx());
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.reason, REASON.IDENTITY_MISMATCH);

  const noSlug = { ...mcpCap('linear', 'list-issues', null, 'read', 'low') };
  delete noSlug.serverSlug;
  const v2 = authorizeCapability(noSlug, ctx(), { mcpAuthorized: true });
  assert.strictEqual(v2.allowed, false);
  assert.strictEqual(v2.reason, REASON.IDENTITY_MISMATCH);

  const badWire = { ...mcpCap('linear', 'list-issues', null, 'read', 'low'), wireName: 'getTime' };
  const v3 = authorizeCapability(badWire, ctx(), { mcpAuthorized: true });
  assert.strictEqual(v3.allowed, false);
  assert.strictEqual(v3.reason, REASON.IDENTITY_MISMATCH);
});

await test('malformed/missing capability metadata fails safe', () => {
  const noCap = authorizeCapability(null, ctx());
  assert.strictEqual(noCap.allowed, false);
  assert.strictEqual(noCap.state, VERDICT_STATE.MALFORMED);
  assert.strictEqual(noCap.reason, REASON.MALFORMED);

  const badSource = authorizeCapability({ ...nativeCap('getTime', 'read', 'low'), source: 'spellbook' }, ctx());
  assert.strictEqual(badSource.allowed, false);
  assert.strictEqual(badSource.state, VERDICT_STATE.MALFORMED);

  const badScope = authorizeCapability({ ...nativeCap('getTime', 'cosmic', 'low') }, ctx());
  assert.strictEqual(badScope.allowed, false);
  assert.strictEqual(badScope.state, VERDICT_STATE.MALFORMED);

  const missingId = { ...nativeCap('getTime', 'read', 'low') };
  delete missingId.id;
  const v = authorizeCapability(missingId, ctx());
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.state, VERDICT_STATE.MALFORMED);

  // MCP capability with no projection confirmed -> fails safe.
  const mcpNoProjection = authorizeCapability(mcpCap('linear', 'list', null, 'read', 'low'), ctx());
  assert.strictEqual(mcpNoProjection.allowed, false);
  assert.strictEqual(mcpNoProjection.reason, REASON.MCP_UNCONFIRMED);
});

// ---- substrate identity resolution -----------------------------------------

await test('authorization resolves capability identity from the authoritative substrate', async () => {
  const registry = await caps.buildCapabilityRegistry({ workspaceId: null, isGuest: false });
  const getTime = registry.byId('native:getTime');
  assert.ok(getTime, 'expected native:getTime in the aggregate registry');
  const sendEmail = registry.byId('native:sendEmail');
  assert.ok(sendEmail, 'expected native:sendEmail in the aggregate registry');

  const a = authorizeCapability(getTime, ctx());
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.reason, REASON.AUTO_READ);

  const b = authorizeCapability(sendEmail, ctx());
  assert.strictEqual(b.requiresApproval, true);
  assert.strictEqual(b.risk, 'high');
  assert.strictEqual(b.scope, 'consequential');
});

// ---- purity / determinism ---------------------------------------------------

await test('policy engine is deterministic and does not mutate inputs', () => {
  const cap = nativeCap('sendEmail', 'consequential', 'high');
  const snapshot = JSON.stringify(cap);
  const v1 = authorizeCapability(cap, ctx(), { mcpAuthorized: false });
  const v2 = authorizeCapability(cap, ctx(), { mcpAuthorized: false });
  assert.deepStrictEqual(v1, v2);
  assert.strictEqual(JSON.stringify(cap), snapshot);
});

await test('verdict contract carries risk and scope through every state', () => {
  for (const [scope, risk] of [
    ['read', 'low'],
    ['reversible', 'medium'],
    ['consequential', 'high'],
    [null, null],
  ]) {
    const v = authorizeCapability(nativeCap('x', scope, risk), ctx());
    assert.ok('allowed' in v, 'verdict has allowed');
    assert.ok('requiresApproval' in v, 'verdict has requiresApproval');
    assert.ok('state' in v, 'verdict has state');
    assert.ok('reason' in v, 'verdict has reason');
    assert.ok('policySource' in v, 'verdict has policySource');
    assert.strictEqual(v.risk, risk);
    assert.strictEqual(v.scope, scope);
  }
});

await test('constants are frozen so policy vocabulary cannot drift', () => {
  assert.ok(Object.isFrozen(VERDICT_STATE));
  assert.ok(Object.isFrozen(POLICY_SOURCE));
  assert.ok(Object.isFrozen(REASON));
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_POLICY.entries));
  assert.deepStrictEqual([MODES], [[MODE_TRANSITIONAL, MODE_ENFORCE]]);
});

await test('transitional vs enforce modes diverge only on approval', () => {
  const cap = nativeCap('sendEmail', 'consequential', 'high');
  const transitional = authorizeCapability(cap, ctx(), { mode: MODE_TRANSITIONAL });
  assert.strictEqual(transitional.allowed, true);
  const enforce = authorizeCapability(cap, ctx(), { mode: MODE_ENFORCE });
  assert.strictEqual(enforce.allowed, false);
  assert.strictEqual(enforce.requiresApproval, true);
  assert.strictEqual(enforce.state, VERDICT_STATE.APPROVAL_REQUIRED);
});

// ---- engine purity: no provider/model/Jev coupling -------------------------

await test('no provider/model state is consulted (pure leaf module)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'capabilities', 'authorizationPolicy.js'),
    'utf8',
  );
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ['./capabilityTypes'], `unexpected requires: ${requires.join(', ')}`);
  for (const forbidden of ['AIService', 'LLMRouter', 'toolSelection', 'decision', 'tools', 'http', 'fs']) {
    assert.ok(!src.includes(`require('${forbidden}`) && !src.includes(`require("./${forbidden}`) && !src.includes(`require("../${forbidden}`),
      `authorizationPolicy must not couple to ${forbidden}`);
  }
});

await test('no Jev execution is triggered by the policy engine', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'capabilities', 'authorizationPolicy.js'),
    'utf8',
  );
  // Code only (comments stripped) must not reach into the decision/Jev plane:
  // no require() of decision code (already covered by the purity test) and no
  // reference to the decision engine API surface.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/require\(['"][^'"]*decision|decide\(|DecisionEngine|JevDecisionEngine/.test(codeOnly),
    'engine code must not call into the decision/Jev plane');
  // The engine exposes no execution surface.
  const engine = caps.authorizationPolicy;
  assert.strictEqual(typeof engine.authorizeCapability, 'function');
  assert.strictEqual(typeof engine.execute, 'undefined');
  assert.strictEqual(typeof engine.callTool, 'undefined');
});

console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});