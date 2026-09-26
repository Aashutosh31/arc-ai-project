'use strict';

// disposableMongo.js — the SINGLE safety abstraction for every Mongo-writing
// test and script in this repository.
//
// WHY THIS EXISTS
//   An earlier Mongo integration test built its target by string concatenation
//   (`${process.env.MONGO_URI}/${dbName}`). When the ambient MONGO_URI already
//   carried a database path, the driver used the FIRST path segment — i.e. the
//   APPLICATION database — and the test's `dropDatabase()` then wiped it.
//   Nothing about that failure was obvious from the call site.
//
// CONTRACT
//   1. Explicit opt-in only. Four variables are required and there is NO
//      fallback to MONGO_URI, DATABASE_URL, or any application .env file.
//   2. Fail closed. Every missing or contradictory signal throws
//      DisposableMongoSafetyError BEFORE a connection is attempted.
//   3. The database is selected with the driver's `dbName` option, never by
//      appending a name to the URI, so SRV hosts, credentials, replica sets and
//      query options are preserved and cannot be used to redirect the database.
//   4. The selected database is re-read from the live connection and must match
//      the generated name exactly.
//   5. Only `^arc_ai_test_[a-z0-9][a-z0-9_-]{7,}$` is ever accepted, and the
//      application's own database name is refused by name.
//   6. The target host is compared against MONGO_TEST_EXPECTED_HOST BEFORE
//      connecting; every host in the URI must match.
//   7. A run-ownership marker is written on connect. Cleanup revalidates the
//      marker, host, database name, live database name and the collection set
//      immediately before destroying anything.
//   8. `dropDatabase()` exists exactly once in this repository: inside
//      dropDisposableDatabase() below, after every check has passed.
//
// Usage (tests and scripts):
//   const mongo = require('./helpers/disposableMongo');
//   const ctx = await mongo.openDisposableMongo({ allowCollections: ['idempotencyrecords'] });
//   try { /* ...writes... */ } finally { await mongo.dropDisposableDatabase(ctx); }

const crypto = require('node:crypto');

const DISPOSABLE_DB_PREFIX = 'arc_ai_test_';
const DISPOSABLE_DB_PATTERN = /^arc_ai_test_[a-z0-9][a-z0-9_-]{7,}$/;

// Database names that must never be a test target, however they were reached.
const RESERVED_DB_NAMES = new Set([
  'test', 'tests', 'testing',
  'admin', 'local', 'config',
  'prod', 'production', 'staging', 'stage', 'development', 'dev',
  'app', 'apps', 'main', 'default', 'live',
]);

// The application database is not hardcoded anywhere: it is whatever the
// ambient URI points at. These are the conventional names for it.
const APP_DB_NAME_HINTS = [
  'jarvis', 'jarvis_db', 'jarvisdb', 'arc_ai', 'arcai', 'arc-ai',
  'arc_ai_prod', 'arc_ai_production', 'arc_ai_app', 'arc_ai_dev',
  'arc_ai_staging', 'arc_ai_development', 'production_db', 'prod_db',
];

const PRODUCTION_NODE_ENVS = new Set(['production', 'prod']);

const MARKER_COLLECTION = '__disposableMongoRun';
const MARKER_ID = 'ownership';
const MARKER_KIND = 'disposable-mongo-run';

// Opt-in for tests whose reachable models cannot be enumerated up front. Safe
// because openDisposableMongo() proves the database was EMPTY at connect, so
// every collection present at cleanup was created by this run. A database that
// already held data is refused at connect, so the app database can never be
// adopted this way.
const ANY_RUN_COLLECTION = 'disposable-any-collection-created-by-this-run';

const REQUIRED_ENV = Object.freeze({
  MONGO_TEST_URI: 'URI of a DISPOSABLE Mongo host (never the application host)',
  MONGO_TEST_EXPECTED_HOST: 'exact host the connection must match',
  MONGO_TEST_DISPOSABLE: 'must be exactly 1',
  RUN_MONGO_INTEGRATION: 'must be exactly 1 to opt into live Mongo tests',
});

// Ambient variables that are read for ONE purpose only: discovering the
// application database name so it can be refused. They are never used as a
// connection source, and never logged.
const AMBIENT_URI_VARS = ['MONGO_URI', 'DATABASE_URL'];

class DisposableMongoSafetyError extends Error {
  constructor(code, message) {
    super(`[disposable-mongo:${code}] ${message}`);
    this.name = 'DisposableMongoSafetyError';
    this.code = code;
  }
}

const fail = (code, message) => ({ ok: false, code, message });
const pass = (value) => ({ ok: true, value });

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const generateRunId = (now = Date.now(), rand = crypto.randomBytes) => {
  const stamp = Number(now).toString(36);
  const noise = rand(8).toString('hex');
  return `${stamp}${noise}`.toLowerCase().slice(0, 20);
};

const disposableDbName = (runId) => `${DISPOSABLE_DB_PREFIX}${runId}`;

// Minimal, explicit Mongo URI parser. The security-critical path must not
// depend on WHATWG URL semantics for mongodb+srv, replica sets, or credentials.
const parseMongoUri = (uri) => {
  if (typeof uri !== 'string' || !uri.trim()) return fail('MONGO_TEST_URI_MALFORMED', 'MONGO_TEST_URI is not a non-empty string');
  const m = /^mongodb(?:\+srv)?:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$/i.exec(uri.trim());
  if (!m) return fail('MONGO_TEST_URI_MALFORMED', 'MONGO_TEST_URI is not a mongodb:// or mongodb+srv:// URI');

  const authority = m[1] || '';
  const path = m[2] === undefined ? '' : m[2];
  const search = m[3] === undefined ? '' : m[3];

  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : '';
  const hostsPart = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostsPart) return fail('MONGO_TEST_URI_MALFORMED', 'MONGO_TEST_URI has no host');

  const hosts = hostsPart.split(',').map((entry) => {
    const raw = entry.trim();
    if (!raw) return null;
    const bracket = /^\[(.+)\](?::(\d+))?$/.exec(raw);
    if (bracket) return { host: bracket[1].toLowerCase(), port: bracket[2] || '' };
    const idx = raw.lastIndexOf(':');
    if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
      return { host: raw.slice(0, idx).toLowerCase(), port: raw.slice(idx + 1) };
    }
    return { host: raw.toLowerCase(), port: '' };
  }).filter(Boolean);
  if (!hosts.length) return fail('MONGO_TEST_URI_MALFORMED', 'MONGO_TEST_URI has no parseable host');

  const hasCredentials = /:/.test(userinfo);
  const database = path ? decodeURIComponent(path.replace(/\/+$/, '')) : '';
  const [first] = hosts;
  return pass({
    scheme: /^mongodb\+srv:\/\//i.test(uri.trim()) ? 'mongodb+srv' : 'mongodb',
    hosts,
    host: first.host,
    port: first.port,
    // Credentials are reduced to a boolean at parse time: this module never
    // retains or emits them, so they cannot leak into a log or an error.
    hasCredentials,
    database: database || null,
    search,
  });
};

// Reads the application URI for its database name ONLY. Nothing is connected,
// and the URI's credentials never leave this function.
const discoverAppDbName = (env = process.env) => {
  for (const key of AMBIENT_URI_VARS) {
    const parsed = parseMongoUri(env[key]);
    if (parsed.ok && parsed.value.database) return parsed.value.database;
  }
  return null;
};

const appDbNameSet = (env = process.env) => {
  const set = new Set(APP_DB_NAME_HINTS);
  const discovered = discoverAppDbName(env);
  if (discovered) set.add(discovered);
  return set;
};

const evaluateDisposableDbName = (name, options = {}) => {
  const appNames = options.appDbNames instanceof Set
    ? options.appDbNames
    : new Set(APP_DB_NAME_HINTS);
  const candidate = typeof name === 'string' ? name.trim() : '';
  if (!candidate) return fail('MONGO_TEST_DB_NAME_INVALID', 'generated database name is empty');
  // Specific denials are reported before the structural pattern check, so a
  // caller sees *why* a name was refused rather than only that it looks wrong.
  if (RESERVED_DB_NAMES.has(candidate.toLowerCase())) {
    return fail('MONGO_TEST_DB_NAME_FORBIDDEN', `refusing reserved database name "${candidate}"`);
  }
  if (appNames.has(candidate)) {
    return fail('MONGO_TEST_DB_NAME_FORBIDDEN',
      'refusing the application database name — a disposable run must use its own generated database');
  }
  if (!DISPOSABLE_DB_PATTERN.test(candidate)) {
    return fail('MONGO_TEST_DB_NAME_INVALID',
      `database name must match ${DISPOSABLE_DB_PATTERN.source} — refusing "${candidate}"`);
  }
  return pass(candidate);
};

const hostMatchesExpected = (hosts, expectedHost) => {
  const expected = String(expectedHost || '').trim().toLowerCase();
  if (!expected) return false;
  const expectedHostOnly = expected.replace(/:\d+$/, '');
  return hosts.every(({ host, port }) => {
    if (host === expected) return true;
    if (port && `${host}:${port}` === expected) return true;
    return host === expectedHostOnly;
  });
};

// The single place that decides how a connection is made. The URI is passed
// through verbatim (SRV, credentials, replica set and query options preserved)
// and the database is chosen with the driver's dbName option, so nothing in the
// URI's path or query can redirect the connection to another database.
const resolveConnectTarget = (plan) => pass({
  uri: plan.uri,
  options: { dbName: plan.dbName },
  host: plan.host,
  database: plan.dbName,
});

const validateDisposableConfig = (input = {}) => {
  const env = input.env || process.env;
  const appDbNames = input.appDbNames || appDbNameSet(env);
  const runId = input.runId
    || env.MONGO_TEST_RUN_ID
    || generateRunId(input.now, input.random);
  const dbName = input.generatedDbName
    || env.MONGO_TEST_DB_NAME
    || disposableDbName(runId);

  // 1. Production mode is refused outright.
  if (PRODUCTION_NODE_ENVS.has(String(env.NODE_ENV || '').trim().toLowerCase())) {
    return fail('MONGO_TEST_PRODUCTION_MODE',
      'NODE_ENV is production — disposable Mongo tests may never run in production mode');
  }

  // 2. The opt-in must be present and explicit. There is no ambient fallback.
  if (env.MONGO_TEST_DISPOSABLE !== '1') {
    return fail('MONGO_TEST_DISPOSABLE_REQUIRED',
      'MONGO_TEST_DISPOSABLE=1 is required. MONGO_URI / DATABASE_URL / .env are never used as a fallback.');
  }
  if (env.RUN_MONGO_INTEGRATION !== '1') {
    return fail('RUN_MONGO_INTEGRATION_REQUIRED',
      'RUN_MONGO_INTEGRATION=1 is required to run Mongo integration tests.');
  }

  // 3. The URI and the expected host must be supplied by the operator.
  if (!env.MONGO_TEST_URI || !String(env.MONGO_TEST_URI).trim()) {
    return fail('MONGO_TEST_URI_MISSING',
      'MONGO_TEST_URI is required. Ambient MONGO_URI / DATABASE_URL are deliberately ignored.');
  }
  if (!env.MONGO_TEST_EXPECTED_HOST || !String(env.MONGO_TEST_EXPECTED_HOST).trim()) {
    return fail('MONGO_TEST_EXPECTED_HOST_MISSING',
      'MONGO_TEST_EXPECTED_HOST is required so the target host can be allowlisted before connecting.');
  }

  const target = parseMongoUri(env.MONGO_TEST_URI);
  if (!target.ok) return target;

  // 4. Host allowlist — checked BEFORE any connection is attempted.
  const expectedHost = String(env.MONGO_TEST_EXPECTED_HOST).trim();
  if (!hostMatchesExpected(target.value.hosts, expectedHost)) {
    return fail('MONGO_TEST_HOST_MISMATCH',
      `host=${target.value.host} does not match MONGO_TEST_EXPECTED_HOST=${expectedHost} — refusing to connect`);
  }

  // 5. A URI that names a real database would silently reuse it. Refuse it.
  const baseDb = target.value.database;
  if (baseDb) {
    const baseCheck = evaluateDisposableDbName(baseDb, { appDbNames });
    if (!baseCheck.ok) {
      return fail('MONGO_TEST_BASE_DB_FORBIDDEN',
        `MONGO_TEST_URI names database "${baseDb}" which is not a disposable test database — ` +
        'supply a host-only URI and let the guard generate the database name');
    }
  }

  const nameCheck = evaluateDisposableDbName(dbName, { appDbNames });
  if (!nameCheck.ok) return nameCheck;

  return pass({
    runId,
    dbName,
    host: target.value.host,
    port: target.value.port,
    expectedHost,
    hosts: target.value.hosts,
    uri: String(env.MONGO_TEST_URI).trim(),
    appDbNames,
  });
};

// Pure pre-connect gate. Throws on any unsafe or incomplete configuration.
const planDisposableRun = (input = {}) => {
  const result = validateDisposableConfig(input);
  if (!result.ok) throw new DisposableMongoSafetyError(result.code, result.message);
  return result.value;
};

// Did the operator express any intent to run Mongo at all? Used to choose
// between a SKIP (nothing configured) and a FAIL (configured but unsafe).
const classifyMongoIntent = (env = process.env) => (
  env.MONGO_TEST_URI || env.RUN_MONGO_INTEGRATION ? 'explicit' : 'absent'
);

// Required variables, for documentation and error messages.
const describeRequiredEnv = () => Object.entries(REQUIRED_ENV)
  .map(([key, note]) => `  ${key} — ${note}`)
  .join('\n');

/* ------------------------------------------------------------------ */
/* Marker + cleanup authorization (pure)                              */
/* ------------------------------------------------------------------ */

const expectedMarker = (plan) => ({
  _id: MARKER_ID,
  kind: MARKER_KIND,
  runId: plan.runId,
  host: plan.host,
  database: plan.dbName,
  disposable: true,
  createdAt: new Date().toISOString(),
  generator: 'server/tests/helpers/disposableMongo',
});

// Every condition that must hold before anything destructive may happen.
const evaluateOwnership = (input = {}) => {
  const {
    marker, runId, host, database, liveDatabase, collections,
    allowCollections = [], collectionsAtOpen = [],
  } = input;
  const openSet = new Set(collectionsAtOpen);
  const preExisting = (collections || []).filter((name) => openSet.has(name));
  const explicit = new Set([MARKER_COLLECTION, ...allowCollections]);
  // Either an explicitly declared collection, or one this run created in a
  // database that was verified empty when it connected.
  const allowed = (name) => explicit.has(name)
    || (allowCollections.includes(ANY_RUN_COLLECTION) && !openSet.has(name));

  if (!marker) {
    return fail('MARKER_MISSING',
      `no ownership marker in collection "${MARKER_COLLECTION}" — refusing to delete or drop anything`);
  }
  if (marker.disposable !== true || marker.kind !== MARKER_KIND) {
    return fail('MARKER_NOT_DISPOSABLE',
      'ownership marker is not a disposable-run marker — refusing');
  }
  if (marker.runId !== runId) {
    return fail('MARKER_RUN_MISMATCH',
      `ownership marker belongs to runId=${marker.runId}, not runId=${runId} — another run owns this database`);
  }
  if (marker.host !== host) {
    return fail('MARKER_HOST_MISMATCH',
      `ownership marker host=${marker.host} does not match expected host=${host} — refusing`);
  }
  if (marker.database !== database) {
    return fail('MARKER_DATABASE_MISMATCH',
      `ownership marker database=${marker.database} does not match generated database=${database} — refusing`);
  }
  if (liveDatabase !== database) {
    return fail('DB_NAME_MISMATCH',
      `connected database is "${liveDatabase}", expected "${database}" — refusing`);
  }
  if (preExisting.length) {
    return fail('UNEXPECTED_COLLECTIONS',
      `database already held collections when this run connected (${preExisting.join(', ')}) — ` +
      'this is not a fresh disposable database, refusing to touch it');
  }
  const unexpected = (collections || []).filter((name) => !allowed(name));
  if (unexpected.length) {
    return fail('UNEXPECTED_COLLECTIONS',
      `database holds collections that this run does not own (${unexpected.join(', ')}) — ` +
      'refusing to delete or drop anything');
  }
  return pass(true);
};

const assertOwnership = (input = {}) => {
  const result = evaluateOwnership(input);
  if (!result.ok) throw new DisposableMongoSafetyError(result.code, result.message);
  return result.value;
};

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

// The only sanctioned log shape. Contains no username, password, port path or
// query parameters — just host, database and the disposable flag.
const safeTargetSummary = (target = {}) => [
  `host=${target.host || 'unknown'}`,
  `database=${target.dbName || target.database || 'unknown'}`,
  'disposable=true',
].join('\n');

const redactUri = (uri) => {
  const parsed = parseMongoUri(uri);
  if (!parsed.ok) return '<unparseable-uri>';
  return `${parsed.value.scheme}://<redacted>@${parsed.value.hosts
    .map((h) => (h.port ? `${h.host}:${h.port}` : h.host)).join(',')}`;
};

/* ------------------------------------------------------------------ */
/* Child processes                                                     */
/* ------------------------------------------------------------------ */

// Secrets travel through the environment, never through argv (argv is visible
// to every process on the host). Only non-secret arguments are ever returned.
const buildChildArgs = (key, extra = []) => [String(key), ...extra.map(String)];

const buildChildEnv = (plan, extra = {}) => ({
  MONGO_TEST_URI: plan.uri,
  MONGO_TEST_EXPECTED_HOST: plan.expectedHost,
  MONGO_TEST_DISPOSABLE: '1',
  RUN_MONGO_INTEGRATION: '1',
  MONGO_TEST_RUN_ID: plan.runId,
  MONGO_TEST_DB_NAME: plan.dbName,
  ...extra,
});

/* ------------------------------------------------------------------ */
/* Live operations                                                     */
/* ------------------------------------------------------------------ */

const liveDatabaseName = (connection) => {
  if (!connection) return null;
  if (connection.db && typeof connection.db.databaseName === 'string') return connection.db.databaseName;
  return typeof connection.name === 'string' ? connection.name : null;
};

const listCollectionNames = async (db) => {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  return infos.map((i) => i.name);
};

const disconnectQuietly = async (connection) => {
  try {
    if (connection) await connection.close();
  } catch (err) { /* shutting down anyway */ }
};

// Confirms the live connection is on the generated database and the allowlisted
// host. Throws — without touching data — on any mismatch.
const verifyLiveConnection = async (plan, connection) => {
  const actual = liveDatabaseName(connection);
  if (actual !== plan.dbName) {
    throw new DisposableMongoSafetyError('DB_NAME_MISMATCH',
      `connected database is "${actual}", expected generated database "${plan.dbName}" — disconnecting without changes`);
  }
  const liveHost = String(connection.host || plan.host).split(':')[0].toLowerCase();
  if (liveHost !== plan.host) {
    throw new DisposableMongoSafetyError('MONGO_TEST_HOST_MISMATCH',
      `connected host=${liveHost} does not match MONGO_TEST_EXPECTED_HOST=${plan.host} — disconnecting without changes`);
  }
};

const connectDisposable = async (plan, options) => {
  const mongoose = options.mongoose || require('mongoose');
  const connect = resolveConnectTarget(plan);
  if (!connect.ok) throw new DisposableMongoSafetyError(connect.code, connect.message);
  await mongoose.connect(connect.value.uri, {
    ...connect.value.options,
    ...(options.connectOptions || {}),
  });
  return { connection: mongoose.connection, db: mongoose.connection.db };
};

const makeContext = (plan, link, allowCollections) => ({
  plan,
  runId: plan.runId,
  dbName: plan.dbName,
  host: plan.host,
  expectedHost: plan.expectedHost,
  allowCollections: (allowCollections || []).map(String),
  collectionsAtOpen: [],
  connection: link.connection,
  db: link.db,
  closed: false,
});

// Opens a disposable database, writing the ownership marker on the way in.
// Throws before connecting if the configuration is unsafe.
const openDisposableMongo = async (options = {}) => {
  const plan = planDisposableRun(options);
  const link = await connectDisposable(plan, options);

  try {
    await verifyLiveConnection(plan, link.connection);

    // A generated name should never collide, but an existing collection set means
    // somebody else's data is here and we do not own it.
    const before = await listCollectionNames(link.db);
    if (before.length) {
      throw new DisposableMongoSafetyError('UNEXPECTED_COLLECTIONS',
        `disposable database already exists and holds collections (${before.join(', ')}) — refusing to reuse it`);
    }

    await link.db.collection(MARKER_COLLECTION).insertOne(expectedMarker(plan));
    const ctx = makeContext(plan, link, options.allowCollections);
    ctx.collectionsAtOpen = before;
    return ctx;
  } catch (err) {
    await disconnectQuietly(link.connection);
    throw err;
  }
};

// Read-only attach for a second process in the SAME run (e.g. a restart probe).
// The child must present the parent's runId and database name and the ownership
// marker must match, so it can only ever read the run's own data.
const attachDisposableMongo = async (options = {}) => {
  const plan = planDisposableRun(options);
  const link = await connectDisposable(plan, options);

  try {
    await verifyLiveConnection(plan, link.connection);
    assertOwnership({
      marker: await link.db.collection(MARKER_COLLECTION).findOne({ _id: MARKER_ID }),
      runId: plan.runId,
      host: plan.host,
      database: plan.dbName,
      liveDatabase: liveDatabaseName(link.connection),
      collections: await listCollectionNames(link.db),
      allowCollections: (options.allowCollections || []).map(String),
      collectionsAtOpen: [],
    });
    return makeContext(plan, link, options.allowCollections);
  } catch (err) {
    await disconnectQuietly(link.connection);
    throw err;
  }
};

const readOwnership = async (ctx) => {
  const marker = await ctx.db.collection(MARKER_COLLECTION).findOne({ _id: MARKER_ID });
  return {
    marker,
    runId: ctx.runId,
    host: ctx.host,
    database: ctx.dbName,
    liveDatabase: liveDatabaseName(ctx.connection),
    collections: await listCollectionNames(ctx.db),
    allowCollections: ctx.allowCollections,
    collectionsAtOpen: ctx.collectionsAtOpen,
  };
};

// Revalidates every ownership signal against the live database. Callers must
// treat a throw here as "do not delete, do not drop, disconnect".
const assertCleanupAllowed = async (ctx, extra = {}) => {
  const snapshot = { ...(await readOwnership(ctx)), ...extra };
  return assertOwnership(snapshot);
};

// The ONLY dropDatabase() in the repository. Every check is re-run here,
// immediately before the destructive call.
const dropDisposableDatabase = async (ctx) => {
  await assertCleanupAllowed(ctx);
  await ctx.db.dropDatabase();
  ctx.closed = true;
  await disconnectQuietly(ctx.connection);
};

// Scoped deletes for tests that must keep the database around. A filter is
// mandatory: an empty filter would remove the whole collection.
const deleteDisposableDocuments = async (ctx, collectionName, filter) => {
  const name = String(collectionName);
  if (!filter || typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).length === 0) {
    throw new DisposableMongoSafetyError('UNSCOPED_DELETE_REFUSED',
      'a non-empty filter is required — refusing to delete a whole collection');
  }
  await assertCleanupAllowed(ctx, { allowCollections: [...ctx.allowCollections, name] });
  const result = await ctx.db.collection(name).deleteMany(filter);
  return { deletedCount: result.deletedCount };
};

const closeDisposableMongo = async (ctx) => {
  if (!ctx || ctx.closed) return;
  ctx.closed = true;
  await disconnectQuietly(ctx.connection);
};

module.exports = {
  ANY_RUN_COLLECTION,
  attachDisposableMongo,
  DisposableMongoSafetyError,
  DISPOSABLE_DB_PREFIX,
  DISPOSABLE_DB_PATTERN,
  MARKER_COLLECTION,
  MARKER_ID,
  REQUIRED_ENV,
  AMBIENT_URI_VARS,
  appDbNameSet,
  assertCleanupAllowed,
  assertOwnership,
  buildChildArgs,
  buildChildEnv,
  classifyMongoIntent,
  closeDisposableMongo,
  deleteDisposableDocuments,
  describeRequiredEnv,
  discoverAppDbName,
  disposableDbName,
  dropDisposableDatabase,
  evaluateDisposableDbName,
  evaluateOwnership,
  expectedMarker,
  generateRunId,
  hostMatchesExpected,
  openDisposableMongo,
  parseMongoUri,
  planDisposableRun,
  redactUri,
  resolveConnectTarget,
  safeTargetSummary,
  validateDisposableConfig,
};
