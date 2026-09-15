// Deterministic, capability-based tool selection — no LLM call, no embeddings.
//
// The global registry (tools/index.js) stays intact: every tool remains
// registered and executable by name. Selection only filters which SCHEMAS are
// attached to THIS provider request, so a 22-tool fixed cost becomes a
// 0-6 tool relevant subset. Pure matcher (matchGroups) is dependency-free
// and unit-testable; selectToolSchemas injects the registry accessor.

const MAX_TOOLS_PER_REQUEST = 6;

// Capability groups derived from the ACTUAL tool registry (22 tools).
// There is no GitHub/automation group because no such tools are registered.
const CAPABILITY_GROUPS = {
  memory: ['memorize', 'recallMemory', 'storeUserFact'],
  calendar: ['checkCalendar', 'scheduleMeeting', 'createReminder', 'setReminder', 'stopReminder'],
  web: ['webSearch', 'scrapeWebsite', 'openWebsite', 'getTopNews'],
  media: ['playMedia', 'stopMedia'],
  comms: ['sendEmail', 'sendWhatsAppMessage'],
  utility: ['getTime', 'getWeather', 'copyToClipboard', 'executeCode'],
  theme: ['changeTheme'],
  research: ['deepResearchSwarm']
};

// Priority order when several groups match (core behavior first) and when
// the budget enforcer must drop groups (dropped from the END of this list).
const GROUP_PRIORITY = ['memory', 'calendar', 'web', 'media', 'comms', 'utility', 'theme', 'research'];

// Safe default for ambiguous/generic requests: core memory behavior only.
// A pure knowledge question ("Explain encapsulation") matches nothing and
// gets exactly these 3 — never all 22.
const DEFAULT_GROUPS = ['memory'];

const GROUP_PATTERNS = {
  media: [/\bplay\b/, /\bsong\b/, /\bsongs\b/, /\bmusic\b/, /\bvideo\b/, /\byoutube\b/, /\bwatch\b/, /\blisten\b/, /\bpause\b/, /\bmovie\b/, /\bpodcast\b/, /\bplayback\b/],
  calendar: [/\breminder\b/, /\bremind\b/, /\balarm\b/, /\bschedule\b/, /\bmeeting\b/, /\bappointment\b/, /\bcalendar\b/, /\bdeadline\b/, /\btodo\b/],
  theme: [/\btheme\b/, /\bdark mode\b/, /\blight mode\b/, /\bhacker\b/, /\bcyberpunk\b/, /\bdracula\b/, /\bnord\b/, /\bappearance\b/, /\bcolor scheme\b/, /\bcolour scheme\b/],
  web: [/\bsearch\b/, /\bgoogle\b/, /\bbrowse\b/, /\bwebsite\b/, /\bwebpage\b/, /\burl\b/, /\bscrape\b/, /\bscraping\b/, /\bnews\b/, /\blatest\b/, /\bheadlines\b/, /\blook up\b/, /\blook it up\b/, /\bfind online\b/],
  comms: [/\bsend\b/, /\bemail\b/, /\be-mail\b/, /\bwhatsapp\b/, /\bforward\b/, /\bdeliver\b/, /\btext (him|her|them|me|my|my mom|my dad)\b/],
  memory: [/\bremember\b/, /\bforget\b/, /\brecall\b/, /\bmemorize\b/, /\bmemorise\b/, /\bmy name\b/, /\bi like\b/, /\bi love\b/, /\bi prefer\b/, /\bmy favorit\w*\b/, /\bi use\b/, /\bi work\b/, /\bnote that\b/, /\bkeep in mind\b/, /don't forget/],
  research: [/\bresearch\b/, /\bdeep dive\b/, /\bdeep-dive\b/, /\binvestigat\w*\b/, /\bthesis\b/, /\breport on\b/, /\bcomparative analysis\b/, /\bliterature review\b/],
  utility: [/\btime\b/, /\bdate\b/, /\btoday\b/, /\bclock\b/, /\bweather\b/, /\btemperature\b/, /\brain\b/, /\bforecast\b/, /\bcopy\b/, /\bclipboard\b/, /\bpaste\b/, /\bcalculat\w*\b/, /\bcompute\b/, /\bmath\b/, /\bcode\b/, /\bscript\b/, /\bprogram\b/, /\bdebug\b/, /\brun\b/, /\bexecut\w*\b/]
};

// Output-size intent: code/explanation answers deserve a larger completion
// when input headroom allows. Keyword-based, same cheap pass.
const EXTENDED_OUTPUT_PATTERNS = [/\bcode\b/, /\bfunction\b/, /\bclass\b/, /\bdebug\b/, /\berror\b/, /\bscript\b/, /\bprogram\b/, /\bimplement\b/, /\balgorithm\b/, /\bexplain\b/, /\bexplanation\b/, /\btutorial\b/, /\bhow does\b/, /\bhow do\b/, /\bwhy does\b/, /\bcompare\b/, /\bdifference between\b/, /\bsteps\b/, /\bstep by step\b/, /\bessay\b/, /\bguide\b/];

const normalizeText = (text) => String(text || '').toLowerCase();

// ---- Generic MCP capability model -----------------------------------------
// The lexical scorer can only surface tools whose name/description tokens
// overlap the query. It cannot select a tool the user never names: "add a new
// section to the page you just created" contains none of `append_block_children`
// / `update_page`, so write tools were never offered. This layer closes that
// gap without any tool names or vendor knowledge: it classifies the INTENT of
// the query and the CAPABILITIES each exposed MCP schema declares, then
// guarantees a slot for every requested capability (action verbs before
// lookups). It never weakens the no-substitution rule: capability picks come
// only from the policy-permitted exposed set and are suppressed with the whole
// request when policy blocks the requested capability.
const CAPABILITY_PICK_ORDER = [
  'CREATE', 'UPDATE', 'DELETE', 'SEND', 'UPLOAD', 'DOWNLOAD',
  'EXECUTE', 'SEARCH', 'READ', 'LIST'
];

// Tool-declaration side: capability keywords over wire name + description +
// parameter names. `remove` is DELETE (never UPDATE: `\bmov\w*` cannot match
// inside `remove` because there is no word boundary before "mov").
const CAP_TOOL_PATTERNS = {
  READ: [/\b(read\w*|get\b|fetch\w*|retriev\w*|view\w*|open\w*|load\w*|display\w*|show\w*|see\w*|preview\w*)\b/],
  SEARCH: [/\b(search\w*|find\w*|lookup\w*|look\s+up\b|query\w*)\b/],
  LIST: [/\b(list\w*|enumerat\w*)\b/],
  CREATE: [/\b(creat\w*|generat\w*|build\w*|insert\w*|compos\w*)\b/],
  UPDATE: [/\b(updat\w*|edit\w*|modify\w*|chang\w*|alter\w*|renam\w*|mov\w*|set\b|append\w*|replac\w*|adjust\w*|revise\w*|toggl\w*|patch\w*)\b/],
  DELETE: [/\b(delet\w*|remov\w*|erase\w*|wipe\w*|destroy\w*|truncat\w*|trash\w*|archiv\w*|discard\w*)\b/],
  SEND: [/\b(send\w*|post\b|publish\w*|notify\w*|deliver\w*|email\w*|share\w*|messag\w*|comment\w*|forward\w*|reply\w*|sms\b)\b/],
  UPLOAD: [/\b(upload\w*|attach\w*)\b/],
  DOWNLOAD: [/\b(download\w*|export\w*)\b/],
  EXECUTE: [/\b(execut\w*|run\w*|invoke\w*|trigger\w*|start\b|launch\w*|apply\w*|process\w*|compile\w*)\b/]
};

// Intent side: same verb families, applied to the user's message, with one
// asymmetry: users saying "clear …" mean removal ("clear the old pages"),
// while tool descriptions saying "clear" usually mean the adjective ("a
// clear best match"). Intent keeps `clear` as DELETE; declaration drops it.
// `add/insert` are handled separately by the add-rule below.
const CAP_INTENT_PATTERNS = Object.fromEntries(
  Object.entries(CAP_TOOL_PATTERNS).map(([cap, list]) => [
    cap,
    cap === 'DELETE'
      ? [/(\bclear\b)/, ...list]
      : [...list]
  ])
);

// Parts/rows/blocks that are added INTO an existing entity: strong UPDATE
// evidence for "add X to Y". Whole entities (page/document/file/...) tell us
// "add a new page" = CREATE — but only when no existing-target evidence exists.
const PART_ENTITIES = new Set([
  'section', 'block', 'content', 'snippet', 'row', 'column', 'comment',
  'field', 'entry', 'line', 'paragraph', 'heading', 'subheading', 'property',
  'value', 'attachment', 'bullet', 'item', 'link', 'quote', 'checklist',
  'summary', 'child', 'body', 'text', 'notes', 'data', 'media', 'button',
  'step', 'bullet point'
]);
const ADD_VERB_RE = /\b(add\w*|insert\w*|put\b)\b/;
// Existing-target evidence: "add X to the page", "add X to it", "add X into
// this doc" — or any part-entity present at all ("add a section").
const ADD_TARGET_RE = /\b(add\w*|insert\w*|put\b)\b[\s\S]*\b(to|into|in)\b\s+(the|it|this|that|its|a|an)/;
// Creating a whole new object: "add a new page", "add a file to the vault".
// Only indefinite articles/new evidence counts — "add a section to the page"
// (part, existing target) must stay UPDATE. The bridge between the verb and
// the entity is clause-bounded ([^.!?;,\n], ≤40 chars): without that bound,
// "… add a section … multiple sentences later 'a new page' …" would match the
// FIRST add verb against a FAR LATER "a new page", misclassifying an update
// request as a create request. Bounded, an "add" only ever counts the noun in
// its own clause ("add a new page" = CREATE; "add a new section … to the page"
// has 'page' after the add but 'section' is the object's part, so UPDATE).
const WHOLE_NEW_RE = /\b(add\w*|insert\w*)\b[^.!?;,\n]{0,40}\b(?:a|an|new|another|fresh)\s+(?:new\s+)?(page|document|doc|file|folder|meeting|event|issue|ticket|project|task|note|record|contact|repo|repository|database|board|todo|reminder|draft|message|email|customer|product|workspace)\b/;
// Explicit do-not-modify-existing suppression: "do not modify existing
// pages", "don't change any existing …", "never update other …". Generic
// English negations (mirrors the negated-create rule), never tool names.
// The existing/other qualifier keeps it narrow: bare "don't update the
// title, update the body" does not match and keeps UPDATE.
const NEGATED_MODIFY_RE = /\b(do\s+not|don't|dont|never)\s+(modify|modif\w*|change|chang\w*|alter\w*|updat\w*|edit\w*|touch)\s+(existing|other|any\s+(existing|other))\b/;

// Capability verbs whose immediately preceding word marks them as NEGATED or
// DESCRIPTIVE rather than a requested capability:
//   "do not create a page"            → 'create' is forbidden, not requested
//   "the page you created earlier"    → past description of an existing object
//   "the page we opened last week"    → relative clause, not an instruction
// Only the immediate predecessor counts, so "please create", "I want you to
// create", "… and update …" still trigger their capabilities.
const INTENT_VERB_DROP_PREV = new Set([
  'not', "don't", 'dont', 'never', 'no', 'avoid', 'stop',
  'you', 'i', 'we', 'they', 'he', 'she', 'it', 'that', 'which', 'who',
  'when', 'how', 'what', 'has', 'had', 'have', 'been', 'this', 'one'
]);

const CAP_VERB_ANY_RE = new RegExp(
  `(?:${Object.values(CAP_INTENT_PATTERNS)
    .flatMap((list) => list.map((re) => re.source))
    .join('|')
  }|${ADD_VERB_RE.source})`,
  'g'
);

function classifyIntentCapabilities(text) {
  const lowered = normalizeText(text);
  const caps = new Set();
  const hits = [];
  for (const m of lowered.matchAll(CAP_VERB_ANY_RE)) {
    hits.push({ verb: m[0], index: m.index });
  }
  for (const hit of hits) {
    const before = lowered.slice(0, hit.index);
    const prev = before.trim().match(/[a-z0-9']+$/);
    if (prev && INTENT_VERB_DROP_PREV.has(prev[0])) continue;
    if (ADD_VERB_RE.test(hit.verb)) {
      caps.add('__ADD__');
      continue;
    }
    for (const cap of CAPABILITY_PICK_ORDER) {
      const patterns = CAP_INTENT_PATTERNS[cap];
      if (patterns && patterns.some((re) => new RegExp(re.source).test(hit.verb))) {
        caps.add(cap);
      }
    }
  }
  if (caps.has('__ADD__')) {
    caps.delete('__ADD__');
    // Direct-verb evidence must survive part-add recomputation: the ADD
    // branch below recomputes CREATE/UPDATE from add-verb context, but an
    // explicit "create a new page" (CREATE verb) or "update the old report"
    // (UPDATE verb) elsewhere in the text is independent evidence. Without
    // this, "create a new page called X. Put content in the page" collapses
    // to UPDATE-only: the add-verb ('put … in the page') + part noun
    // ('content') wipes the explicit CREATE, and downstream the request is
    // planned as update-an-existing-target (asking for parent/page IDs for
    // a page that does not exist yet). Descriptive past-tense uses ("the
    // page you created earlier") never reach here — the predecessor filter
    // above already drops them.
    const hadExplicitCreate = caps.has('CREATE');
    const hadDirectUpdate = caps.has('UPDATE');
    // CREATE a whole new object ("add a new page") vs UPDATE an existing one
    // ("add a section to the page" / "add a section" / "add a checklist").
    const tokens = lowered.match(/[a-z][a-z0-9]{2,}/g) || [];
    const hasPart = tokens.some((t) => PART_ENTITIES.has(t));
    const hasNewWhole = WHOLE_NEW_RE.test(lowered);
    const addsToExisting = !hasNewWhole && (hasPart || ADD_TARGET_RE.test(lowered));
    caps.delete('CREATE');
    caps.delete('UPDATE');
    caps.add(addsToExisting ? 'UPDATE' : 'CREATE');
    if (hadExplicitCreate) caps.add('CREATE');
    if (hadDirectUpdate) caps.add('UPDATE');
  }
  // Explicit do-not-modify suppression (mirrors the negated-create rule):
  // "Do not modify existing pages. Create only this new test page" is a
  // CREATE-only request — a part-add elsewhere in the text ("put content
  // in the page", scoped to the page being created) must not re-add UPDATE
  // and divert planning toward existing-target resolution. Narrowly scoped
  // to modification verbs with an existing/other qualifier so ordinary
  // "don't update the title, update the body" requests are untouched.
  if (NEGATED_MODIFY_RE.test(lowered)) caps.delete('UPDATE');
  return caps;
}

// Which capabilities does an MCP schema declare? Generic MCP metadata only:
// wire name + description prose + argument (parameter) names + MCP
// annotations when the server exposes them. No vendor/tool-name knowledge.
//
// Two hygiene rules keep long real-world descriptions honest:
//   - backtick-quoted spans are code/field references (`truncated`,
//     `update_data_source`), not capability claims, and are stripped before
//     matching — otherwise every tool that MENTIONS another tool declares
//     that tool's capability;
//   - `readOnlyHint: true` (MCP spec) declares READ and strips mutating
//     capabilities a read-only tool can never perform. `destructiveHint` is
//     deliberately NOT a DELETE declaration: servers mark even search/query
//     tools destructive (non-GET transport), so it cannot identify deletion.
const READONLY_STRIP_CAPS = new Set(['CREATE', 'UPDATE', 'DELETE', 'SEND', 'UPLOAD']);

const stripCodeSpans = (text) => String(text || '').replace(/`[^`]*`/g, ' ');

const readMcpAnnotations = (schema) => {
  try {
    const direct = schema?.function?.annotations;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
    const sidecar = schema?.mcpMetadata?.annotations;
    if (sidecar && typeof sidecar === 'object' && !Array.isArray(sidecar)) return sidecar;
    for (const key of ['annotations', 'mcpAnnotations']) {
      const cand = schema?.[key];
      if (cand && typeof cand === 'object' && !Array.isArray(cand)) return cand;
    }
  } catch {
    // Declaration must never throw on odd shapes.
  }
  return null;
};

// Argument/schema semantics: property names (recursively, depth-limited)
// are purpose evidence ("content", "page_id"). Free-prose property
// descriptions are excluded — they reintroduce the incidental-mention
// problem code-span stripping just removed.
const collectParamHay = (schema) => {
  const parts = [];
  try {
    const params = schema?.function?.parameters;
    if (!params || typeof params !== 'object') return '';
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 3 || seen.has(node)) return;
      seen.add(node);
      const props = node.properties;
      if (props && typeof props === 'object') {
        const keys = Object.keys(props);
        if (keys.length > 64) return;
        for (const k of keys) {
          if (typeof k === 'string' && k) parts.push(k);
          walk(props[k], depth + 1);
        }
      }
      if (Array.isArray(node.required)) {
        for (const r of node.required) if (typeof r === 'string' && r) parts.push(r);
      }
      if (node.items && typeof node.items === 'object') walk(node.items, depth + 1);
    };
    walk(params, 0);
  } catch {
    // Declaration must never throw on odd shapes.
  }
  return parts.join(' ').toLowerCase();
};

function declareToolCapabilities(schema) {
  // Separators are not word characters for \b (snake_case `x_update` hides
  // "update" from `\bupdat`), so names are space-normalized first. Real wire
  // names mix `-` and `_`; without this, name-declared capabilities silently
  // vanish depending on which separator a server chose.
  const name = String(schema?.function?.name || '').toLowerCase().replace(/[_-]+/g, ' ');
  const desc = stripCodeSpans(String(schema?.function?.description || '')).toLowerCase();
  const hay = `${name} ${desc} ${collectParamHay(schema)}`;
  const caps = new Set();
  for (const cap of CAPABILITY_PICK_ORDER) {
    const patterns = CAP_TOOL_PATTERNS[cap];
    if (patterns.some((re) => re.test(hay)) || (cap === 'UPDATE' && ADD_VERB_RE.test(hay))) {
      caps.add(cap);
    }
  }
  const ann = readMcpAnnotations(schema);
  if (ann) {
    if (ann.readOnlyHint === true) {
      caps.add('READ');
      for (const c of READONLY_STRIP_CAPS) caps.delete(c);
    }
  }
  return caps;
}

// Token-exact domain matching (stemmed plurals): query token "section" must
// match a real word in the candidate, not a substring of another word.
// Substring matching picked create-comment for "add a section" ("section" ⊂
// "selection") and update-data-source for "current state" ("state" ⊂
// "statements"). Names/descriptions tokenize on non-alphanumerics, so
// snake_case wire names still match their segments.
const stemEntityToken = (t) => (
  t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t
);

const tokenSetOf = (text) => {
  const set = new Set();
  for (const t of String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    set.add(stemEntityToken(t));
  }
  return set;
};

const tokenFreqOf = (text) => {
  const freq = new Map();
  for (const t of String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    const s = stemEntityToken(t);
    freq.set(s, (freq.get(s) || 0) + 1);
  }
  return freq;
};

// Shared-domain evidence: stemmed query TOKENS that are not capability verbs
// / stop-words and that appear as whole words in the candidate's name or
// description. This is the anti-substitution guard — a candidate with zero
// domain overlap with the request is never added by capability alone (unless
// the nameCap fallback below applies).
function sharedEntityCount(candidate, entityTokens) {
  if (!entityTokens || !entityTokens.length) return 0;
  const set = candidate.tokenSet || tokenSetOf(`${candidate.nameLower || ''} ${candidate.descLower || ''}`);
  let shared = 0;
  for (const tok of entityTokens) {
    if (set.has(stemEntityToken(String(tok).toLowerCase()))) shared += 1;
  }
  return shared;
}

const collectEntityTokens = (text) => {
  const lowered = normalizeText(text);
  const tokens = (lowered.match(/[a-z][a-z0-9]{2,}/g) || [])
    .filter((t) => !MCP_STOPWORDS.has(t) && t !== 'mcp' && t !== 'tool' && t !== 'server' && t !== 'new');
  const capVerbs = new Set();
  for (const list of Object.values(CAP_INTENT_PATTERNS)) {
    for (const re of list) {
      for (const t of tokens) if (re.test(t) || ADD_VERB_RE.test(t)) capVerbs.add(t);
    }
  }
  // Adjectival verbs stay domain evidence: "shared pages", "saved notes" —
  // the verb directly classifies the noun it touches. Adjacency is judged on
  // the RAW word stream (articles intact): "shared pages" keeps "shared",
  // but "add a section" drops "add" (the article intervenes — "add" is the
  // action, not a classifier) and "created earlier" drops "created" (an
  // adverb follows, not the classified noun). Without this, DDL "ADD
  // COLUMN" would match user "add", and prose "created" would match "the
  // page you created earlier".
  const NON_NOUN_FOLLOWERS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'your',
    'its', 'their', 'it', 'them', 'me', 'you', 'him', 'her', 'us',
    'earlier', 'later', 'before', 'after', 'now', 'today', 'yesterday',
    'again', 'already', 'just', 'soon', 'recently', 'currently', 'always',
    'never', 'not', 'here', 'there', 'away', 'back', 'over', 'new'
  ]);
  const isNounLike = (t) => t
    && !MCP_STOPWORDS.has(t)
    && !NON_NOUN_FOLLOWERS.has(t)
    && ![...Object.values(CAP_INTENT_PATTERNS).flat(), ADD_VERB_RE].some((re) => re.test(t));
  // Raw stream positions of each kept token (first occurrence).
  const rawWords = lowered.match(/[a-z0-9']+/g) || [];
  const keep = new Set();
  const usedIndex = new Map();
  for (const t of tokens) {
    if (!capVerbs.has(t) || keep.has(t)) continue;
    let from = usedIndex.get(t) || 0;
    let idx = rawWords.indexOf(t, from);
    while (idx !== -1) {
      const next = rawWords[idx + 1];
      usedIndex.set(t, idx + 1);
      if (next && isNounLike(next)) {
        // Direct classifier only when nothing intervenes: the raw words
        // between must be empty, i.e. next raw word IS the token-stream
        // neighbor. (Articles/pronouns/adverbs in between disqualify.)
        keep.add(t);
        break;
      }
      if (next && (MCP_STOPWORDS.has(next) || NON_NOUN_FOLLOWERS.has(next))) break;
      idx = rawWords.indexOf(t, idx + 1);
    }
  }
  return [...new Set(tokens.filter((t) => !capVerbs.has(t) || keep.has(t)))];
};

// Pure: which capability groups does this request match?
function matchGroups(text) {
  const lowered = normalizeText(text);
  const matched = [];
  for (const group of GROUP_PRIORITY) {
    const patterns = GROUP_PATTERNS[group] || [];
    if (patterns.some((re) => re.test(lowered))) matched.push(group);
  }
  return matched;
}

function detectOutputIntent(text) {
  const lowered = normalizeText(text);
  return EXTENDED_OUTPUT_PATTERNS.some((re) => re.test(lowered)) ? 'extended' : 'default';
}

// Resolve matched groups (or the safe default) to registry schemas.
// getSchemasFn is injected (defaults to the live registry) for testability.
// Unknown names are skipped — the registry is the source of truth, so a
// renamed/removed tool can never break selection or the request.
//
// MCP extension: `options.mcpSchemas` is an array of ARC-shaped schemas whose
// `function.name` is the MCP wire name (mcp_...) and whose description carries
// the tool's purpose. They are keyword-scored against the query and appended
// AFTER native group matches, then the combined list is capped at maxTools.
// A knowledge question ("Explain encapsulation") matches zero MCP tools;
// "create a GitHub issue" scores the GitHub fixture tools. Nothing here knows
// what MCP is — the wire-name prefix and schema shape are all it relies on.
function scoreMcpSchemas(text, mcpSchemas) {
  const lowered = normalizeText(text);
  const tokens = lowered.match(/[a-z][a-z0-9]{2,}/g) || [];
  if (!tokens.length || !Array.isArray(mcpSchemas) || !mcpSchemas.length) return [];

  const scored = [];
  for (const schema of mcpSchemas) {
    const name = schema?.function?.name || '';
    const desc = schema?.function?.description || '';
    let score = 0;
    const nameLower = name.toLowerCase();
    const descLower = desc.toLowerCase();
    // Name token hits are strong signals ("github", "create", "issue").
    for (const tok of tokens) {
      if (nameLower.includes(tok)) score += 3;
      else if (descLower.includes(tok)) score += 1;
    }
    if (!name && !desc) score = 0;
    if (score > 0) {
      scored.push({ schema, score, name });
    }
  }
  // Deterministic: score desc, then lexicographic tie-break.
  scored.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return scored.map((s) => s.schema);
}

// Policy-aware MCP selection (no-substitution rule).
//
// When the request's evidence points at a tool the policy removed (blocked
// list), offering the remaining tools invites the model to SUBSTITUTE an
// unrelated tool and present its result as the answer ("Fixed test value:
// done=true" from delayed_tool). Instead, suppress ALL MCP offers for this
// request so the model responds naturally that the capability is
// unavailable. Generic: no tool names, no capabilities hardcoded here.
//
// `exposed` = policy-permitted schemas for the model; `blocked` =
// policy-removed schemas, server-side only (never attached to a request).
// Suppression triggers only when the blocked side strictly outscores the
// exposed side — mixed requests naming an allowed tool still work.
// Closed-class English tokens carry no tool evidence ("the" also
// substring-matches "weather"). Standard IR stopwords, not tool knowledge.
const MCP_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has',
  'are', 'was', 'were', 'will', 'would', 'should', 'could', 'there',
  'their', 'about', 'into', 'your', 'yours', 'what', 'when', 'where',
  'which', 'who', 'whom', 'how', 'why', 'not', 'but', 'all', 'any',
  'can', 'just', 'like', 'more', 'most', 'other', 'some', 'such',
  'than', 'then', 'too', 'very', 'does', 'did', 'use', 'using', 'used',
  'please', 'tool', 'tools'
]);

// Minimum evidence for offering a tool: a single distinctive name hit
// (3·ln(N) for a unique token) clears it; a single shared/generic hit does
// not. Calibrated so "echo … echo" (repeated unique token) and "what is the
// weather" (unique token) select, while incidental one-token overlap
// ("tool", "get") never offers a substitute on its own.
const MCP_MIN_SCORE = 5;

const toMcpCandidate = (schema) => {
  const nameLower = (schema?.function?.name || '').toLowerCase();
  // Code spans stripped here too: `update_data_source` references must not
  // count as domain evidence for "update"/"data"/"source".
  const descStripped = stripCodeSpans(schema?.function?.description || '').toLowerCase();
  return {
    schema,
    name: schema?.function?.name || '',
    nameLower,
    descLower: (schema?.function?.description || '').toLowerCase(),
    tokenSet: tokenSetOf(`${nameLower} ${descStripped}`),
    tokenFreq: tokenFreqOf(descStripped),
    nameTokenSet: tokenSetOf(nameLower),
    // MCP destructive hint (spec-shaped, server-supplied). Used ONLY as
    // pick-eligibility for DELETE: servers mark even search tools
    // destructive, so it never declares deletion by itself.
    destructive: readMcpAnnotations(schema)?.destructiveHint === true,
    caps: declareToolCapabilities(schema)
  };
};

// Evidence rarity is measured over the FULL discovered set (exposed AND
// blocked): a token naming a blocked tool is just as distinctive when the
// tool is removed, and per-subset frequencies would collapse (a lone
// blocked candidate makes every token "ubiquitous").
const mcpTokenDf = (tokens, candidates) => {
  const df = new Map();
  for (const tok of new Set(tokens)) {
    let count = 0;
    for (const c of candidates) {
      if (c.nameLower.includes(tok) || c.descLower.includes(tok)) count += 1;
    }
    df.set(tok, count);
  }
  return df;
};

const scoreMcpCandidate = (c, tokens, df, N) => {
  let score = 0;
  for (const tok of tokens) {
    const tokDf = df.get(tok) || 0;
    // Ubiquitous (namespace boilerplate) and absent tokens carry nothing.
    if (tokDf === 0 || tokDf >= N) continue;
    const idf = Math.log(N / tokDf);
    if (c.nameLower.includes(tok)) score += 3 * idf;
    else if (c.descLower.includes(tok)) score += idf;
  }
  return score;
};

function scoreMcpSchemasDetailed(text, mcpSchemas) {
  const lowered = normalizeText(text);
  const tokens = (lowered.match(/[a-z][a-z0-9]{2,}/g) || []).filter((t) => !MCP_STOPWORDS.has(t));
  if (!tokens.length || !Array.isArray(mcpSchemas) || !mcpSchemas.length) return [];
  const candidates = mcpSchemas.map(toMcpCandidate);
  const N = candidates.length;
  const df = mcpTokenDf(tokens, candidates);
  const scored = [];
  for (const c of candidates) {
    const score = scoreMcpCandidate(c, tokens, df, N);
    if ((!c.name && !c.descLower) || score < MCP_MIN_SCORE) continue;
    scored.push({ schema: c.schema, score, name: c.name });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return scored;
}

// Explicit MCP tool-name protection (production 400 fix).
//
// Scoring is best-effort: an explicitly named, policy-permitted MCP tool can
// still be omitted (6-slot cap filled by natives, IDF threshold miss on
// follow-up turns like "do it again", budget trim dropping MCP first). The
// model then emits a tool call for the user-named tool anyway and Groq
// rejects the request: "Tool call validation failed ... not in
// request.tools". An explicitly requested valid tool must therefore survive
// selection deterministically.
//
// Matching is separator/case-insensitive: the query and each candidate
// identity are folded to bare alphanumerics, so all of these name the same
// tool: `mcp_mcp_reference_annotatedMessage`, pasted with any separators or
// casing, and the bare original name `annotatedMessage` / "annotated
// message". Two match tiers:
//   1. full wire identity (always namespaced `mcp_<slug>_<tool>`, min 8
//      folded chars) — distinctive, always honored;
//   2. bare original tool name — only when the folded name is >= 8 chars,
//      so short everyday words ("echo", "read") can never force-include.
// Candidates come ONLY from the policy-permitted exposed set: a denied or
// allowlisted-out tool is never in `exposed`, so deny-wins is preserved and
// an explicitly named blocked tool stays excluded (no-substitution rule
// still applies to the scored remainder).
const MCP_EXPLICIT_MIN_WIRE_CHARS = 8;
const MCP_EXPLICIT_MIN_BARE_CHARS = 8;

const foldMcpIdentity = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function matchExplicitMcpSchemas(text, exposed = []) {
  const foldedText = foldMcpIdentity(text);
  if (!foldedText || !Array.isArray(exposed) || !exposed.length) return [];
  const matched = [];
  for (const schema of exposed) {
    const wire = schema?.function?.name || '';
    const foldedWire = foldMcpIdentity(wire);
    if (foldedWire.length >= MCP_EXPLICIT_MIN_WIRE_CHARS && foldedText.includes(foldedWire)) {
      matched.push(schema);
      continue;
    }
    // Bare original tool name: the slug boundary is unknowable here (slugs
    // themselves contain underscores, e.g. `mcp_reference`), so every
    // `_`-separated suffix of the post-`mcp_` remainder is tried longest-
    // first. Length-gated so short everyday words ("echo") never match.
    const rest = wire.replace(/^mcp_/i, '');
    const parts = rest.split('_').filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const foldedBare = foldMcpIdentity(parts.slice(i).join(''));
      if (foldedBare.length < MCP_EXPLICIT_MIN_BARE_CHARS) continue;
      if (foldedText.includes(foldedBare)) {
        matched.push(schema);
        break;
      }
    }
  }
  return matched;
}

function selectMcpSchemasWithPolicy(text, exposed = [], blocked = []) {
  const lowered = normalizeText(text);
  const tokens = (lowered.match(/[a-z][a-z0-9]{2,}/g) || []).filter((t) => !MCP_STOPWORDS.has(t));
  const exposedCands = (Array.isArray(exposed) ? exposed : []).map(toMcpCandidate);
  const blockedCands = (Array.isArray(blocked) ? blocked : []).map(toMcpCandidate);
  if (!tokens.length || exposedCands.length === 0) {
    return { schemas: [], suppressed: false, blockedNames: [], mcpMatched: 0, capabilityNames: [] };
  }
  const intentCaps = classifyIntentCapabilities(text);
  const entityTokens = collectEntityTokens(text);
  const combined = [...exposedCands, ...blockedCands];
  const N = combined.length;
  const df = mcpTokenDf(tokens, combined);
  // scoreAll applies the SAME capability top-up to exposed and blocked sides,
  // so suppression comparisons stay symmetric.
  const scoreAll = (cands) => cands
    .map((c) => {
      const score = scoreMcpCandidate(c, tokens, df, N);
      return {
        schema: c.schema,
        score,
        shared: sharedEntityCount(c, entityTokens),
        name: c.name,
        caps: c.caps
      };
    })
    .filter((s) => s.name && s.score >= MCP_MIN_SCORE)
    .sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const exposedScored = scoreAll(exposedCands);
  const blockedScored = scoreAll(blockedCands);
  const bestExposed = exposedScored.length ? exposedScored[0].score : 0;
  const bestBlocked = blockedScored.length ? blockedScored[0].score : 0;
  if (bestBlocked > 0 && bestBlocked > bestExposed) {
    return {
      schemas: [],
      suppressed: true,
      blockedNames: blockedScored.map((s) => s.name),
      mcpMatched: 0,
      capabilityNames: []
    };
  }
  // Capability-driven picks: for every requested capability, offer ONE exposed
  // tool that declares it AND shares domain evidence with the request (or
  // already scores lexically). Candidates span all exposed tools — a scored
  // tool (update-page, fetch) must be eligible, otherwise the top action tool
  // for a capability can be crowd-out by unscored noise. Defaults already
  // cover the no-substitution rule: candidates come only from the
  // policy-permitted exposed set and picks are suppressed with the whole
  // request when policy blocks it.
  const scoredByName = new Map(exposedScored.map((s) => [s.name, s]));
  const picked = new Set();
  const capabilityPicks = [];
  // Add-part requests ("add a section") want content-bearing tools, not any
  // tool that can "update" something (reparent a page, edit a view schema).
  // PART_ENTITIES is intent vocabulary, not vendor knowledge; reused here
  // symmetrically to prefer candidates that mention part nouns.
  const queryTokens = lowered.match(/[a-z][a-z0-9]{2,}/g) || [];
  const addPartBoost = intentCaps.has('UPDATE')
    && ADD_VERB_RE.test(lowered)
    && !WHOLE_NEW_RE.test(lowered)
    && queryTokens.some((t) => PART_ENTITIES.has(t));
  const partStems = new Set([...PART_ENTITIES].map((t) => stemEntityToken(t)));
  for (const cap of CAPABILITY_PICK_ORDER) {
    if (!intentCaps.has(cap)) continue;
    const candidates = exposedCands
      .filter((c) => c.caps.has(cap) && !picked.has(c.name))
      .map((c) => {
        const sc = scoredByName.get(c.name);
        // A capability declared by the tool NAME (update-page, create-pages,
        // fetch) is primary-purpose evidence; a declaration that only appears
        // in the description (search-skills' "…rename a skill…") is incidental.
        // Names are space-normalized: \b cannot see through snake_case.
        const nameCap = CAP_TOOL_PATTERNS[cap].some((re) => re.test(c.nameLower.replace(/[_-]+/g, ' ')));
        // Entity-token FREQUENCY over whole words, not substrings: a page
        // tool is saturated with the word "page", while a user-listing tool
        // mentions it only inside generic examples. Token-exact (stemmed)
        // so "section" never matches "selection" nor "state" "statements".
        // Name hits count once; every description occurrence counts.
        let entityHits = 0;
        for (const tok of entityTokens) {
          const stemmed = stemEntityToken(String(tok).toLowerCase());
          if (c.nameTokenSet && c.nameTokenSet.has(stemmed)) entityHits += 1;
          entityHits += (c.tokenFreq && c.tokenFreq.get(stemmed)) || 0;
        }
        let partHits = 0;
        if (addPartBoost && c.tokenSet) {
          for (const p of partStems) if (c.tokenSet.has(p)) partHits += 1;
        }
        // Whole-word lexical overlap over DOMAIN tokens only (capability
        // verbs excluded): the IDF `score` below is substring-based, so
        // "state" matches "statements" and DDL "ADD COLUMN" matches user
        // "add" — both boost the wrong tool. Exact overlap keeps ranking
        // honest when domain evidence is otherwise tied.
        let exactScore = 0;
        for (const tok of entityTokens) {
          const stemmed = stemEntityToken(String(tok).toLowerCase());
          if (c.nameTokenSet && c.nameTokenSet.has(stemmed)) exactScore += 3;
          exactScore += (c.tokenFreq && c.tokenFreq.get(stemmed)) || 0;
        }
        return {
          cand: c,
          nameCap: nameCap ? 1 : 0,
          entityHits,
          partHits,
          exactScore,
          score: sc ? sc.score : 0,
          shared: sharedEntityCount(c, entityTokens)
        };
      })
      .sort((a, b) =>
        (b.nameCap - a.nameCap) ||
        (b.entityHits - a.entityHits) ||
        (b.partHits - a.partHits) ||
        (b.exactScore - a.exactScore) ||
        (a.cand.caps.size - b.cand.caps.size) ||
        (a.cand.name < b.cand.name ? -1 : a.cand.name > b.cand.name ? 1 : 0)
      );
    const pickedBefore = picked.size;
    for (const cand of candidates) {
      // Destructive capabilities need primary-purpose evidence: a DELETE
      // declaration from description prose alone ("are deleted once they
      // expire", "remove all filters") must never surface a tool that
      // cannot delete user content. Require a name-declared verb or a
      // server-supplied destructive hint.
      if (cap === 'DELETE' && !cand.nameCap && !cand.cand.destructive) continue;
      // Name-declared capability (update-page for UPDATE) is primary-purpose
      // evidence that needs no domain overlap: short follow-ups ("add a
      // section to it") carry no domain noun at all.
      if (cand.shared < 1 && cand.score < MCP_MIN_SCORE && !cand.nameCap) continue;
      picked.add(cand.cand.name);
      capabilityPicks.push(cand.cand.schema);
      break;
    }
    if (picked.size > pickedBefore) continue;
    // Fallback: a short follow-up ("add a section to it") carries no domain
    // noun, so nothing passes the shared-evidence gate. A tool whose NAME
    // declares the capability (update-page for UPDATE) is primary-purpose
    // evidence with no domain confusion — prefer the most specific such
    // tool (fewest declared capabilities). Never fires when a domain match
    // exists, and never from description-only declarations.
    const fallback = candidates.filter((cand) => cand.nameCap > 0)
      .sort((a, b) =>
        (b.exactScore - a.exactScore) ||
        (a.cand.caps.size - b.cand.caps.size) ||
        (a.cand.name < b.cand.name ? -1 : a.cand.name > b.cand.name ? 1 : 0)
      )[0];
    if (fallback) {
      picked.add(fallback.cand.name);
      capabilityPicks.push(fallback.cand.schema);
    }
  }
  return {
    schemas: [...capabilityPicks, ...exposedScored.map((s) => s.schema)],
    suppressed: false,
    blockedNames: [],
    mcpMatched: exposedScored.length,
    capabilityNames: capabilityPicks.map((s) => s?.function?.name).filter(Boolean)
  };
}

function selectToolSchemas(text, getSchemasFn = null, options = {}) {
  const maxTools = Math.max(0, Number(options.maxTools ?? MAX_TOOLS_PER_REQUEST));
  const matched = matchGroups(text);
  const groups = matched.length > 0 ? matched : [...DEFAULT_GROUPS];
  let schemas = [];
  try {
    schemas = typeof getSchemasFn === 'function' ? getSchemasFn() : [];
  } catch {
    schemas = [];
  }
  const byName = new Map();
  for (const s of schemas) {
    const name = s?.function?.name;
    if (name) byName.set(name, s);
  }
  const ordered = [];
  // Explicitly named, policy-permitted MCP tools take the first slots: the
  // user asked for that exact tool, so it outranks heuristic group matches
  // and can never be crowded out by the cap (the production 400).
  const explicitMcp = matchExplicitMcpSchemas(text, options.mcpSchemas);
  for (const schema of explicitMcp) {
    if (ordered.length >= maxTools) break;
    if (!ordered.includes(schema)) ordered.push(schema);
  }
  for (const group of groups) {
    for (const name of CAPABILITY_GROUPS[group] || []) {
      if (ordered.length >= maxTools) break;
      const schema = byName.get(name);
      if (schema && !ordered.includes(schema)) ordered.push(schema);
    }
  }
  // Scored MCP tools fill remaining slots — unless the request targets a
  // policy-blocked capability, in which case none are offered
  // (no-substitution rule; see above). Explicit matches above are unaffected
  // by suppression: offering a user-named allowed tool is never substitution.
  const mcpPick = selectMcpSchemasWithPolicy(text, options.mcpSchemas, options.mcpBlocked);
  for (const schema of mcpPick.schemas) {
    if (ordered.length >= maxTools) break;
    if (!ordered.includes(schema)) ordered.push(schema);
  }
  const selected = ordered.slice(0, maxTools);
  return {
    tools: selected,
    groups,
    matchedGroups: matched,
    defaulted: matched.length === 0,
    totalAvailable: schemas.length,
    mcpAvailable: Array.isArray(options.mcpSchemas) ? options.mcpSchemas.length : 0,
    mcpMatched: mcpPick.mcpMatched,
    mcpSuppressed: mcpPick.suppressed,
    mcpBlockedNames: mcpPick.blockedNames,
    mcpExplicit: explicitMcp.map((s) => s?.function?.name).filter(Boolean),
    mcpCapability: Array.isArray(mcpPick.capabilityNames) ? mcpPick.capabilityNames : []
  };
}

// Names referenced by an assistant tool_calls block (provider shape).
function activeToolNamesFromCalls(toolCalls) {
  const names = [];
  for (const tc of toolCalls || []) {
    const name = tc?.function?.name || tc?.name;
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Hard invariant: every tool call the model emitted must name a tool present
// in the exact request.tools set supplied to the provider. Groq enforces
// this server-side ("Tool call validation failed ... not in request.tools");
// this helper lets request builders check it client-side before sending.
// Returns { exposedCalls, unexposedNames } — pure, never throws.
function partitionToolCallsByExposure(toolCalls, tools) {
  const offered = new Set();
  for (const schema of tools || []) {
    const name = schema?.function?.name;
    if (typeof name === 'string' && name) offered.add(name);
  }
  const exposedCalls = [];
  const unexposedNames = [];
  for (const tc of toolCalls || []) {
    const name = tc?.function?.name || tc?.name;
    if (typeof name === 'string' && name && offered.has(name)) {
      exposedCalls.push(tc);
    } else if (typeof name === 'string' && name && !unexposedNames.includes(name)) {
      unexposedNames.push(name);
    }
  }
  return { exposedCalls, unexposedNames };
}

// TOOL-CONTINUATION turn (NOT a new intent classification event).
// The continuation belongs to the same tool-use transaction, so the tools
// referenced by the active tool calls are MANDATORY: dropping them produces
// `tools=[]` alongside `assistant.tool_calls`, which providers reject
// ("tool choice is none, but model called a tool"). Previously selected
// tools fill the remainder up to the cap. Unknown names are skipped — the
// registry is the source of truth, so a renamed tool can never break the
// request. Schemas are passed through untouched, never edited.
//
// MCP addition (production 400 fix): `options.mcpSchemas` carries the
// policy-permitted MCP schemas for this request. The native registry lookup
// alone cannot resolve an active `mcp_...` tool that was absent from the
// previous tool set (scoring miss, cap crowd-out, budget trim), which left
// continuation messages referencing a tool missing from continuation tools.
// Exposed-only lookup preserves deny-wins: a denied tool is absent from
// `mcpSchemas`, so it stays unresolvable here exactly as in selection.
function selectContinuationTools(previousTools, activeNames, getSchemasFn = null, options = {}) {
  const maxTools = Math.max(0, Number(options.maxTools ?? MAX_TOOLS_PER_REQUEST));
  const prev = Array.isArray(previousTools) ? previousTools : [];
  let registry = [];
  try {
    registry = typeof getSchemasFn === 'function' ? getSchemasFn() : [];
  } catch {
    registry = [];
  }
  const mcpSchemas = Array.isArray(options.mcpSchemas) ? options.mcpSchemas : [];
  const byName = new Map();
  for (const s of [...prev, ...mcpSchemas, ...(Array.isArray(registry) ? registry : [])]) {
    const name = s?.function?.name;
    if (typeof name === 'string' && name && !byName.has(name)) byName.set(name, s);
  }
  const mandatory = [];
  for (const name of activeNames || []) {
    const schema = byName.get(name);
    if (schema && !mandatory.includes(schema)) mandatory.push(schema);
  }
  const ordered = [...mandatory];
  for (const s of prev) {
    if (ordered.length >= Math.max(mandatory.length, maxTools)) break;
    if (!ordered.includes(s)) ordered.push(s);
  }
  return {
    tools: ordered,
    activeNames: Array.isArray(activeNames) ? [...activeNames] : [],
    mandatoryCount: mandatory.length
  };
}

module.exports = {
  MAX_TOOLS_PER_REQUEST,
  CAPABILITY_GROUPS,
  GROUP_PRIORITY,
  DEFAULT_GROUPS,
  CAPABILITY_PICK_ORDER,
  classifyIntentCapabilities,
  declareToolCapabilities,
  matchGroups,
  detectOutputIntent,
  scoreMcpSchemas,
  scoreMcpSchemasDetailed,
  selectMcpSchemasWithPolicy,
  matchExplicitMcpSchemas,
  partitionToolCallsByExposure,
  selectToolSchemas,
  activeToolNamesFromCalls,
  selectContinuationTools
};
