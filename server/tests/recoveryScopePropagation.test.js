'use strict';

// JARVIS Action Substrate — recovery scope propagation.
//
// ToolRecoveryManager re-enters TaskExecutor. Every capability the substrate
// governs is authorized against the CONTEXT it is executed in, so if a recovery
// drops the scope it was called with, the retry is evaluated in a different
// (null) workspace than the attempt it is recovering.
//
// This is fail-closed rather than an escalation: a null workspaceId is denied by
// any workspace restriction -- but it silently breaks recovery for exactly the
// workspace-scoped capabilities that need it most, and it corrupts the
// conversation attribution on the idempotency record.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const passed = [];
const failed = [];

const test = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log('  PASS ', name);
  } catch (err) {
    failed.push(name);
    console.log('  FAIL ', name, '\n        ', err && err.message);
  }
};

const AISERVICE = path.join(__dirname, '..', 'services', 'AIService.js');
const PLANNER = path.join(__dirname, '..', 'services', 'TaskPlanner.js');
const RECOVERY = path.join(__dirname, '..', 'services', 'ToolRecoveryManager.js');

const main = async () => {
  console.log('==========================================================');
  console.log('Recovery scope propagation');
  console.log('==========================================================');

  const ToolRecoveryManager = require('../services/ToolRecoveryManager');
  const TaskExecutor = require('../services/TaskExecutor');

  // Capture what the recovery manager actually hands the executor.
  const withCapturedExecuteTool = async (fn) => {
    const original = TaskExecutor.executeTool;
    const calls = [];
    TaskExecutor.executeTool = async (name, args, userId, socket, options) => {
      calls.push({ name, args, userId, socket, options });
      return { success: true, recoveredByStub: true };
    };
    try {
      return { calls, result: await fn() };
    } finally {
      TaskExecutor.executeTool = original;
    }
  };

  // A transient timeout is the retry strategy: the same tool, same args, run
  // again. This is the path that must preserve scope.
  const transientTimeout = {
    toolName: 'getTime',
    args: {},
    result: { success: false, error: 'Request timeout after 10000ms' },
  };

  await test('retry strategy forwards workspaceId and conversationId to the executor', async () => {
    const { calls } = await withCapturedExecuteTool(() =>
      ToolRecoveryManager.recoverToolResult({
        ...transientTimeout,
        userId: 'u-scope-1',
        workspaceId: 'ws-alpha',
        conversationId: 'conv-42',
      })
    );
    assert.strictEqual(calls.length, 1, 'expected exactly one retry execution');
    assert.strictEqual(calls[0].options.workspaceId, 'ws-alpha');
    assert.strictEqual(calls[0].options.conversationId, 'conv-42');
  });

  await test('retry still charges nothing extra (skipCreditCharge preserved)', async () => {
    const { calls } = await withCapturedExecuteTool(() =>
      ToolRecoveryManager.recoverToolResult({
        ...transientTimeout,
        userId: 'u-scope-1',
        workspaceId: 'ws-alpha',
        conversationId: 'conv-42',
      })
    );
    assert.strictEqual(calls[0].options.skipCreditCharge, true);
  });

  await test('fallback strategies (scrape/search) forward scope too', async () => {
    // A 404 on scrapeWebsite falls back to candidate URLs; a missing host falls
    // back to webSearch. Both re-enter the executor and must carry scope.
    const scrape = await withCapturedExecuteTool(() =>
      ToolRecoveryManager.recoverToolResult({
        toolName: 'scrapeWebsite',
        args: { url: 'https://example.com/missing' },
        result: { success: false, error: '404 Not Found' },
        userId: 'u-scope-2',
        workspaceId: 'ws-beta',
        conversationId: 'conv-77',
      })
    );
    assert.ok(scrape.calls.length >= 1, 'expected a fallback scrape attempt');
    for (const c of scrape.calls) {
      assert.strictEqual(c.options.workspaceId, 'ws-beta', `scrape fallback lost workspaceId`);
      assert.strictEqual(c.options.conversationId, 'conv-77', `scrape fallback lost conversationId`);
    }
  });

  await test('absent scope stays null rather than inventing one', async () => {
    // Must not fabricate a workspace: a caller with no workspace gets null, so
    // the executor's own default handling applies unchanged.
    const { calls } = await withCapturedExecuteTool(() =>
      ToolRecoveryManager.recoverToolResult({
        ...transientTimeout,
        userId: 'u-scope-3',
      })
    );
    assert.strictEqual(calls[0].options.workspaceId, null);
    assert.strictEqual(calls[0].options.conversationId, null);
  });

  // ---- structural: every call site carries the scope it was given ----
  // Behavior tests above cover the manager; these stop a future call site from
  // quietly reverting to the old workspace-less shape.

  const recoverySrc = fs.readFileSync(RECOVERY, 'utf8');
  const recoveryExecuteCalls = recoverySrc.match(/TaskExecutor\.executeTool\(/g) || [];
  await test('every recovery executeTool call site forwards conversationId', () => {
    assert.ok(recoveryExecuteCalls.length >= 3, 'expected the recovery strategies to remain');
    const optionObjects = recoverySrc.match(/\{ signal, skipCreditCharge: true[^}]*\}/g) || [];
    assert.strictEqual(
      optionObjects.length,
      recoveryExecuteCalls.length,
      'every executeTool call must use the shared options object literal',
    );
    for (const opts of optionObjects) {
      assert.ok(opts.includes('workspaceId'), 'options must carry workspaceId');
      assert.ok(opts.includes('conversationId'), 'options must carry conversationId');
    }
  });

  await test('AIService forwards scope into recoverToolResult', () => {
    const src = fs.readFileSync(AISERVICE, 'utf8');
    const sites = src.match(/recoverToolResult\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(sites.length >= 1, 'expected an AIService recovery call site');
    for (const site of sites) {
      assert.ok(/workspaceId\s*:/.test(site), 'AIService recovery must pass workspaceId');
      assert.ok(/conversationId/.test(site), 'AIService recovery must pass conversationId');
    }
  });

  await test('TaskPlanner forwards scope into every recoverToolResult call site', () => {
    const src = fs.readFileSync(PLANNER, 'utf8');
    const sites = src.match(/recoverToolResult\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(sites.length >= 2, `expected both planner recovery sites, saw ${sites.length}`);
    for (const site of sites) {
      assert.ok(/workspaceId\s*:/.test(site), 'planner recovery must pass workspaceId');
      assert.ok(/conversationId\s*:/.test(site), 'planner recovery must pass conversationId');
    }
  });

  console.log('==========================================================');
  console.log(`Result: ${passed.length} pass, ${failed.length} fail`);
  if (failed.length) process.exitCode = 1;
};

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
