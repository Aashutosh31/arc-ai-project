'use strict';

// Idempotency wiring on the model tool-call path (DB-free, no provider keys).
//
// Production gap found in the Phase 1 closure audit: the substrate's
// idempotency guard was fully implemented and unit-proven, but NO production
// call site ever supplied an identity, so `resolveIdempotencyKey` always
// returned `{ enabled: false }` and every execution passed straight through.
// Duplicate protection was therefore inert in production.
//
// The fix supplies a logical identity at the model dispatch sites. This suite
// locks the two properties that make that safe:
//
//   I-01 the model path actually supplies an idempotency key
//   I-02 a duplicate tool call in the SAME turn replays instead of re-running
//   I-03 the same provider tool_call id in a DIFFERENT turn is NOT suppressed
//         (providers reuse ids like "call_1"; a legitimate repeat must run)
//   I-04 a missing turn id degrades to pass-through rather than a guessed key
//
// Run:  cd server && node tests/idempotencyWiring.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const AIService = require('../services/AIService');
const TaskExecutor = require('../services/TaskExecutor');
const idempotencyStore = require('../lib/capabilities/idempotencyStore');
const resetIdempotencyStore = () => idempotencyStore._reset();

const passed = [];
const failed = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed.push({ name, err });
    process.exitCode = 1;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err && err.message}`);
  }
};

const main = async () => {
  // ---- I-01: the model path supplies a key -------------------------------

  await test('I-01 model tool-call dispatch sites supply an idempotency key', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'AIService.js'), 'utf8');
    const calls = src.match(/TaskExecutor\.executeTool\(/g) || [];
    assert.ok(calls.length >= 6, `expected the model dispatch sites, found ${calls.length}`);

    const keyed = src.match(/idempotencyKey:\s*toolCallIdempotencyKey\(/g) || [];
    assert.ok(
      keyed.length >= 2,
      `expected >= 2 idempotencyKey: toolCallIdempotencyKey(...) wiring sites, found ${keyed.length}`,
    );

    // Both halves of the identity must be threaded (call id AND per-turn id).
    for (const m of src.matchAll(/idempotencyKey:\s*toolCallIdempotencyKey\(\s*([A-Za-z_$][\w$]*)\.id,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/g)) {
      assert.strictEqual(m[2], 'assistantDraftMessageId', 'per-turn id must be the assistant draft message id');
      assert.ok(m[1], 'tool call id source must be a tool call object');
    }
  });

  // ---- I-04: degradation, not guessing -----------------------------------

  await test('I-04 missing turn or call id degrades to null (no guessed identity)', async () => {
    const key = AIService.toolCallIdempotencyKey;
    assert.strictEqual(key('call_1', 'turn-a'), 'turn:turn-a:call:call_1');
    // A provider id without a per-turn id must NOT produce a bare id: that
    // would collide across turns and wrongly suppress legitimate repeats.
    assert.strictEqual(key('call_1', null), null);
    assert.strictEqual(key('call_1', undefined), null);
    assert.strictEqual(key('call_1', ''), null);
    assert.strictEqual(key(null, 'turn-a'), null);
    assert.strictEqual(key('', 'turn-a'), null);
    assert.strictEqual(key(undefined, undefined), null);
    // Whitespace-only is not an identity.
    assert.strictEqual(key('   ', 'turn-a'), null);
    assert.strictEqual(key('call_1', '   '), null);
  });

  await test('I-04b a null key leaves the substrate in documented pass-through mode', async () => {
    // resolveIdempotencyKey must report enabled=false when no identity exists,
    // i.e. the substrate never invents a logical key from tool arguments.
    const { resolveIdempotencyKey } = require('../lib/capabilities/idempotencyKey');
    const identity = resolveIdempotencyKey({
      capabilityId: 'native:getTopNews',
      userId: 'u1',
      workspaceId: 'w1',
      conversationId: 'c1',
      executionId: 'exec-1',
      explicitKey: null,
    });
    assert.strictEqual(identity.enabled, false);
    assert.strictEqual(identity.logicalKey, null);
  });

  // ---- I-02 / I-03: real dedupe behavior through TaskExecutor ------------

  // Exercise the guard end-to-end with a counted tool, using the same
  // executionOptions shape the model path now sends.
  const runKeyed = async (key, turn) => {
    resetIdempotencyStore();
    const toolRegistry = require('../tools');
    const tool = toolRegistry.getTool('getTopNews');
    const original = tool.execute;
    let runs = 0;
    tool.execute = async () => {
      runs += 1;
      return { success: true, runs };
    };
    try {
      const result = await TaskExecutor.executeTool(
        'getTopNews',
        { limit: 3 },
        'user-1',
        null,
        {
          workspaceId: 'w1',
          conversationId: 'c1',
          idempotencyKey: AIService.toolCallIdempotencyKey(key, turn),
        },
      );
      return { runs, result };
    } finally {
      tool.execute = original;
    }
  };

  await test('I-02 duplicate tool call in the same turn replays instead of re-running', async () => {
    resetIdempotencyStore();
    const toolRegistry = require('../tools');
    const tool = toolRegistry.getTool('getTopNews');
    const original = tool.execute;
    let runs = 0;
    tool.execute = async () => {
      runs += 1;
      return { success: true, marker: `run-${runs}` };
    };

    const options = (turn) => ({
      workspaceId: 'w1',
      conversationId: 'c1',
      skipCreditCharge: true,
      idempotencyKey: AIService.toolCallIdempotencyKey('call_1', turn),
    });

    try {
      const first = await TaskExecutor.executeTool('getTopNews', { limit: 3 }, 'user-1', null, options('turn-a'));
      const second = await TaskExecutor.executeTool('getTopNews', { limit: 3 }, 'user-1', null, options('turn-a'));

      assert.strictEqual(runs, 1, 'duplicate must not re-run the side effect');
      assert.strictEqual(first.success, true);
      assert.strictEqual(first.marker, 'run-1');

      // The duplicate is answered with the normalized replay envelope, which
      // deliberately does NOT echo the stored tool output. Assert both halves:
      // it is a replay of THIS prior execution, and it leaks no prior payload.
      assert.strictEqual(second.replay, true, 'duplicate must be marked as a replay');
      assert.strictEqual(second.success, true, 'a successful prior action replays as success');
      assert.ok(second.duplicateOf, 'replay must reference the prior executionId');
      assert.strictEqual(
        second.marker,
        undefined,
        'replay must not echo stored tool output',
      );
      const { IDEMPOTENCY_STATUS } = require('../lib/capabilities/idempotencyKey');
      assert.strictEqual(
        second.outcome && second.outcome.status,
        IDEMPOTENCY_STATUS.SUCCEEDED,
        'replay must carry the prior terminal status',
      );
    } finally {
      tool.execute = original;
    }
  });

  await test('I-03 the same provider tool_call id in a different turn is NOT suppressed', async () => {
    resetIdempotencyStore();
    const toolRegistry = require('../tools');
    const tool = toolRegistry.getTool('getTopNews');
    const original = tool.execute;
    let runs = 0;
    tool.execute = async () => {
      runs += 1;
      return { success: true, marker: `run-${runs}` };
    };

    const options = (turn) => ({
      workspaceId: 'w1',
      conversationId: 'c1',
      skipCreditCharge: true,
      idempotencyKey: AIService.toolCallIdempotencyKey('call_1', turn),
    });

    try {
      const first = await TaskExecutor.executeTool('getTopNews', { limit: 3 }, 'user-1', null, options('turn-a'));
      const second = await TaskExecutor.executeTool('getTopNews', { limit: 3 }, 'user-1', null, options('turn-b'));

      assert.strictEqual(runs, 2, 'a repeat in a NEW turn must execute again');
      assert.strictEqual(first.marker, 'run-1');
      assert.strictEqual(second.marker, 'run-2');
    } finally {
      tool.execute = original;
    }
  });

  await test('I-03b an unkeyed execution still runs every time (no accidental blocking)', async () => {
    resetIdempotencyStore();
    const toolRegistry = require('../tools');
    const tool = toolRegistry.getTool('getTopNews');
    const original = tool.execute;
    let runs = 0;
    tool.execute = async () => {
      runs += 1;
      return { success: true };
    };
    try {
      const opts = { workspaceId: 'w1', conversationId: 'c1', skipCreditCharge: true };
      await TaskExecutor.executeTool('getTopNews', { limit: 3 }, 'user-1', null, opts);
      await TaskExecutor.executeTool('getTopNews', { limit: 3 }, 'user-1', null, opts);
      assert.strictEqual(runs, 2, 'unkeyed path must remain pass-through');
    } finally {
      tool.execute = original;
    }
  });

  void runKeyed; // retained for clarity of the shared setup above

  console.log(`\n${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`  - ${f.name}: ${f.err && f.err.message}`);
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
