#!/usr/bin/env node
'use strict';

// Phase 1 test runner — the single command that executes the server suite.
//
// WHY THIS EXISTS
//   Phase 1 grew a large set of security and integration suites
//   (authorization, approval, ownership, MCP single path, idempotency, deep
//   research governance, news follow-ups, disposable Mongo safety). They all
//   existed as files, but nothing invoked them: `npm test` did not exist and CI
//   only ran `node --check index.js`. A suite that nothing runs is not a
//   guarantee. This runner is that guarantee.
//
//   node tests/runAll.js                     # every suite (offline, no DB)
//   node tests/runAll.js --filter approval   # substring match on the name
//   node tests/runAll.js --exclude-live      # skip credentialed provider tests
//   node tests/runAll.js --timeout 300       # per-suite timeout in seconds
//   node tests/runAll.js --group phase1      # the curated security gate subset
//   node tests/runAll.js --mongo             # pass the disposable Mongo contract
//                                            # through (still needs the explicit
//                                            # MONGO_TEST_* opt-in to run)
//   node tests/runAll.js --include-live      # also attempt live provider suites
//
// SAFETY
//   Every suite runs in its own process with the ambient Mongo variables
//   removed, so no suite can reach the application database by accident. The
//   disposable contract variables (MONGO_TEST_*) are ALSO stripped unless
//   --mongo is passed, so a default `npm test` / CI run can never reach any
//   database at all. Suites that need a live Mongo must additionally opt in
//   through tests/helpers/disposableMongo.js (see idempotency.mongo.test.js
//   and messageHistory.baseline.test.js) and otherwise skip themselves.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Suites that require real provider credentials or the public internet. They
// are excluded from the default run because CI and offline validation cannot
// satisfy them; `--exclude-live` is the default, pass `--include-live` to try.
const LIVE_SUITES = new Set([
  'groqProvider.live',
  'sarvamLive',
  'notionRealRegression',
  'mcpLiveTrace',
]);

// The Phase 1 governed-action-substrate acceptance group. Named explicitly
// rather than filtered by substring, so the set is reviewable and a renamed
// suite cannot silently drop out of the gate. `npm test` still runs EVERY
// discovered suite; this group is the fast, security-focused subset.
const PHASE1_SUITES = [
  'governedExecutionPaths',        // no capability bypasses the executor
  'authorizationPolicy',           // verdicts, guest deny, classification drift
  'taskExecutorAuthorization',     // enforcement at the boundary
  'taskExecutorApproval',          // real approval gating
  'approvalStore',                 // private socket binding
  'approvalSocketBinding.socket',  // real JWT + Socket.IO cross-socket denial
  'conversationOwnership.security',// REST owner scoping
  'conversationOwnership.socket',  // real socket owner scoping
  'mcpSinglePath',                 // one MCP execution path
  'mcpEnforcement',                // MCP policy enforcement
  'mcpPolicy',                     // MCP guest policy authority
  'idempotency',                   // duplicate side-effect prevention
  'idempotency.failureMode',       // store-outage behavior
  'idempotencyWiring',             // production call sites actually supply keys
  'recoveryScopePropagation',      // recovery re-enters the executor in scope
  'executionEnvelope',             // envelope + observability lifecycle
  'slice4eSwarmGovernance',        // nested governed calls in the swarm
  'newsFollowUpContinuation',      // current-news multi-turn
  'newsMultiTurnScoping',          // one fetch/turn, no double timeout
  'disposableMongoSafety',         // test-database safety contract
  'ttsFirstChunk',                 // streaming speech segmentation
];

const parseArgs = (argv) => {
  const out = { filter: null, includeLive: false, allowMongo: false, group: null, timeoutSec: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--filter') out.filter = argv[++i];
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i]);
    else if (a === '--include-live') out.includeLive = true;
    else if (a === '--exclude-live') out.includeLive = false;
    else if (a === '--mongo') out.allowMongo = true;
    else if (a === '--group') out.group = argv[++i];
  }
  return out;
};

const SUMMARY_RE = /Result:.*|[0-9]+ tests, [0-9]+ passed, [0-9]+ failed(?:, [0-9]+ skipped)?/;

// Build the child environment. Dropping a key entirely (rather than setting it
// to undefined) is deliberate: a suite must see a genuinely absent variable.
const DISPOSABLE_MONGO_KEYS = Object.freeze([
  'RUN_MONGO_INTEGRATION',
  'MONGO_MEASURE_ALLOW_DESTRUCTIVE',
]);

const buildChildEnv = (allowMongo) => {
  const env = { ...process.env };
  // The application database is NEVER reachable from a suite, not even with
  // --mongo: --mongo only un-strips the disposable contract.
  delete env.MONGO_URI;
  delete env.DATABASE_URL;
  if (!allowMongo) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('MONGO_TEST_') || DISPOSABLE_MONGO_KEYS.includes(key)) delete env[key];
    }
  }
  return env;
};

const runSuite = (file, timeoutMs, allowMongo) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [file], {
    cwd: path.join(__dirname, '..'),
    env: buildChildEnv(allowMongo),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ ...result, ms: Date.now() - started, output: out });
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ code: 124, summary: `TIMEOUT after ${Math.round(timeoutMs / 1000)}s`, skipped: false });
  }, timeoutMs);

  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('error', (err) => finish({ code: 1, summary: `spawn error: ${err.message}`, skipped: false }));
  child.on('close', (code) => {
    const lines = out.split('\n');
    let summary = '';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const m = SUMMARY_RE.exec(lines[i]);
      if (m) { summary = m[0].trim(); break; }
    }
    if (!summary) {
      const tail = lines.filter((l) => l.trim()).slice(-2).join(' | ');
      summary = tail.slice(0, 100) || '(no output)';
    }
    finish({ code, summary, skipped: /\(skipped\)|SKIP/.test(out) && code === 0 });
  });
});

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = __dirname;
  const all = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => f.replace(/\.test\.js$/, ''))
    .sort();

  let suites = all;
  if (args.group === 'phase1') {
    // Explicit list, not a filter: fail loudly if a named suite is missing so a
    // rename can never quietly reduce the gate.
    const available = new Set(all);
    const missing = PHASE1_SUITES.filter((s) => !available.has(s));
    if (missing.length) {
      console.error(`Phase 1 group references missing suites: ${missing.join(', ')}`);
      process.exit(1);
    }
    suites = PHASE1_SUITES.filter((s) => available.has(s));
  } else if (args.filter) {
    suites = suites.filter((s) => s.includes(args.filter));
  }
  const skippedLive = [];
  if (!args.includeLive) {
    skippedLive.push(...suites.filter((s) => LIVE_SUITES.has(s)));
    suites = suites.filter((s) => !LIVE_SUITES.has(s));
  }

  console.log('='.repeat(78));
  const label = args.group ? `--group ${args.group}` : 'full suite';
  console.log(`JARVIS Phase 1 — server test suite (${suites.length} suites, ${label})`);
  console.log('='.repeat(78));
  if (skippedLive.length) {
    console.log(`Not run (need live provider credentials): ${skippedLive.join(', ')}`);
    console.log('Run with --include-live to attempt them.');
  }
  console.log('');

  const results = [];
  for (const suite of suites) {
    const r = await runSuite(path.join(dir, `${suite}.test.js`), args.timeoutSec * 1000, args.allowMongo);
    results.push({ suite, ...r });
    const flag = r.code === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${flag}  ${suite.padEnd(38)} ${String(r.summary).slice(0, 60)}`);
  }

  const failed = results.filter((r) => r.code !== 0);
  const assertions = results.reduce((total, r) => {
    const m = /(\d+) tests?, (\d+) passed/.exec(r.summary) || /Result: (\d+) pass/.exec(r.summary);
    if (!m) return total;
    return total + (Number(m[1]) || Number(m[2]) || 0);
  }, 0);

  console.log('');
  console.log('-'.repeat(78));
  console.log(`Suites: ${results.length} run, ${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`Assertions reported: ~${assertions}`);
  if (failed.length) {
    console.log('');
    console.log('FAILED SUITES:');
    for (const f of failed) console.log(`  ${f.suite} (exit ${f.code})`);
  }
  console.log('-'.repeat(78));
  process.exit(failed.length ? 1 : 0);
};

// Only run when executed directly. Without this guard, requiring this file
// (from a harness or another runner) would silently start executing the whole
// suite as a side effect of the import.
if (require.main === module) {
  main().catch((err) => {
    console.error('runner error:', err);
    process.exit(1);
  });
}

module.exports = { LIVE_SUITES, PHASE1_SUITES, buildChildEnv, parseArgs };
