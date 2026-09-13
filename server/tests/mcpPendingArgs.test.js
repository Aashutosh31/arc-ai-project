'use strict';

// Pending tool-call (multi-turn argument collection) regression tests (DB-free).
//
// Production failure: `mcp_mcp_reference_annotatedMessage` requires
// { messageType, includeImage }. Each turn was stateless — provider messages
// carry only the current user turn, selection re-ran on fragmentary text
// ("success" -> zero MCP tools), nothing validated `required` client-side,
// and no code stored partial args. "success" lived nowhere, "true" could
// never merge into it, the model had no schema, so it asked again forever.
//
// These tests drive the deterministic pending-args state machine
// (server/lib/llm/pendingArgs.js) plus its integration with selection and
// continuation. AIService persistence (Conversation.pendingToolCall) is thin
// IO over this machine and is failure-silent by design.
//
// Run:  cd server && node tests/mcpPendingArgs.test.js

const assert = require('assert');

const P = require('../lib/llm/pendingArgs');
const {
  selectToolSchemas,
  selectContinuationTools,
  partitionToolCallsByExposure
} = require('../lib/llm/toolSelection');
const toolRegistry = require('../tools/index');

const ALL_NATIVE = toolRegistry.getSchemas();

let pass = 0;
let fail = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok - ${label}`);
  } catch (err) {
    fail += 1;
    failures.push({ label, err });
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err && err.message}`);
  }
}

// Production annotatedMessage shape: messageType enum + includeImage boolean.
const ANNOTATED = {
  type: 'function',
  function: {
    name: 'mcp_mcp_reference_annotatedMessage',
    description: 'Generate an annotated message with an optional example image.',
    parameters: {
      type: 'object',
      properties: {
        messageType: { type: 'string', enum: ['error', 'success', 'debug'] },
        includeImage: { type: 'boolean' }
      },
      required: ['messageType', 'includeImage']
    }
  }
};
const TARGET = ANNOTATED.function.name;
const MCP = [ANNOTATED,
  { type: 'function', function: { name: 'mcp_mcp_reference_getTinyImage', description: 'Fetch a tiny image.', parameters: { type: 'object', properties: {} } } }
];
// Generic native-style schema: two required open strings.
const NATIVE_TWO_STRINGS = {
  type: 'function',
  function: {
    name: 'planSession',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string' }, time: { type: 'string' } },
      required: ['date', 'time']
    }
  }
};

const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);

async function run() {
  // A. No arguments -> ask for missing arguments.
  await check('P-01 no args asks for all missing with options', () => {
    const pend = P.createPending(TARGET, {}, ANNOTATED);
    assert.deepStrictEqual(pend.missing, ['messageType', 'includeImage']);
    const q = P.buildClarification(TARGET, P.requiredParams(ANNOTATED), {});
    assert.ok(q.includes('messageType') && q.includes('includeImage'), q);
    assert.ok(q.includes('"error"') && q.includes('"success"') && q.includes('"debug"'), q);
    assert.ok(q.includes('true/false'), q);
  });

  // B. messageType only -> preserved, ask only for includeImage.
  await check('P-02 first argument survives, ask names only the remainder', () => {
    const pend = P.createPending(TARGET, {}, ANNOTATED);
    const r = P.advancePending(pend, 'success', ANNOTATED);
    assert.strictEqual(r.action, 'ask');
    assert.deepStrictEqual(r.missing, ['includeImage']);
    assert.ok(r.question.includes('includeImage'), r.question);
    assert.ok(!r.question.includes('messageType ('), `re-asks captured: ${r.question}`);
    assert.ok(r.question.includes('messageType="success"'), `kept note missing: ${r.question}`);
  });

  // C. includeImage only -> preserved, ask only for messageType.
  await check('P-03 reverse order also merges', () => {
    const pend = P.createPending(TARGET, {}, ANNOTATED);
    const r = P.advancePending(pend, 'true', ANNOTATED);
    assert.strictEqual(r.action, 'ask');
    assert.deepStrictEqual(r.missing, ['messageType']);
    assert.ok(r.question.includes('messageType') && !r.question.includes('includeImage ('), r.question);
  });

  // D. Both supplied -> exactly one tool call, no clarification.
  await check('P-04 complete args produce exactly one tool call, no question', () => {
    const pend = P.createPending(TARGET, {}, ANNOTATED);
    const r1 = P.advancePending(pend, 'success', ANNOTATED);
    const r2 = P.advancePending(r1.pending, 'true', ANNOTATED);
    assert.strictEqual(r2.action, 'execute');
    assert.deepStrictEqual(r2.args, { messageType: 'success', includeImage: true });
    assert.strictEqual(r2.question, undefined, 'no clarification after complete args');
    assert.deepStrictEqual(r2.missing, []);
  });

  // E. Both in one message.
  await check('P-05 "success and true" extracts both and executes', () => {
    const r = P.advancePending(P.createPending(TARGET, {}, ANNOTATED), 'success and true', ANNOTATED);
    assert.strictEqual(r.action, 'execute');
    assert.deepStrictEqual(r.args, { messageType: 'success', includeImage: true });
  });

  // F. Invalid value preserves prior valid args.
  await check('P-06 "banana" asks again without losing valid args', () => {
    const pend = P.createPending(TARGET, { messageType: 'success' }, ANNOTATED);
    const r = P.advancePending(pend, 'banana', ANNOTATED);
    assert.strictEqual(r.action, 'ask');
    assert.deepStrictEqual(r.args, { messageType: 'success' });
    assert.deepStrictEqual(r.missing, ['includeImage']);
  });

  // Boolean false is a real value, not missing.
  await check('P-07 includeImage:false completes (false is not missing)', () => {
    const v = P.validateArgs(ANNOTATED, { messageType: 'debug', includeImage: false });
    assert.strictEqual(v.ok, true);
    assert.deepStrictEqual(v.coerced, { messageType: 'debug', includeImage: false });
    assert.deepStrictEqual(P.missingRequired(ANNOTATED, { messageType: 'debug', includeImage: false }), []);
  });

  // Exact production 3-turn sequence.
  await check('P-08 exact regression: execute -> success -> true yields one call', () => {
    // Turn 1: "execute mcp_mcp_reference_annotatedMessage" — selection offers
    // the tool (previous fix), user text supplies no args -> pending + ask.
    const pick = selectToolSchemas(
      'execute mcp_mcp_reference_annotatedMessage', () => ALL_NATIVE, { mcpSchemas: MCP, mcpBlocked: [] }
    );
    assert.ok(names(pick.tools).includes(TARGET), 'tool offered on turn 1');
    const extracted1 = P.extractArgValues(
      'execute mcp_mcp_reference_annotatedMessage', P.requiredParams(ANNOTATED)
    );
    assert.deepStrictEqual(extracted1, {}, 'turn 1 text carries no values');
    let pend = P.createPending(TARGET, extracted1, ANNOTATED);
    assert.deepStrictEqual(pend.missing, ['messageType', 'includeImage']);
    // Turn 2: "success".
    const t2 = P.advancePending(pend, 'success', ANNOTATED);
    assert.strictEqual(t2.action, 'ask');
    pend = t2.pending;
    // Turn 3: "true" -> exactly one invocation, no further clarification.
    const t3 = P.advancePending(pend, 'true', ANNOTATED);
    assert.strictEqual(t3.action, 'execute');
    const invocation = {
      name: TARGET,
      arguments: t3.args
    };
    assert.deepStrictEqual(invocation, {
      name: 'mcp_mcp_reference_annotatedMessage',
      arguments: { messageType: 'success', includeImage: true }
    });
  });

  // Continuation preserves the active (pending-completed) tool.
  await check('P-09 synthetic pending call survives continuation tools', () => {
    const prev = selectToolSchemas('true', () => ALL_NATIVE, { mcpSchemas: MCP, mcpBlocked: [] }).tools;
    assert.ok(!names(prev).includes(TARGET), 'precondition: fragmentary turn offers no MCP');
    const syntheticCalls = [{
      id: 'pending-abc',
      function: { name: TARGET, arguments: { messageType: 'success', includeImage: true } }
    }];
    const cont = selectContinuationTools(
      prev, [TARGET], () => ALL_NATIVE, { mcpSchemas: MCP }
    );
    assert.ok(names(cont.tools).includes(TARGET), 'active tool preserved');
    const exposure = partitionToolCallsByExposure(syntheticCalls, cont.tools);
    assert.deepStrictEqual(exposure.unexposedNames, [], 'synthetic call exposed');
  });

  // Policy: denied tool never enters pending (gate uses the exposed set only).
  await check('P-10 denied MCP tool cannot enter pending state', () => {
    const exposed = MCP.filter((s) => s.function.name !== TARGET);
    const blocked = MCP.filter((s) => s.function.name === TARGET);
    const pick = selectToolSchemas(
      'execute mcp_mcp_reference_annotatedMessage', () => ALL_NATIVE, { mcpSchemas: exposed, mcpBlocked: blocked }
    );
    assert.ok(!names(pick.tools).includes(TARGET), 'denied tool not offered');
    assert.ok(!(pick.mcpExplicit || []).includes(TARGET), 'denied tool not explicit');
    // The AIService gate resolves schemas from offered+registry+exposed and
    // permits only registry natives or exposed MCP names: with the tool in
    // neither, no pending record may be created. Emulate the gate rule here.
    const permitted = exposed.some((s) => s.function.name === TARGET);
    assert.strictEqual(permitted, false, 'gate must refuse denied tool');
  });

  // Cancel / expiry / rounds bounds.
  await check('P-11 cancel, expiry, and rounds-exhaustion abandon cleanly', () => {
    const pend = P.createPending(TARGET, { messageType: 'success' }, ANNOTATED);
    assert.strictEqual(P.advancePending(pend, 'never mind', ANNOTATED).action, 'abandon');
    assert.strictEqual(P.advancePending(pend, 'true', ANNOTATED, Date.now() + 31 * 60 * 1000).action, 'abandon');
    const exhausted = { ...pend, rounds: P.MAX_CLARIFICATION_ROUNDS };
    assert.strictEqual(P.advancePending(exhausted, 'true', ANNOTATED).action, 'abandon');
    // A bare "no" answering a boolean is a VALUE, not a cancel.
    const r = P.advancePending(P.createPending(TARGET, { messageType: 'success' }, ANNOTATED), 'no', ANNOTATED);
    assert.strictEqual(r.action, 'execute');
    assert.deepStrictEqual(r.args, { messageType: 'success', includeImage: false });
  });

  // Generic native multi-arg behavior: no blind injection across open strings.
  await check('P-12 generic two-string tool fills only the sole-remaining slot', () => {
    const schema = NATIVE_TWO_STRINGS;
    const bothMissing = P.extractArgValues('tomorrow', P.requiredParams(schema));
    assert.deepStrictEqual(bothMissing, {}, 'must not guess across two open slots');
    const oneMissing = P.extractArgValues('10am', P.requiredParams(schema).filter((p) => p.name === 'time'));
    assert.deepStrictEqual(oneMissing, { time: '10am' });
    // Coercions used for model-issued calls.
    assert.deepStrictEqual(P.coerceArgValue({ type: 'boolean' }, 'True'), { ok: true, value: true });
    assert.deepStrictEqual(P.coerceArgValue({ type: 'integer' }, '3'), { ok: true, value: 3 });
    assert.strictEqual(P.coerceArgValue({ type: 'integer' }, '3.5').ok, false);
    assert.deepStrictEqual(
      P.coerceArgValue({ type: 'string', enum: ['a', 'b'] }, 'B'), { ok: true, value: 'b' }
    );
  });

  console.log(`\n${pass + fail} tests, ${pass} passed, ${fail} failed`);
  if (fail) {
    for (const f of failures) console.error(`\nFAILED: ${f.label}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
