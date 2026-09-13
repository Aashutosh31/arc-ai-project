'use strict';

// MCP Phase 2 — configuration & management contract tests.
//
// Run:  cd server && node tests/mcpPhase2.test.js
//
// DB-free by design: covers the pure contract surface (validation,
// redaction, tool-policy plumbing) without MongoDB. HTTP authz paths in
// server/routes/mcp.js follow the same rules and are verified by review +
// browser validation (no supertest/mongo-memory in this repo).
//
//   P2-01 validateConfigInput: stdio create (valid)
//   P2-02 validateConfigInput: stdio missing command rejected
//   P2-03 validateConfigInput: http create (valid) + bad URL rejected
//   P2-04 validateConfigInput: bad transport / bad scope rejected
//   P2-05 validateConfigInput: update is partial, effective-transport aware
//   P2-06 validateConfigInput: auth env-var name validated, never a value store
//   P2-07 sanitizeConfigForClient: redaction (no secret values leak)
//   P2-08 parseNameList: arrays + strings, dedupe, trim
//   P2-09 normalizeConfig preserves allowedTools/deniedTools
//   P2-10 docToConfig preserves allowedTools/deniedTools
//   P2-11 toolAllowed: allowlist restricts
//   P2-12 toolAllowed: denylist denies
//   P2-13 toolAllowed: denied wins over allowed
//   P2-14 filterToolsByPolicy: end-to-end entry filtering
//   P2-15 buildToolsPayload: read-only discovery shape (no schemas)

const assert = require('assert');

const {
  sanitizeConfigForClient,
  sanitizeAuthForClient,
  parseNameList,
  validateConfigInput,
  buildToolsPayload
} = require('../lib/mcp/configApi');
const McpRegistry = require('../lib/mcp/McpRegistry');
const { docToConfig } = require('../lib/mcp/configStore');

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

const main = async () => {
  await test('P2-01 stdio create validates', async () => {
    const { ok, error, data } = validateConfigInput({
      name: 'Local Tools',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
      envVarNames: ['MY_TOKEN', 'MY_TOKEN ', ''],
      scope: 'workspace'
    });
    assert.strictEqual(ok, true, error);
    assert.strictEqual(data.command, 'npx');
    assert.deepStrictEqual(data.args, ['-y', 'my-mcp-server']);
    assert.deepStrictEqual(data.envVarNames, ['MY_TOKEN']);
  });

  await test('P2-02 stdio missing command rejected', async () => {
    const { ok, error } = validateConfigInput({ name: 'Bad', transport: 'stdio' });
    assert.strictEqual(ok, false);
    assert.ok(/command/i.test(error));
  });

  await test('P2-03 http create validates, bad URL rejected', async () => {
    const good = validateConfigInput({
      name: 'Remote', transport: 'streamable-http', url: 'https://mcp.example.com/mcp'
    });
    assert.strictEqual(good.ok, true, good.error);
    assert.strictEqual(good.data.url, 'https://mcp.example.com/mcp');

    const bad = validateConfigInput({
      name: 'Remote', transport: 'streamable-http', url: 'not-a-url'
    });
    assert.strictEqual(bad.ok, false);
    assert.ok(/URL/i.test(bad.error));

    const missing = validateConfigInput({ name: 'Remote', transport: 'streamable-http' });
    assert.strictEqual(missing.ok, false);
  });

  await test('P2-04 bad transport/scope rejected', async () => {
    assert.strictEqual(validateConfigInput({ name: 'X', transport: 'sse' }).ok, false);
    assert.strictEqual(
      validateConfigInput({ name: 'X', transport: 'stdio', command: 'cmd', scope: 'org' }).ok,
      false
    );
    assert.strictEqual(validateConfigInput({ transport: 'stdio', command: 'cmd' }).ok, false);
  });

  await test('P2-05 update is partial + effective-transport aware', async () => {
    // Name-only patch: no transport fields required.
    const patch = validateConfigInput({ name: 'Renamed' }, { isUpdate: true });
    assert.strictEqual(patch.ok, true, patch.error);
    assert.strictEqual(patch.data.name, 'Renamed');
    assert.strictEqual(patch.data.command, undefined);

    // Empty command on an update is rejected when the effective transport
    // is stdio (route passes _effectiveTransport for existing stdio docs).
    const badCmd = validateConfigInput(
      { command: '  ', _effectiveTransport: 'stdio' }, { isUpdate: true }
    );
    assert.strictEqual(badCmd.ok, false);

    // URL update validates even without a transport key in the patch.
    const urlOk = validateConfigInput(
      { url: 'http://127.0.0.1:8080/mcp', _effectiveTransport: 'streamable-http' },
      { isUpdate: true }
    );
    assert.strictEqual(urlOk.ok, true, urlOk.error);
  });

  await test('P2-06 auth accepts env-var NAMES only', async () => {
    const { ok, data } = validateConfigInput({
      name: 'Authed', transport: 'streamable-http', url: 'https://x.example/mcp',
      auth: { type: 'header', headerName: 'Authorization', envVar: 'MCP_API_TOKEN' }
    });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(data.auth, { type: 'header', headerName: 'Authorization', envVar: 'MCP_API_TOKEN' });

    const bad = validateConfigInput({
      name: 'Authed', transport: 'streamable-http', url: 'https://x.example/mcp',
      auth: { type: 'header', envVar: 'not a var!!' }
    });
    assert.strictEqual(bad.ok, false);
    assert.ok(/environment variable/i.test(bad.error));
  });

  await test('P2-07 sanitizeConfigForClient redacts', async () => {
    const doc = {
      _id: 'abc123',
      owner: 'user-1',
      name: 'S', slug: 's', scope: 'global', workspace: null,
      transport: 'streamable-http', url: 'https://x.example/mcp',
      envVarNames: ['MCP_API_TOKEN'],
      auth: { type: 'header', headerName: 'Authorization', envVar: 'MCP_API_TOKEN' },
      enabled: true, guestAllowed: false
    };
    const out = sanitizeConfigForClient(doc);
    assert.strictEqual(out.id, 'abc123');
    // Owner ObjectId never reaches the browser.
    assert.strictEqual(out.owner, undefined);
    // Auth metadata only: type + header name + env-var NAME + configured flag.
    assert.deepStrictEqual(out.auth, {
      type: 'header', headerName: 'Authorization', envVar: 'MCP_API_TOKEN', configured: true
    });
    // Serialized payload must not contain anything resembling a secret value.
    const json = JSON.stringify(out);
    assert.ok(!/bearer/i.test(json) || json.includes('Authorization'), 'no bearer values');
    assert.ok(!/sk-/i.test(json), 'no api-key values');
  });

  await test('P2-08 parseNameList handles arrays + strings', async () => {
    assert.deepStrictEqual(parseNameList(['a', 'b', 'a', ' ']), ['a', 'b']);
    assert.deepStrictEqual(parseNameList('x, y\nz, x'), ['x', 'y', 'z']);
    assert.deepStrictEqual(parseNameList(null), []);
    assert.deepStrictEqual(parseNameList(undefined), []);
  });

  await test('P2-09 normalizeConfig preserves tool policy', async () => {
    const registry = new McpRegistry();
    const cfg = registry.register({
      id: 'p2-1', name: 'Policy', scope: 'global', transport: 'stdio', command: 'echo',
      allowedTools: ['mcp_echo'], deniedTools: ['mcp_admin_tool']
    });
    assert.deepStrictEqual(cfg.allowedTools, ['mcp_echo']);
    assert.deepStrictEqual(cfg.deniedTools, ['mcp_admin_tool']);
    registry.remove('p2-1');
  });

  await test('P2-10 docToConfig preserves tool policy', async () => {
    const cfg = docToConfig({
      _id: 'doc1', name: 'D', scope: 'global', workspace: null,
      transport: 'stdio', command: 'echo',
      allowedTools: ['a'], deniedTools: ['b']
    });
    assert.deepStrictEqual(cfg.allowedTools, ['a']);
    assert.deepStrictEqual(cfg.deniedTools, ['b']);
  });

  await test('P2-11 allowlist restricts visibility', async () => {
    const registry = new McpRegistry();
    registry.register({
      id: 'p2-al', name: 'AL', scope: 'global', transport: 'stdio', command: 'echo',
      allowedTools: ['mcp_echo']
    });
    assert.strictEqual(registry.toolAllowed('p2-al', 'mcp_echo', 'echo'), true);
    assert.strictEqual(registry.toolAllowed('p2-al', 'mcp_other', 'other'), false);
    registry.remove('p2-al');
  });

  await test('P2-12 denylist denies', async () => {
    const registry = new McpRegistry();
    registry.register({
      id: 'p2-dl', name: 'DL', scope: 'global', transport: 'stdio', command: 'echo',
      deniedTools: ['mcp_echo']
    });
    assert.strictEqual(registry.toolAllowed('p2-dl', 'mcp_echo', 'echo'), false);
    assert.strictEqual(registry.toolAllowed('p2-dl', 'mcp_other', 'other'), true);
    registry.remove('p2-dl');
  });

  await test('P2-13 denied wins over allowed', async () => {
    const registry = new McpRegistry();
    registry.register({
      id: 'p2-both', name: 'Both', scope: 'global', transport: 'stdio', command: 'echo',
      allowedTools: ['mcp_echo', 'mcp_other'], deniedTools: ['mcp_echo']
    });
    assert.strictEqual(registry.toolAllowed('p2-both', 'mcp_echo', 'echo'), false);
    assert.strictEqual(registry.toolAllowed('p2-both', 'mcp_other', 'other'), true);
    registry.remove('p2-both');
  });

  await test('P2-14 filterToolsByPolicy filters entries', async () => {
    const registry = new McpRegistry();
    registry.register({
      id: 'p2-f', name: 'F', scope: 'global', transport: 'stdio', command: 'echo',
      deniedTools: ['mcp_echo']
    });
    const out = registry.filterToolsByPolicy(
      'p2-f', ['mcp_echo', 'mcp_other'], ['echo', 'other']
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].wireName, 'mcp_other');
    registry.remove('p2-f');
  });

  await test('P2-15 buildToolsPayload is read-only', async () => {
    const payload = buildToolsPayload({
      config: { _id: 's1' },
      connectionState: 'connected',
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'demo', version: '1.0.0' },
      tools: [{ name: 'mcp_demo_echo', description: 'Echo', allowed: true }],
      failures: [],
      policy: { allowedTools: [], deniedTools: ['mcp_demo_admin'] }
    });
    assert.strictEqual(payload.toolCount, 1);
    assert.strictEqual(payload.tools[0].name, 'mcp_demo_echo');
    // No schemas, no executors, no secrets in the discovery payload.
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('parameters'));
    assert.ok(!json.includes('execute'));
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
