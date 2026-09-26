'use strict';

// disposableMongoSafety.test.js — proof for the Mongo test safety guard
// (server/tests/helpers/disposableMongo.js).
//
// PURE TESTS. No Mongo connection is made, no Atlas is contacted, and nothing
// is created or destroyed. Every assertion exercises an exported pure function
// with a synthetic environment, so this suite is safe to run anywhere.
//
// Cases 1-9   configuration: opt-in, host allowlist, database allowlist
// Cases 10-14 cleanup authorization: marker and ownership revalidation
// Cases 15-17 handling: query-string containment, log redaction, argv secrecy
// Cases 18-20 structural: repository-wide enforcement of the contract
//
// Run: cd server && node tests/disposableMongoSafety.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mongo = require('./helpers/disposableMongo');

const {
  DisposableMongoSafetyError,
  DISPOSABLE_DB_PATTERN,
  MARKER_COLLECTION,
  classifyMongoIntent,
  describeRequiredEnv,
  disposableDbName,
  evaluateDisposableDbName,
  evaluateOwnership,
  generateRunId,
  parseMongoUri,
  planDisposableRun,
  redactUri,
  resolveConnectTarget,
  safeTargetSummary,
  buildChildArgs,
  buildChildEnv,
} = mongo;

const HOST = 'mongo.test.internal';
const CREDS = { user: 'probe-user', pass: 'sup3r-s3cret-pw' };
const AMBIENT_APP_DB = 'jarvis_production_db';

const baseEnv = (over = {}) => ({
  NODE_ENV: 'test',
  MONGO_TEST_URI: `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017`,
  MONGO_TEST_EXPECTED_HOST: HOST,
  MONGO_TEST_DISPOSABLE: '1',
  RUN_MONGO_INTEGRATION: '1',
  ...over,
});

const fixedNow = 1767225600000; // 2026-01-01T00:00:00Z
const fixedRandom = (n) => Buffer.alloc(n, 0xab);
const FIXED_RUN_ID = generateRunId(fixedNow, fixedRandom);
const plan = (over = {}) => planDisposableRun({ env: baseEnv(over), now: fixedNow, random: fixedRandom });

let pass = 0;
let fail = 0;

async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    fail += 1;
    process.exitCode = 1;
    console.error(`  FAIL  ${label}\n        ${err && err.stack ? err.message : String(err)}`);
  }
}

const rejects = (fn, expectedCodes) => {
  let result;
  try {
    result = fn();
  } catch (err) {
    if (!(err instanceof DisposableMongoSafetyError)) {
      throw new Error(`expected DisposableMongoSafetyError, got ${err && err.name}: ${err && err.message}`);
    }
    if (expectedCodes && !expectedCodes.includes(err.code)) {
      throw new Error(`expected code in [${expectedCodes}], got ${err.code} (${err.message})`);
    }
    return err;
  }
  if (result && result.ok === false) {
    if (expectedCodes && !expectedCodes.includes(result.code)) {
      throw new Error(`expected code in [${expectedCodes}], got ${result.code}`);
    }
    return result;
  }
  throw new Error('expected the configuration to be rejected, but it was accepted');
};

const main = async () => {
  console.log('Disposable Mongo Safety — pure guard tests');
  console.log('=========================================');

  // ---- 1: missing MONGO_TEST_URI -> reject -----------------------------
  await check('1. missing MONGO_TEST_URI is rejected', () => {
    const env = baseEnv();
    delete env.MONGO_TEST_URI;
    rejects(() => planDisposableRun({ env, now: fixedNow, random: fixedRandom }), ['MONGO_TEST_URI_MISSING']);
    assert.strictEqual(mongo.validateDisposableConfig({ env, now: fixedNow, random: fixedRandom }).code,
      'MONGO_TEST_URI_MISSING');
  });

  // ---- 2: ambient MONGO_URI only -> reject -----------------------------
  await check('2. ambient MONGO_URI / DATABASE_URL alone is rejected (no fallback)', () => {
    const ambientOnly = {
      NODE_ENV: 'test',
      MONGO_URI: `mongodb://${CREDS.user}:${CREDS.pass}@cluster0.mongodb.net/${AMBIENT_APP_DB}?retryWrites=true`,
      DATABASE_URL: `mongodb://${CREDS.user}:${CREDS.pass}@cluster0.mongodb.net/${AMBIENT_APP_DB}`,
    };
    // Live application credentials present, nothing disposable configured.
    rejects(() => planDisposableRun({ env: ambientOnly, now: fixedNow, random: fixedRandom }),
      ['MONGO_TEST_DISPOSABLE_REQUIRED']);
    // With the markers set but still no MONGO_TEST_URI.
    const markersOnly = { ...ambientOnly, MONGO_TEST_DISPOSABLE: '1', RUN_MONGO_INTEGRATION: '1', MONGO_TEST_EXPECTED_HOST: 'cluster0.mongodb.net' };
    rejects(() => planDisposableRun({ env: markersOnly, now: fixedNow, random: fixedRandom }),
      ['MONGO_TEST_URI_MISSING']);
    // The guard reads the ambient URI only to learn the application DB name so
    // it can refuse it — never to build a connection target.
    assert.strictEqual(mongo.discoverAppDbName(ambientOnly), AMBIENT_APP_DB);
    const resolved = planDisposableRun({
      env: { ...markersOnly, MONGO_TEST_URI: `mongodb://u:p@${HOST}:27017`, MONGO_TEST_EXPECTED_HOST: HOST },
    });
    assert.strictEqual(resolved.host, HOST, 'the connection target comes from MONGO_TEST_URI only');
    assert.ok(!resolved.uri.includes('cluster0.mongodb.net'), 'the ambient host is never adopted');
    assert.ok(!resolved.uri.includes('mongodb.net'), 'the ambient URI is never adopted');
  });

  // ---- 3: missing disposable marker -> reject ---------------------------
  await check('3. missing / wrong disposable marker is rejected', () => {
    rejects(() => planDisposableRun({ env: baseEnv({ MONGO_TEST_DISPOSABLE: undefined }), now: fixedNow, random: fixedRandom }),
      ['MONGO_TEST_DISPOSABLE_REQUIRED']);
    for (const value of ['true', 'yes', '0', '1 ', '']) {
      rejects(() => planDisposableRun({ env: baseEnv({ MONGO_TEST_DISPOSABLE: value }), now: fixedNow, random: fixedRandom }),
        ['MONGO_TEST_DISPOSABLE_REQUIRED']);
    }
    rejects(() => planDisposableRun({ env: baseEnv({ RUN_MONGO_INTEGRATION: '0' }), now: fixedNow, random: fixedRandom }),
      ['RUN_MONGO_INTEGRATION_REQUIRED']);
    // Production mode is refused even with a perfect disposable config.
    rejects(() => planDisposableRun({ env: baseEnv({ NODE_ENV: 'production' }), now: fixedNow, random: fixedRandom }),
      ['MONGO_TEST_PRODUCTION_MODE']);
  });

  // ---- 4: wrong host -> reject ------------------------------------------
  await check('4. host not on the allowlist is rejected before connecting', () => {
    const result = mongo.validateDisposableConfig({
      env: baseEnv({ MONGO_TEST_EXPECTED_HOST: 'cluster0.mongodb.net' }), now: fixedNow, random: fixedRandom,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'MONGO_TEST_HOST_MISMATCH');
    assert.ok(result.message.includes(HOST), 'the mismatch is reported by host only');
    // Every host in a replica-set URI must match.
    assert.strictEqual(mongo.hostMatchesExpected([{ host: HOST, port: '27017' }], HOST), true);
    assert.strictEqual(mongo.hostMatchesExpected([{ host: HOST, port: '' }, { host: 'evil.host', port: '27017' }], HOST), false);
    assert.strictEqual(mongo.hostMatchesExpected([{ host: 'evil.host', port: '27017' }], `${HOST}:27017`), false);
    // Exact host or host:port may be declared.
    assert.strictEqual(mongo.hostMatchesExpected([{ host: HOST, port: '27017' }], `${HOST}:27017`), true);
  });

  // ---- 5: default DB name -> reject -------------------------------------
  await check('5. default "test" database is rejected', () => {
    rejects(() => evaluateDisposableDbName('test'), ['MONGO_TEST_DB_NAME_FORBIDDEN']);
    for (const reserved of ['admin', 'local', 'config']) {
      rejects(() => evaluateDisposableDbName(reserved), ['MONGO_TEST_DB_NAME_FORBIDDEN']);
    }
    // A URI that names it is refused too.
    const result = mongo.validateDisposableConfig({
      env: baseEnv({ MONGO_TEST_URI: `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/test` }),
      now: fixedNow, random: fixedRandom,
    });
    assert.strictEqual(result.code, 'MONGO_TEST_BASE_DB_FORBIDDEN');
  });

  // ---- 6: production-like DB name -> reject -----------------------------
  await check('6. production-like database names are rejected', () => {
    for (const name of ['prod', 'production', 'staging', 'development', 'dev']) {
      rejects(() => evaluateDisposableDbName(name), ['MONGO_TEST_DB_NAME_FORBIDDEN']);
    }
    for (const name of ['prod', 'production', 'staging']) {
      const result = mongo.validateDisposableConfig({
        env: baseEnv({ MONGO_TEST_URI: `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/${name}` }),
        now: fixedNow, random: fixedRandom,
      });
      assert.strictEqual(result.code, 'MONGO_TEST_BASE_DB_FORBIDDEN', `URI naming ${name} must be refused`);
    }
  });

  // ---- 7: application DB name -> reject ---------------------------------
  await check('7. the application database name is rejected', () => {
    const env = baseEnv({ MONGO_URI: `mongodb://${CREDS.user}:${CREDS.pass}@cluster0.mongodb.net/${AMBIENT_APP_DB}` });
    const appNames = mongo.appDbNameSet(env);
    assert.ok(appNames.has(AMBIENT_APP_DB), 'the ambient application DB name is discovered for refusal');
    rejects(() => evaluateDisposableDbName(AMBIENT_APP_DB, { appDbNames: appNames }), ['MONGO_TEST_DB_NAME_FORBIDDEN']);
    // The incident shape: MONGO_TEST_URI accidentally pointed at the app URI.
    const result = mongo.validateDisposableConfig({
      env: { ...env, MONGO_TEST_URI: env.MONGO_URI, MONGO_TEST_EXPECTED_HOST: 'cluster0.mongodb.net' },
      now: fixedNow, random: fixedRandom,
    });
    assert.strictEqual(result.code, 'MONGO_TEST_BASE_DB_FORBIDDEN');
    assert.ok(result.message.includes(AMBIENT_APP_DB));
    for (const hint of ['jarvis', 'jarvis_db', 'arc_ai']) {
      rejects(() => evaluateDisposableDbName(hint, { appDbNames: appNames }), ['MONGO_TEST_DB_NAME_FORBIDDEN']);
    }
  });

  // ---- 8: invalid disposable prefix -> reject ---------------------------
  await check('8. a name without the disposable prefix is rejected', () => {
    for (const name of ['', '   ', 'jarvis_scratch', 'arc_test_abcdefgh', 'ARC_AI_TEST_abcdefgh',
      'arc_ai_test_', 'arc_ai_test_short', 'arc_ai_test_BAD_case', 'arc-ai-test-abcdefgh', 'x'.repeat(40)]) {
      rejects(() => evaluateDisposableDbName(name), ['MONGO_TEST_DB_NAME_INVALID']);
    }
    // The pattern is the structural backstop, whatever the denylist contains.
    assert.ok(DISPOSABLE_DB_PATTERN.test('arc_ai_test_abcdefgh'));
    assert.ok(!DISPOSABLE_DB_PATTERN.test('arc_ai_test_ABCDEFGH'));
  });

  // ---- 9: valid generated DB -> accept ----------------------------------
  await check('9. a valid generated disposable database is accepted', () => {
    const resolved = plan();
    assert.strictEqual(resolved.ok, undefined, 'planDisposableRun throws rather than returning a result');
    const p = plan();
    assert.ok(DISPOSABLE_DB_PATTERN.test(p.dbName), `generated name must match the pattern: ${p.dbName}`);
    assert.ok(p.dbName.startsWith('arc_ai_test_'));
    assert.strictEqual(p.runId, FIXED_RUN_ID);
    assert.strictEqual(p.host, HOST);
    assert.strictEqual(p.expectedHost, HOST);
    assert.strictEqual(p.dbName, disposableDbName(FIXED_RUN_ID));
    // Different runs never collide.
    const other = planDisposableRun({ env: baseEnv(), now: fixedNow + 1, random: (n) => Buffer.alloc(n, 0xcd) });
    assert.notStrictEqual(other.dbName, p.dbName);
    // The full contract is documented for operators.
    for (const key of ['MONGO_TEST_URI', 'MONGO_TEST_EXPECTED_HOST', 'MONGO_TEST_DISPOSABLE', 'RUN_MONGO_INTEGRATION']) {
      assert.ok(describeRequiredEnv().includes(key), `required env ${key} must be documented`);
    }
    assert.strictEqual(classifyMongoIntent({}), 'absent');
    assert.strictEqual(classifyMongoIntent({ MONGO_TEST_URI: 'x' }), 'explicit');
  });

  // ---- 10-14: ownership + cleanup authorization -------------------------
  const ownership = (over = {}) => {
    const p = plan();
    return {
      marker: mongo.expectedMarker({ runId: p.runId, host: p.host, dbName: p.dbName }),
      runId: p.runId,
      host: p.host,
      database: p.dbName,
      liveDatabase: p.dbName,
      collections: [MARKER_COLLECTION, 'idempotencyrecords'],
      allowCollections: ['idempotencyrecords'],
      ...over,
    };
  };

  await check('10. cleanup is refused when the ownership marker is missing', () => {
    rejects(() => mongo.assertOwnership(ownership({ marker: null })), ['MARKER_MISSING']);
    rejects(() => mongo.assertOwnership(ownership({ marker: undefined })), ['MARKER_MISSING']);
    // A marker that is not a disposable-run marker is also refused.
    rejects(() => mongo.assertOwnership(ownership({ marker: { _id: 'ownership', runId: FIXED_RUN_ID } })),
      ['MARKER_NOT_DISPOSABLE']);
  });

  await check('11. cleanup is refused when the marker belongs to another run', () => {
    rejects(() => mongo.assertOwnership(ownership({ marker: { ...ownership().marker, runId: 'someone-elses-run' } })),
      ['MARKER_RUN_MISMATCH']);
    rejects(() => mongo.assertOwnership(ownership({ marker: { ...ownership().marker, host: 'other.host' } })),
      ['MARKER_HOST_MISMATCH']);
    rejects(() => mongo.assertOwnership(ownership({ marker: { ...ownership().marker, disposable: false } })),
      ['MARKER_NOT_DISPOSABLE']);
  });

  await check('12. cleanup is refused when the marker database does not match', () => {
    rejects(() => mongo.assertOwnership(ownership({ marker: { ...ownership().marker, database: 'arc_ai_test_otherrun1' } })),
      ['MARKER_DATABASE_MISMATCH']);
    // The live connection must be on the generated database.
    rejects(() => mongo.assertOwnership(ownership({ liveDatabase: AMBIENT_APP_DB })), ['DB_NAME_MISMATCH']);
  });

  await check('13. cleanup is refused on a host mismatch or unowned data', () => {
    rejects(() => mongo.assertOwnership(ownership({ marker: { ...ownership().marker, host: 'cluster0.mongodb.net' } })),
      ['MARKER_HOST_MISMATCH']);
    // Data the run does not own — the exact shape of the incident.
    const appData = ownership({ collections: [MARKER_COLLECTION, 'users', 'messages', 'conversations', 'aimemories'] });
    const err = rejects(() => mongo.assertOwnership(appData), ['UNEXPECTED_COLLECTIONS']);
    assert.ok(err.message.includes('users') && err.message.includes('conversations'));
    // An empty allowlist cannot cover the run's own collections either.
    rejects(() => mongo.assertOwnership(ownership({ allowCollections: [] })), ['UNEXPECTED_COLLECTIONS']);
  });

  await check('14. cleanup is allowed only for a fully matching run', () => {
    assert.strictEqual(evaluateOwnership(ownership()).ok, true);
    const p = plan();
    // An empty disposable database (marker only) is clean.
    assert.strictEqual(evaluateOwnership(ownership({ collections: [MARKER_COLLECTION] })).ok, true);
    // A test that cannot enumerate its models may adopt run-created
    // collections, which is sound only because the database was empty at
    // connect. Pre-existing data is still refused.
    const adopt = (collections, collectionsAtOpen = []) => ownership({
      collections, collectionsAtOpen, allowCollections: [mongo.ANY_RUN_COLLECTION],
    });
    assert.strictEqual(evaluateOwnership(adopt([MARKER_COLLECTION, 'messages', 'idempotencyrecords'])).ok, true);
    rejects(() => mongo.assertOwnership(adopt([MARKER_COLLECTION, 'users'], ['users'])), ['UNEXPECTED_COLLECTIONS']);
    // Every ownership field is carried in the marker.
    const marker = mongo.expectedMarker({ runId: p.runId, host: p.host, dbName: p.dbName });
    assert.strictEqual(marker.runId, p.runId);
    assert.strictEqual(marker.host, p.host);
    assert.strictEqual(marker.database, p.dbName);
    assert.strictEqual(marker.disposable, true);
  });

  // ---- 15: query string cannot alter the selected database --------------
  await check('15. a URI query string cannot alter the selected database', () => {
    const hostile = 'arc_ai_test_attacker01';
    for (const uri of [
      `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/?authSource=admin&dbName=${hostile}`,
      `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/${hostile}?dbName=${AMBIENT_APP_DB}`,
      `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/${AMBIENT_APP_DB}?authSource=admin`,
    ]) {
      const result = mongo.validateDisposableConfig({ env: baseEnv({ MONGO_TEST_URI: uri }), now: fixedNow, random: fixedRandom });
      if (result.ok) {
        const target = resolveConnectTarget(result.value);
        // The database always comes from the guard, never from the URI.
        assert.strictEqual(target.value.options.dbName, result.value.dbName);
        assert.strictEqual(target.value.database, result.value.dbName);
        assert.ok(DISPOSABLE_DB_PATTERN.test(target.value.options.dbName));
        assert.notStrictEqual(target.value.options.dbName, hostile);
        assert.notStrictEqual(target.value.options.dbName, AMBIENT_APP_DB);
        // ...while the URI is passed through verbatim, so its own options survive.
        assert.strictEqual(target.value.uri, uri);
        if (uri.includes('authSource=admin')) assert.ok(target.value.uri.includes('authSource=admin'));
        if (uri.includes('dbName=')) assert.ok(target.value.uri.includes('dbName='));
      } else {
        assert.strictEqual(result.code, 'MONGO_TEST_BASE_DB_FORBIDDEN', `hostile URI refused: ${result.message}`);
      }
    }
    // Parsing keeps the query string separate from the database name.
    const parsed = parseMongoUri(`mongodb://u:p@${HOST}:27017/some_db?authSource=admin&dbName=${hostile}`);
    assert.strictEqual(parsed.value.database, 'some_db');
    assert.ok(parsed.value.search.includes('dbName='));
    // mongodb+srv keeps working and is parsed the same way.
    const srv = parseMongoUri('mongodb+srv://u:p@cluster0.mongodb.net/db?retryWrites=true&w=majority');
    assert.strictEqual(srv.value.scheme, 'mongodb+srv');
    assert.strictEqual(srv.value.host, 'cluster0.mongodb.net');
    assert.strictEqual(srv.value.database, 'db');
    assert.ok(srv.value.search.includes('retryWrites=true'));
  });

  // ---- 16: credentials never appear in logs -----------------------------
  await check('16. credentials are never emitted in logs or errors', () => {
    const p = plan();
    const summary = safeTargetSummary(p);
    assert.strictEqual(summary, `host=${HOST}\ndatabase=${p.dbName}\ndisposable=true`);
    for (const secret of [CREDS.user, CREDS.pass, '@', 'authSource', 'mongodb://', '27017']) {
      assert.ok(!summary.includes(secret), `summary must not contain "${secret}"`);
    }
    // Failure paths report host only.
    const hostileEnvs = [
      baseEnv({ MONGO_TEST_EXPECTED_HOST: 'wrong.host' }),
      baseEnv({ MONGO_TEST_URI: `mongodb://${CREDS.user}:${CREDS.pass}@wrong.host:27017` }),
      baseEnv({ MONGO_TEST_URI: `mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/test` }),
      baseEnv({ MONGO_TEST_URI: 'not-a-mongo-uri' }),
      baseEnv({ MONGO_TEST_DISPOSABLE: undefined }),
      baseEnv({ NODE_ENV: 'production' }),
    ];
    for (const env of hostileEnvs) {
      const err = rejects(() => planDisposableRun({ env, now: fixedNow, random: fixedRandom }));
      assert.ok(!err.message.includes(CREDS.pass), `password must never appear in an error: ${err.message}`);
      assert.ok(!err.message.includes(CREDS.user), `username must never appear in an error: ${err.message}`);
      if (env.MONGO_TEST_URI) {
        assert.ok(!err.message.includes(env.MONGO_TEST_URI), `the raw URI must never appear in an error: ${err.message}`);
      }
    }
    // Redaction for the rare case a URI must be shown.
    const redacted = redactUri(`mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/db?authSource=admin`);
    assert.ok(!redacted.includes(CREDS.pass) && !redacted.includes(CREDS.user));
    assert.ok(redacted.includes(HOST));
    // The parser reduces credentials to a boolean and never retains them.
    const parsed = parseMongoUri(`mongodb://${CREDS.user}:${CREDS.pass}@${HOST}:27017/db`);
    assert.strictEqual(parsed.value.hasCredentials, true);
    assert.ok(!JSON.stringify(parsed.value).includes(CREDS.pass));
  });

  // ---- 17: credentials never travel through argv ------------------------
  await check('17. credentials are never passed through process.argv', () => {
    const p = plan();
    const args = buildChildArgs('idem-key-abc123', ['extra']);
    assert.deepStrictEqual(args, ['idem-key-abc123', 'extra']);
    assert.ok(!args.some((a) => /mongodb|srv|:/i.test(a)), 'no URI or credential may appear in argv');
    // The child receives the URI through the environment instead.
    const childEnv = buildChildEnv(p);
    assert.strictEqual(childEnv.MONGO_TEST_URI, p.uri);
    assert.strictEqual(childEnv.MONGO_TEST_DISPOSABLE, '1');
    assert.strictEqual(childEnv.RUN_MONGO_INTEGRATION, '1');
    // ...and reuses the parent's database, so it can never invent its own.
    assert.strictEqual(childEnv.MONGO_TEST_RUN_ID, p.runId);
    assert.strictEqual(childEnv.MONGO_TEST_DB_NAME, p.dbName);
    const revalidated = planDisposableRun({ env: { ...baseEnv(), MONGO_TEST_RUN_ID: childEnv.MONGO_TEST_RUN_ID, MONGO_TEST_DB_NAME: childEnv.MONGO_TEST_DB_NAME } });
    assert.strictEqual(revalidated.dbName, p.dbName);
    assert.strictEqual(revalidated.runId, p.runId);
  });

  /* ---- 18-20: structural enforcement across the repository ------------ */

  const SERVER_ROOT = path.join(__dirname, '..');
  const SELF = 'tests/disposableMongoSafety.test.js';
  // `delete process.env.MONGO_URI` is a hardening step, not a hazard, so the
  // scan looks at reads only.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/delete\s+process\.env\.(MONGO_URI|DATABASE_URL)\s*;/g, ' ');
  const readCode = (rel) => stripComments(fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8'));
  const listFiles = (dir, filter = () => true) => fs.readdirSync(path.join(SERVER_ROOT, dir))
    .filter((f) => fs.statSync(path.join(SERVER_ROOT, dir, f)).isFile() && filter(f))
    .map((f) => `${dir}/${f}`);

  const MONGO_WRITING_TESTS = [
    'tests/idempotency.mongo.test.js',
    'tests/idempotency.probe-child.js',
    'tests/messageHistory.baseline.test.js',
  ];
  // A production maintenance script legitimately targets the application
  // database, and is dry-run by default. It is listed so the audit stays
  // explicit rather than discovered by surprise.
  const PRODUCTION_MAINTENANCE = ['scripts/clearStaleGoogleCalendarTokens.js'];

  await check('18. dropDatabase() exists only inside the guard', () => {
    const helperRel = 'tests/helpers/disposableMongo.js';
    // This file holds the detector, so it is excluded along with the guard.
    const offenders = [...listFiles('tests'), ...listFiles('scripts')]
      .filter((f) => f !== helperRel && f !== SELF && /\bdropDatabase\s*\(/.test(readCode(f)));
    assert.deepStrictEqual(offenders, [], `dropDatabase() must not be called outside the guard: ${offenders.join(', ')}`);
    // And the single call site is itself guarded.
    const helper = readCode(helperRel);
    assert.strictEqual((helper.match(/\.dropDatabase\s*\(/g) || []).length, 1);
    const dropFn = /const dropDisposableDatabase = async \(ctx\) => \{([\s\S]*?)\n\};/.exec(helper);
    assert.ok(dropFn, 'dropDisposableDatabase must exist');
    assert.ok(dropFn[1].indexOf('assertCleanupAllowed(ctx)') < dropFn[1].indexOf('.dropDatabase()'),
      'cleanup must revalidate ownership immediately before dropping');
  });

  await check('19. no Mongo-writing test or script can fall back to the application URI', () => {
    const offenders = [...MONGO_WRITING_TESTS, 'scripts/measureMessageHistory.js'].filter((f) => {
      const code = readCode(f);
      return /process\.env\.MONGO_URI/.test(code)
        || /process\.env\.DATABASE_URL/.test(code)
        || /require\(['"]dotenv['"]\)/.test(code);
    });
    assert.deepStrictEqual(offenders, [], `these may not read the application URI: ${offenders.join(', ')}`);
    // Any other test that reaches for an ambient URI would be a new hazard.
    const otherTests = listFiles('tests', (f) => f.endsWith('.js'))
      .filter((f) => !MONGO_WRITING_TESTS.includes(f) && f !== 'tests/disposableMongoSafety.test.js')
      .filter((f) => /process\.env\.MONGO_URI|process\.env\.DATABASE_URL/.test(readCode(f)));
    assert.deepStrictEqual(otherTests, [], `tests must not read an ambient Mongo URI: ${otherTests.join(', ')}`);
    // The production maintenance script is the single documented exception.
    for (const f of PRODUCTION_MAINTENANCE) {
      const code = readCode(f);
      assert.ok(/--apply/.test(code), `${f} must stay dry-run by default`);
      assert.ok(/MONGO_URI/.test(code), `${f} is an authenticated production maintenance script`);
    }
  });

  await check('20. every Mongo-writing surface is covered by the guard', () => {
    for (const f of [...MONGO_WRITING_TESTS, 'scripts/measureMessageHistory.js']) {
      const code = readCode(f);
      assert.ok(/disposableMongo/.test(code), `${f} must use the shared disposable Mongo guard`);
    }
    // The guard itself must never load an application .env file.
    const helper = readCode('tests/helpers/disposableMongo.js');
    assert.ok(!/dotenv/.test(helper), 'the guard must not read .env files');
    // Unscoped collection deletes are impossible through the guard.
    assert.ok(/UNSCOPED_DELETE_REFUSED/.test(helper));
    // Every destructive Mongo call in tests/scripts lives in the guard, so no
    // test or script can delete or drop without a live ownership revalidation.
    const rawDestructive = [...listFiles('tests'), ...listFiles('scripts')]
      .filter((f) => f !== SELF)
      .filter((f) => /\b(deleteMany|deleteOne|deleteMany\s*\()\s*\(/.test(readCode(f))
        || /\.deleteMany\s*\(/.test(readCode(f)));
    assert.deepStrictEqual(rawDestructive, [],
      `document deletes must go through the guard: ${rawDestructive.join(', ')}`);
    const helperDeletes = (helper.match(/\.deleteMany\s*\(/g) || []).length;
    assert.strictEqual(helperDeletes, 1, 'the guard owns the single collection delete');
  });

  console.log('-------------------------------------------------------');
  console.log(`Result: ${pass} pass, ${fail} fail`);
};

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
