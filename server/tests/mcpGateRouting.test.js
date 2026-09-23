'use strict';

// MCP-discovery gate routing tests (DB-free).
//
// Guards the native-capability short-circuit: intents the app resolves with
// native tools (getTime / getWeather / setReminder / changeTheme / playMedia)
// must NOT trigger MCP discovery, while genuine integration requests (Linear,
// Notion, Google Calendar) MUST stay on the MCP path. The gate is the cheap
// per-request predicate; the downstream selector still owns *which* tools.
//
// Run:  cd server && node tests/mcpGateRouting.test.js

const assert = require('assert');

const ai = require('../services/AIService');
const { selectToolSchemas } = require('../lib/llm/toolSelection');
const nativeSchemas = () => require('../tools').getSchemas();

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const main = async () => {
  // ---- native-addressed intents skip MCP discovery ---------------------------
  await test('R-01 "use the time tool" is native-only (no MCP discovery)', async () => {
    const g = ai.checkMcpDiscoveryGate(
      'Use the time tool and tell me the current time right now.',
    );
    assert.strictEqual(g.required, false, `required=true: ${JSON.stringify(g)}`);
    assert.strictEqual(g.nativeOnly, true, 'not classified native-only');
    assert.strictEqual(g.nativeKnowledge, true, 'native knowledge verb missed');
  });

  await test('R-02 "current time" phrasing is native-only', async () => {
    const g = ai.checkMcpDiscoveryGate('What is the current time?');
    assert.strictEqual(g.required, false, JSON.stringify(g));
    assert.strictEqual(g.nativeOnly, true);
  });

  await test('R-03 theme change is native-only (side-effect cap natively covered)', async () => {
    const g = ai.checkMcpDiscoveryGate('Change the theme to dark mode.');
    assert.strictEqual(g.required, false, JSON.stringify(g));
    assert.strictEqual(g.hasSideEffect, true, 'UPDATE cap not detected');
    assert.strictEqual(g.nativeOnly, true, 'native only must cover the side effect');
  });

  await test('R-04 play/media is native-only', async () => {
    const g = ai.checkMcpDiscoveryGate('Play a song by Coldplay.');
    assert.strictEqual(g.required, false, JSON.stringify(g));
  });

  await test('R-05 weather/forecast is native-only', async () => {
    const g = ai.checkMcpDiscoveryGate('Show me the weather forecast in Paris.');
    assert.strictEqual(g.required, false, JSON.stringify(g));
    assert.strictEqual(g.nativeKnowledge, true);
  });

  await test('R-06 reminder is native-only', async () => {
    const g = ai.checkMcpDiscoveryGate('Remind me to call the dentist tomorrow.');
    assert.strictEqual(g.required, false, JSON.stringify(g));
    assert.strictEqual(g.nativeKnowledge, true);
  });

  await test('R-07 meeting scheduling is native-only (scheduleMeeting)', async () => {
    const g = ai.checkMcpDiscoveryGate('Schedule a meeting with Ada next Tuesday at 3pm.');
    assert.strictEqual(g.required, false, JSON.stringify(g));
    assert.strictEqual(g.nativeKnowledge, true);
  });

  await test('R-08 generic reminder creation is native-only', async () => {
    const g = ai.checkMcpDiscoveryGate('Create a reminder to water the plants.');
    assert.strictEqual(g.required, false, JSON.stringify(g));
    assert.strictEqual(g.nativeOnly, true);
  });

  // ---- genuine integration requests stay on the MCP path --------------------
  await test('R-10 Linear search stays MCP', async () => {
    const g = ai.checkMcpDiscoveryGate('Search my Linear issues for the login bug.');
    assert.strictEqual(g.required, true, JSON.stringify(g));
    assert.strictEqual(g.externalTarget, true);
  });

  await test('R-11 Linear create stays MCP', async () => {
    const g = ai.checkMcpDiscoveryGate(
      "Create a Linear issue called Fix login with the description 'Auth fails.'",
    );
    assert.strictEqual(g.required, true, JSON.stringify(g));
    assert.strictEqual(g.externalTarget, true);
  });

  await test('R-12 NotImplemented page in workspace stays MCP (uncovered native domain)', async () => {
    const g = ai.checkMcpDiscoveryGate('Create a page in my workspace.');
    assert.strictEqual(g.required, true, JSON.stringify(g));
    assert.strictEqual(g.nativeOnly, false);
  });

  await test('R-13 Notion calendar stays MCP', async () => {
    const g = ai.checkMcpDiscoveryGate('Check my Notion calendar for tomorrow.');
    assert.strictEqual(g.required, true, JSON.stringify(g));
    assert.strictEqual(g.externalTarget, true);
  });

  await test('R-14 explicit web lookup stays MCP', async () => {
    const g = ai.checkMcpDiscoveryGate('Search the web for the latest laptop reviews.');
    assert.strictEqual(g.required, true, JSON.stringify(g));
    assert.strictEqual(g.explicitLookup, true);
  });

  await test('R-15 generic issue creation stays MCP (issue is an external target)', async () => {
    const g = ai.checkMcpDiscoveryGate('Create an issue for the login bug.');
    assert.strictEqual(g.required, true, JSON.stringify(g));
    assert.strictEqual(g.externalTarget, true);
  });

  // ---- native tool still selected on the downstream path ----------------------
  await test('R-20 getTime still offered by selection with empty MCP pool', async () => {
    const sel = selectToolSchemas('What is the current time?', nativeSchemas, {
      mcpSchemas: [],
    });
    const names = (sel.tools || []).map((s) => s?.function?.name);
    assert.ok(names.includes('getTime'), `getTime missing from: ${names.join(',')}`);
  });

  await test('R-21 changeTheme still offered by selection with empty MCP pool', async () => {
    const sel = selectToolSchemas('Change the theme to dark mode.', nativeSchemas, {
      mcpSchemas: [],
    });
    const names = (sel.tools || []).map((s) => s?.function?.name);
    assert.ok(names.includes('changeTheme'), `changeTheme missing from: ${names.join(',')}`);
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });