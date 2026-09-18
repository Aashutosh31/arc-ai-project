'use strict';

// Adversarial semantic matrix (DB-free, no provider keys, no vendors).
//
// A synthetic "acme" integration whose tool DESCRIPTIONS are deliberately
// hostile: every description mentions foreign entities and incidental
// capability verbs ("Create a comment on an issue in a project",
// "Related issues can be listed here"). The engine must still resolve by
// the tool's own semantic identity (name-first operation + entity), never
// by incidental prose. Proves the bug class structurally impossible:
//
//   1. CREATE(ISSUE) pins only the issue mutation (never comment /
//      attachment / project / label tools, never readers)
//   2. CREATE(COMMENT) / CREATE(ATTACHMENT) / CREATE(PROJECT) /
//      CREATE(LABEL) each pin their own entity mutation
//   3. LIST(TEAM) / LIST(PROJECT) pin their listers (no cross-entity)
//   4. READ(ISSUE) never picks a comment/label tool
//   5. UPDATE(ISSUE) pins the issue mutation (never project/comment)
//   6. COMMENT intent pins the comment mutation (never the issue mutation)
//   7. preflight gate rejects every cross-entity candidate directly
//   8. PROPERTY: for every matrix request, every capability pick satisfies
//        pick.entity ∈ requested.entities (hand-written ground truth)
//        pick.operations ∩ requested.operations ≠ ∅
//        pick.server == requested server
//
// Run:  cd server && node tests/mcpAdversarial.test.js

const assert = require('assert');
const {
  selectToolSchemas,
  classifyIntentCapabilities,
  declareToolCapabilities,
  toolEntityStem,
  mcpServerKeyOf
} = require('../lib/llm/toolSelection');
const ai = require('../services/AIService');

const passed = [];
const failed = [];
const test = (name, fn) => (async () => {
  try { await fn(); passed.push(name); console.log(`  ok - ${name}`); }
  catch (err) { failed.push({ name, err }); console.error(`  FAIL - ${name}`); console.error(`         ${err && err.message}`); }
})();

const mk = (name, description, required = {}) => ({
  type: 'function',
  function: {
    name: `mcp_acme_${name}`,
    description,
    parameters: { type: 'object', properties: required, required: Object.keys(required) }
  },
  mcpMetadata: { slug: 'acme' }
});

// Hostile descriptions: foreign entities + incidental verbs everywhere.
const ACME = [
  mk('save_issue', 'Create or update an issue. Omit id to create a new issue with a title. Related comments and attachments can be listed separately.',
    { id: { type: 'string' }, title: { type: 'string' }, team_id: { type: 'string' } }),
  mk('save_comment', 'Create or update a comment on an issue in a project. If id is provided, updates the existing comment; otherwise creates a new one. To create a comment thread, supply the parent reference.',
    { issueId: { type: 'string' }, body: { type: 'string' } }),
  mk('create_attachment', 'Create an attachment for a project or issue. Uploads file content and creates the attachment row. To create, supply a filename.',
    { issueId: { type: 'string' }, filename: { type: 'string' } }),
  mk('prepare_attachment_upload', 'Prepare an attachment upload. To create the attachment row afterwards, supply the returned asset reference.',
    { issue: { type: 'string' } }),
  mk('save_project', 'Create or update a project. Related issues and comments can be listed here; labels for a project are managed separately.',
    { name: { type: 'string' } }),
  mk('save_label', 'Creates labels for a project. To create a label, supply a name. Existing issue labels are left unchanged.',
    { name: { type: 'string' } }),
  mk('list_issues', 'List issues in the workspace, newest first. Archived issues and their comments are excluded unless requested.',
    {}),
  mk('get_issue', 'Retrieve a single issue by its identifier, including its comments and attachments.',
    { issueId: { type: 'string' } }),
  mk('list_comments', 'List comments on an issue. To create a comment, supply the issue reference and body text. Project labels are unrelated.',
    {}),
  mk('get_comments', 'Retrieve comments for an issue thread. Creating new comments uses a different tool.',
    { issueId: { type: 'string' } }),
  mk('list_projects', 'List all projects in the workspace with their owning team. To create a project, supply a name.',
    {}),
  mk('list_teams', 'List all teams in the workspace. Team issues and projects are listed by their own tools.',
    {}),
  mk('search_issues', 'Search issues by keyword across titles and descriptions. Creates nothing; updates nothing.',
    { query: { type: 'string' } }),
  mk('get_team', 'Retrieve a single team by identifier. Lists no issues.',
    { teamId: { type: 'string' } })
];

const NATIVE = () => [];
const names = (tools) => (tools || []).map((s) => s?.function?.name).filter(Boolean);
const W = (short) => `mcp_acme_${short}`;

// Hand-written ground truth per request: requested entities + operations.
// The property test asserts every pick against THIS, never against the
// engine's own tokenizer output (no circularity).
const MATRIX = [
  { q: 'Create an issue called T', entities: ['issue'], ops: ['CREATE'], pins: ['save_issue'] },
  { q: 'Create a comment on it saying hi', entities: ['comment'], ops: ['COMMENT'], pins: ['save_comment'] },
  { q: 'Create an attachment for it', entities: ['attachment'], ops: ['CREATE'], pins: ['create_attachment'] },
  { q: 'Create a project called P', entities: ['project'], ops: ['CREATE'], pins: ['save_project'] },
  { q: 'Create a label called bug', entities: ['label'], ops: ['CREATE'], pins: ['save_label'] },
  { q: 'What teams do I have?', entities: ['team'], ops: ['LIST', 'READ'], pins: ['list_teams'] },
  { q: 'What projects do I have?', entities: ['project'], ops: ['LIST', 'READ'], pins: ['list_projects'] },
  { q: 'Show me the issue', entities: ['issue'], ops: ['READ'], pins: ['get_issue', 'list_issues'] },
  { q: 'Update the issue title', entities: ['issue'], ops: ['UPDATE'], pins: ['save_issue'] }
];

const main = async () => {
  await test('1. CREATE(ISSUE) pins only the issue mutation', async () => {
    const sel = selectToolSchemas('Create an issue called T', NATIVE, { mcpSchemas: ACME });
    assert.deepStrictEqual(sel.mcpCapability, [W('save_issue')], `capability: ${sel.mcpCapability}`);
  });

  await test('2. per-entity CREATE pins its own mutation', async () => {
    for (const [q, pin] of [
      ['Create a comment on it saying hi', 'save_comment'],
      ['Create an attachment for it', 'create_attachment'],
      ['Create a project called P', 'save_project'],
      ['Create a label called bug', 'save_label']
    ]) {
      const sel = selectToolSchemas(q, NATIVE, { mcpSchemas: ACME });
      assert.ok(sel.mcpCapability.includes(W(pin)), `${q} → ${sel.mcpCapability}`);
      assert.strictEqual(sel.mcpCapability.length, 1, `${q} picked extra: ${sel.mcpCapability}`);
    }
  });

  await test('3. LIST(TEAM)/LIST(PROJECT) pin their listers', async () => {
    const teams = selectToolSchemas('What teams do I have?', NATIVE, { mcpSchemas: ACME });
    assert.ok(teams.mcpCapability.includes(W('list_teams')), `teams: ${teams.mcpCapability}`);
    assert.ok(!teams.mcpCapability.includes(W('list_projects')), 'project lister pinned for teams');
    const projects = selectToolSchemas('What projects do I have?', NATIVE, { mcpSchemas: ACME });
    assert.ok(projects.mcpCapability.includes(W('list_projects')), `projects: ${projects.mcpCapability}`);
    assert.ok(!projects.mcpCapability.includes(W('list_teams')), 'team lister pinned for projects');
  });

  await test('4. READ(ISSUE) never picks comment/label tools', async () => {
    const sel = selectToolSchemas('Show me the issue', NATIVE, { mcpSchemas: ACME });
    for (const bad of ['list_comments', 'get_comments', 'save_comment', 'save_label']) {
      assert.ok(!sel.mcpCapability.includes(W(bad)), `${bad} pinned for READ(ISSUE)`);
    }
    assert.ok(sel.mcpCapability.some((n) => [W('get_issue'), W('list_issues'), W('search_issues')].includes(n)),
      `no issue reader: ${sel.mcpCapability}`);
  });

  await test('5. UPDATE(ISSUE) pins the issue mutation only', async () => {
    const sel = selectToolSchemas('Update the issue title', NATIVE, { mcpSchemas: ACME });
    assert.ok(sel.mcpCapability.includes(W('save_issue')), `update: ${sel.mcpCapability}`);
    for (const bad of ['save_project', 'save_comment', 'list_comments']) {
      assert.ok(!sel.mcpCapability.includes(W(bad)), `${bad} pinned for UPDATE(ISSUE)`);
    }
  });

  await test('6. COMMENT intent pins the comment mutation, not the issue one', async () => {
    const sel = selectToolSchemas('Add a comment to it saying well done', NATIVE, { mcpSchemas: ACME });
    assert.ok(sel.mcpCapability.includes(W('save_comment')), `comment: ${sel.mcpCapability}`);
    assert.ok(!sel.mcpCapability.includes(W('save_issue')), 'issue mutation hijacked a comment');
  });

  await test('7. preflight gate rejects every cross-entity candidate directly', async () => {
    const intent = classifyIntentCapabilities('Create an issue called T');
    const badNames = ['save_comment', 'create_attachment', 'prepare_attachment_upload', 'save_project', 'save_label', 'list_comments', 'get_issue', 'list_issues'];
    for (const short of badNames) {
      const schema = ACME.find((s) => s.function.name === W(short));
      const check = ai.gatePreflightCandidate(schema, intent, 'Create an issue called T');
      assert.strictEqual(check.ok, false, `${short} passed the CREATE(ISSUE) gate`);
    }
    const good = ai.gatePreflightCandidate(ACME.find((s) => s.function.name === W('save_issue')), intent, 'Create an issue called T');
    assert.strictEqual(good.ok, true, 'save_issue failed its own gate');
  });

  await test('8. PROPERTY: picks satisfy entity/operation/server invariants', async () => {
    for (const row of MATRIX) {
      const sel = selectToolSchemas(row.q, NATIVE, { mcpSchemas: ACME });
      assert.ok((sel.mcpCapability || []).length > 0, `no picks for "${row.q}"`);
      for (const name of (sel.mcpCapability || [])) {
        const schema = ACME.find((s) => s.function.name === name);
        assert.ok(schema, `pick not in pool: ${name}`);
        // Invariant 1: pick.entity ∈ requested.entities.
        const entity = toolEntityStem(schema);
        assert.ok(row.entities.includes(entity),
          `"${row.q}": ${name} entity=${entity} ∉ [${row.entities}]`);
        // Invariant 2: pick.operations ∩ requested.operations ≠ ∅.
        const declared = declareToolCapabilities(schema);
        const overlap = [...declared].filter((c) => row.ops.includes(c));
        assert.ok(overlap.length > 0,
          `"${row.q}": ${name} ops=[${[...declared]}] ∩ [${row.ops}] = ∅`);
        // Invariant 3: pick.server == requested server.
        assert.strictEqual(mcpServerKeyOf(schema), 'acme', `${name} off-server`);
      }
      // Invariant 4: the expected pin is present.
      for (const pin of row.pins) {
        if (row.pins.length === 1) {
          assert.ok(sel.mcpCapability.includes(W(pin)), `"${row.q}": missing pin ${pin} in ${sel.mcpCapability}`);
        }
      }
    }
  });

  console.log(`\n${passed.length + failed.length} tests, ${passed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exitCode = 1;
  }
};

main().catch((err) => { console.error(err); process.exitCode = 1; });
