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
  'CREATE', 'UPDATE', 'DELETE', 'SEND', 'COMMENT', 'UPLOAD', 'DOWNLOAD',
  'EXECUTE', 'MOVE', 'DUPLICATE', 'ARCHIVE', 'RESTORE',
  'SEARCH', 'READ', 'LIST'
];

// Tool-declaration side: capability keywords over wire name + description +
// parameter names. `remove` is DELETE (never UPDATE: `\bmov\w*` cannot match
// inside `remove` because there is no word boundary before "mov").
const CAP_TOOL_PATTERNS = {
  READ: [/\b(read\w*|get\b|fetch\w*|retriev\w*|view\w*|open\w*|load\w*|display\w*|show\w*|see\w*|preview\w*)\b/],
  SEARCH: [/\b(search\w*|find\w*|lookup\w*|look\s+up\b|query\w*)\b/],
  LIST: [/\b(list\w*|enumerat\w*)\b/],
  // Mutation verbs (save/upsert/persist/apply/put) declare BOTH create and
  // update: many servers expose one mutation tool whose description/schema
  // says it creates or updates the target entity. Intent derives from the
  // same families, so "save the report" requests both capabilities and the
  // entity gate below picks the entity-correct tool.
  CREATE: [/\b(creat\w*|generat\w*|build\w*|insert\w*|compos\w*|sav\w*|upsert\w*|persist\w*|appl\w*|put\b)\b/],
  UPDATE: [/\b(updat\w*|edit\w*|modify\w*|chang\w*|alter\w*|renam\w*|mov\w*|set\b|append\w*|replac\w*|adjust\w*|revise\w*|toggl\w*|patch\w*|complet\w*|finish\w*|close\w*|resolve\w*|reopen\w*|sav\w*|upsert\w*|persist\w*|appl\w*|put\b)\b/, /\bmark\w*[^.!?]{0,20}\b(complet\w*|done|closed|resolved|archived)\b/],
  DELETE: [/\b(delet\w*|remov\w*|erase\w*|wipe\w*|destroy\w*|truncat\w*|trash\w*|archiv\w*|discard\w*)\b/],
  SEND: [/\b(send\w*|post\b|publish\w*|notify\w*|deliver\w*|email\w*|share\w*|messag\w*|forward\w*|reply\w*|sms\b)\b/],
  COMMENT: [/\b(comment\w*|annotat\w*)\b/],
  UPLOAD: [/\b(upload\w*|attach\w*)\b/],
  DOWNLOAD: [/\b(download\w*|export\w*)\b/],
  EXECUTE: [/\b(execut\w*|run\w*|invoke\w*|trigger\w*|start\b|launch\w*|apply\w*|process\w*|compile\w*)\b/],
  MOVE: [/\b(mov\w*|transfer\w*|relocat\w*|reparent\w*|migrat\w*)\b/],
  DUPLICATE: [/\b(duplicat\w*|clon\w*|cop(y|ies|ied)\b)\b/],
  ARCHIVE: [/\b(archiv\w*)\b/],
  RESTORE: [/\b(restor\w*|unarchiv\w*|untrash\w*|recover\w*|reopen\w*)\b/]
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
  // Past-interrogative suppression (generic English, no entity knowledge):
  // "what did you just change?", "what have you created today?" ask about
  // HISTORY, they do not request an action. Action capabilities classified
  // from the past-tense verb ("change", "created") must not mark tools
  // REQUIRED_FOR_EXECUTION — the answer comes from recent turns and working
  // state, and executing a mutation for a history question would be wrong.
  // Lookup caps (READ/SEARCH/LIST) survive: "what did you find?" may still
  // search. Narrowly scoped to what/which + did/have/has + you.
  const pastInterrogative = /\b(what|which)\s+(did|have|has)\s+you\b/.test(lowered);
  // Inventory-question fallback (generic English, no entity knowledge):
  // "what teams do I have", "which projects are mine", "what is available"
  // carry no capability verb, so the capability layer would offer nothing
  // and the request would live or die on lexical IDF alone. An inventory
  // interrogative is always a LIST + READ request. Skipped for
  // past-interrogatives ("what have you created" is history, not inventory).
  if (!pastInterrogative && !caps.has('LIST') && !caps.has('READ') && !caps.has('SEARCH')) {
    if (
      /\b(what|which)\b[^.!?]{0,80}\b(have|has|do\s+i|are\s+there|exist|available|mine|my)\b/.test(lowered)
      || /\b(show|display)\b[^.!?]{0,40}\b(my|all|available|every)\b/.test(lowered)
    ) {
      caps.add('LIST');
      caps.add('READ');
    }
  }
  if (pastInterrogative) {
    for (const c of ['CREATE', 'UPDATE', 'DELETE', 'SEND', 'COMMENT', 'UPLOAD', 'DOWNLOAD', 'EXECUTE', 'MOVE', 'DUPLICATE', 'ARCHIVE', 'RESTORE']) {
      caps.delete(c);
    }
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
const READONLY_STRIP_CAPS = new Set(['CREATE', 'UPDATE', 'DELETE', 'SEND', 'COMMENT', 'UPLOAD', 'MOVE', 'DUPLICATE', 'ARCHIVE', 'RESTORE']);

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

// Generic nouns carry no domain evidence ("list the data", "get that item").
// Letting them count as entity overlap invites unrelated-tool substitution.
// Exactly the spec's closed list (plus plurals) — nothing broader, so real
// domain nouns like "thing" in "delete the old thing" still count.
const GENERIC_DOMAIN_NOUNS = new Set([
  'list', 'lists', 'get', 'gets', 'view', 'views', 'query', 'queries',
  'data', 'item', 'items', 'object', 'objects'
]);

const collectEntityTokens = (text) => {
  const lowered = normalizeText(text);
  const tokens = (lowered.match(/[a-z][a-z0-9]{2,}/g) || [])
    .filter((t) => !MCP_STOPWORDS.has(t) && !GENERIC_DOMAIN_NOUNS.has(t) && t !== 'mcp' && t !== 'tool' && t !== 'server' && t !== 'new');
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
// NOTE (§30 legacy consolidation): the old standalone lexical scorers
// (scoreMcpSchemas / scoreMcpSchemasDetailed — pure substring scoring with
// no operation/entity model) were removed. They had zero production or
// test callers, and an independent lexical path that can select tools
// outside the authoritative semantic gate must not exist. All MCP
// selection flows through selectMcpSchemasWithPolicy → the single
// operation/entity gate below.

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
  'please', 'tool', 'tools', 'now'
]);

// Minimum evidence for offering a tool: a single distinctive name hit
// (3·ln(N) for a unique token) clears it; a single shared/generic hit does
// not. Calibrated so "echo … echo" (repeated unique token) and "what is the
// weather" (unique token) select, while incidental one-token overlap
// ("tool", "get") never offers a substitute on its own.
const MCP_MIN_SCORE = 5;

// Generic action-verb vocabulary for entity extraction (English tool-naming
// conventions, never vendor names): stripped from bare tool names so the
// remaining noun is the tool's target entity (save_issue → issue).
const TOOL_ACTION_VERBS = new Set([
  'save', 'upsert', 'create', 'update', 'edit', 'get', 'fetch', 'list',
  'delete', 'remove', 'trash', 'add', 'insert', 'put', 'post', 'send',
  'duplicate', 'clone', 'move', 'archive', 'restore', 'recover', 'search',
  'find', 'lookup', 'query', 'read', 'view', 'open', 'load', 'show',
  'make', 'new', 'set', 'sync', 'manage'
]);

// Target entity of a tool schema, stemmed (save_issue → "issue").
// Generic: bare tool name minus action verbs. Returns '' when unknown.
const toolEntityStem = (schema) => {
  try {
    const bare = bareToolNameOf(schema).toLowerCase();
    const tokens = bare.split(/[^a-z0-9]+/).filter((t) => t && t.length >= 3);
    const nouns = tokens.filter((t) => !TOOL_ACTION_VERBS.has(t) && t !== 'mcp');
    const pick = nouns.length ? nouns[nouns.length - 1] : '';
    return pick ? stemEntityToken(pick) : '';
  } catch {
    return '';
  }
};

// Server identity of one MCP schema (generic, never vendor names): the
// owning integration's key, used to bind an explicit user mention ("in
// Linear") to that server's tools and to keep resolvers on the caller's
// own server (an id from another integration is never a valid fill).
// Prefers attached metadata (slug, then config name); otherwise decodes
// the deterministic wire prefix. Lowercased; '' when unknowable.
const mcpServerKeyOf = (schemaOrName) => {
  try {
    const schema = typeof schemaOrName === 'string'
      ? { function: { name: schemaOrName } }
      : (schemaOrName || {});
    const meta = schema?.mcpMetadata;
    if (meta && typeof meta.slug === 'string' && meta.slug.trim()) {
      return meta.slug.trim().toLowerCase();
    }
    if (meta && typeof meta.configName === 'string' && meta.configName.trim()) {
      const sluggy = meta.configName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (sluggy) return sluggy;
    }
    const wire = String(schema?.function?.name || '');
    const rest = wire.replace(/^mcp_/i, '');
    const seg = rest.split('_').filter(Boolean)[0] || '';
    return seg.toLowerCase();
  } catch {
    return '';
  }
};

// Words that never identify a server (transport/integration vocabulary +
// the closed generic-noun list): an explicit scope mention must be a
// distinctive token, never "server", "tool", "data", or "my".
const GENERIC_SCOPE_WORDS = new Set([
  'mcp', 'server', 'servers', 'tool', 'tools', 'integration', 'integrations',
  'app', 'apps', 'api', 'my', 'the', 'and', 'for', 'with', 'from', 'that',
  'this', 'have', 'has', 'are', 'was', 'were', 'will', 'would', 'should',
  'could', 'there', 'their', 'about', 'into', 'your', 'yours', 'what',
  'when', 'where', 'which', 'who', 'whom', 'how', 'why', 'not', 'but',
  'all', 'any', 'can', 'just', 'like', 'more', 'most', 'other', 'some',
  'such', 'than', 'then', 'too', 'very', 'does', 'use', 'using', 'used',
  'please'
]);

// Same-integration scope matching (generic, never vendor names): server
// identities fragment across registrations ("linear" vs "linearmcp" vs
// "linear_mcp" — display names, slugs, config names). An explicit user
// mention must reach every tool of that integration family, never just
// the identically-keyed subset — otherwise the mutation can be filtered
// out of the selection pool while same-worded readers survive, and the
// turn degrades to unrelated tools plus a false "no tool" claim.
// Match when folded keys are equal, equal modulo transport-vocabulary
// affixes (`mcp` prefix/suffix), or the mention is contained in the key.
// One-directional (mention ⊂ key) with min length 4, so short words
// ("git", "arc", "liner") can never over-match another integration.
const mcpScopeMatches = (scopeToken, serverKey) => {
  try {
    const fold = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const s = fold(scopeToken);
    const k = fold(serverKey);
    if (!s || !k) return false;
    if (s === k) return true;
    const stripTransport = (v) => v.replace(/^(mcp)+/, '').replace(/(mcp)+$/, '');
    const sTrim = stripTransport(s);
    const kTrim = stripTransport(k);
    if (sTrim && sTrim === kTrim) return true;
    if (sTrim.length >= 4 && kTrim.includes(sTrim)) return true;
    return false;
  } catch { return false; }
};

// Requested MCP server scope from an explicit user mention ("in Linear").
// Matches stemmed query words against every exposed server's identity
// tokens (slug segments + config-name words). Returns the matched server
// keys ([] = user named none → every server stays eligible, existing
// behavior). Generic English + registry metadata only — no vendor names.
const detectMcpServerScope = (text, mcpSchemas) => {
  try {
    const list = Array.isArray(mcpSchemas) ? mcpSchemas : [];
    if (!list.length) return [];
    const queryWords = new Set(
      (String(text || '').toLowerCase().match(/[a-z][a-z0-9]*/g) || [])
        .map((w) => stemEntityToken(w))
    );
    if (!queryWords.size) return [];
    const servers = new Map();
    for (const schema of list) {
      const key = mcpServerKeyOf(schema);
      if (!key) continue;
      if (!servers.has(key)) servers.set(key, new Set());
      const bucket = servers.get(key);
      for (const t of String(key).split(/[^a-z0-9]+/).filter(Boolean)) {
        if (t.length >= 3 && !GENERIC_SCOPE_WORDS.has(t) && !GENERIC_DOMAIN_NOUNS.has(t)) bucket.add(stemEntityToken(t));
      }
      try {
        const cn = schema?.mcpMetadata?.configName;
        for (const t of String(cn || '').toLowerCase().match(/[a-z][a-z0-9]*/g) || []) {
          if (t.length >= 3 && !GENERIC_SCOPE_WORDS.has(t) && !GENERIC_DOMAIN_NOUNS.has(t)) bucket.add(stemEntityToken(t));
        }
      } catch { /* display names are advisory */ }
    }
    const matched = [];
    for (const [key, tokens] of servers) {
      let hit = false;
      for (const t of tokens) {
        for (const q of queryWords) {
          if (mcpScopeMatches(q, t)) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) matched.push(key);
    }
    return matched;
  } catch {
    return [];
  }
};

// Identifier-gated tool (generic schema shape, never vendor names): the
// tool cannot run without a target reference — a required
// identifier-shaped param (issueId, team_id, …), or a oneOf/anyOf where
// EVERY branch demands an identifier (exactly-one-of-ids style). Such
// tools must lose enumeration ranking to parameter-free enumerators and
// must never satisfy a request whose context supplies no identifier.
const ID_SHAPED_PARAM_RE = /(^|_)(id|uuid|url|uri|urn|guid|handle|slug|key)$/i;
const ID_SHAPED_CAMEL_RE = /[a-z](Id|Uuid|Url|Uri|Urn|Guid|Handle|Slug|Key)$/;

const isIdShapedParamName = (name) => {
  try {
    const raw = String(name || '').trim();
    if (!raw) return false;
    return ID_SHAPED_PARAM_RE.test(raw) || ID_SHAPED_CAMEL_RE.test(raw);
  } catch {
    return false;
  }
};

const requiresTargetId = (schema) => {
  try {
    const params = schema?.function?.parameters;
    if (!params || typeof params !== 'object') return false;
    const required = Array.isArray(params.required) ? params.required : [];
    for (const r of required) {
      if (typeof r === 'string' && isIdShapedParamName(r)) return true;
    }
    for (const key of ['anyOf', 'oneOf']) {
      const branches = params[key];
      if (!Array.isArray(branches) || !branches.length) continue;
      const allGated = branches.every((b) => {
        if (!b || typeof b !== 'object') return false;
        const bReq = Array.isArray(b.required) ? b.required : [];
        const bProps = (b.properties && typeof b.properties === 'object') ? Object.keys(b.properties) : [];
        return [...bReq, ...bProps].some((n) => typeof n === 'string' && isIdShapedParamName(n));
      });
      if (allGated) return true;
    }
    return false;
  } catch {
    return false;
  }
};

// Namespace prefix of a wire name (`mcp_<slug>_...`): the slug is shared by
// every tool on that server, so it must never count as domain/entity
// evidence — otherwise naming the integration ("an ACME issue")
// matches ALL of its tools equally and entity gating cannot discriminate.
// Prefers the original tool name from attached metadata when present;
// otherwise strips the `mcp_<slug>_` prefix (first two segments).
// A slug-echo LEADING segment is stripped too (`notion-create-view` on the
// `notion` server → `create-view`): some servers prefix every original
// name with the integration name, which would otherwise let a bare server
// mention ("in Notion") satisfy entity evidence for every tool.
const bareToolNameOf = (schema) => {
  try {
    const meta = schema?.mcpMetadata;
    const original = meta && typeof meta.originalToolName === 'string' ? meta.originalToolName : '';
    const wire = String(schema?.function?.name || '');
    let slug = '';
    try {
      const metaSlug = meta && typeof meta.slug === 'string' ? meta.slug : '';
      if (metaSlug.trim()) {
        slug = metaSlug;
      } else if (/^mcp_/i.test(wire)) {
        const seg = wire.split('_').filter(Boolean)[1] || '';
        slug = seg;
      }
    } catch { slug = ''; }
    const foldSeg = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const foldedSlug = foldSeg(slug);
    const stripEcho = (value) => {
      try {
        if (!foldedSlug) return value;
        const parts = String(value || '').split(/[^a-zA-Z0-9]+/).filter(Boolean);
        if (parts.length > 1 && foldSeg(parts[0]) === foldedSlug) {
          const rest = parts.slice(1).join('_');
          return rest || value;
        }
        return value;
      } catch {
        return value;
      }
    };
    let stripped = wire;
    if (/^mcp_/i.test(wire)) {
      const parts = wire.split('_').filter(Boolean);
      stripped = parts.length > 2 ? parts.slice(2).join('_') : wire;
    }
    const clean = (v) => {
      const s = stripEcho(v);
      return s && String(s).trim() ? String(s).trim() : '';
    };
    return `${clean(original)} ${clean(stripped)}`.trim() || wire;
  } catch {
    return String(schema?.function?.name || '');
  }
};

const toMcpCandidate = (schema) => {
  const nameLower = (schema?.function?.name || '').toLowerCase();
  const bareLower = bareToolNameOf(schema).toLowerCase();
  // Code spans stripped here too: `update_data_source` references must not
  // count as domain evidence for "update"/"data"/"source".
  const descStripped = stripCodeSpans(schema?.function?.description || '').toLowerCase();
  return {
    schema,
    name: schema?.function?.name || '',
    nameLower,
    descLower: (schema?.function?.description || '').toLowerCase(),
    // Entity evidence is namespace-free: bare tool name + description only.
    // The full wire name stays available for capability-name checks and
    // substring scoring (ubiquitous-namespace tokens are IDF-neutral there).
    tokenSet: tokenSetOf(`${bareLower} ${descStripped}`),
    tokenFreq: tokenFreqOf(descStripped),
    nameTokenSet: tokenSetOf(bareLower),
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

// NOTE (§30 legacy consolidation): scoreMcpSchemasDetailed (standalone IDF
// ranking with no operation/entity gate) was removed together with
// scoreMcpSchemas above — zero callers, and no independent lexical path
// may select tools outside the authoritative semantic gate.

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

function selectMcpSchemasWithPolicy(text, exposed = [], blocked = [], options = {}) {
  const lowered = normalizeText(text);
  const tokens = (lowered.match(/[a-z][a-z0-9]{2,}/g) || []).filter((t) => !MCP_STOPWORDS.has(t));
  // Server scope (explicit user mention): when the user names an
  // integration, candidates are restricted to that server's schemas on BOTH
  // sides (suppression comparisons stay symmetric). Empty scope keeps every
  // server eligible — existing behavior for unscoped requests.
  const scope = Array.isArray(options.serverScope) ? options.serverScope.filter((s) => typeof s === 'string' && s) : [];
  const inScope = (schema) => {
    if (!scope.length) return true;
    try {
      const key = mcpServerKeyOf(schema);
      return scope.some((s) => mcpScopeMatches(s, key));
    } catch {
      return true;
    }
  };
  const exposedCands = (Array.isArray(exposed) ? exposed : []).filter(inScope).map(toMcpCandidate);
  const blockedCands = (Array.isArray(blocked) ? blocked : []).filter(inScope).map(toMcpCandidate);
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
  // Capability-driven picks: for every requested capability, offer exposed
  // tools that declare it AND share domain evidence with the request (or
  // already score lexically). Multi-entity requests ("teams and projects")
  // may need SEVERAL tools for ONE capability, so each capability greedily
  // covers distinct entity tokens (bounded) instead of stopping at one pick.
  // Candidates span all exposed tools — a scored tool (update-page, fetch)
  // must be eligible, otherwise the top action tool for a capability can be
  // crowd-out by unscored noise. Defaults already cover the no-substitution
  // rule: candidates come only from the policy-permitted exposed set and
  // picks are suppressed with the whole request when policy blocks it.
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
  // Multi-entity augmentation (bounded): after the primary single pick per
  // capability below, ONE extra tool per capability may join when the query
  // conjoins several entities ("teams and projects") and the sibling names
  // a DISTINCT conjoined entity in its own tool name (list_teams +
  // list_projects). Name-only evidence keeps it honest: description-
  // frequency generalists (DDL prose, comment schemas) can never crowd out
  // the primary pick, generic nouns (excluded from entityTokens above) can
  // never trigger it, and a lone boilerplate word ("next steps") can never
  // trigger it without a conjunction. At most 2 picks per cap. Generic
  // English coordination ("A and B", "A, B and C", "A & B"), never entity
  // knowledge.
  const collectConjoinedEntities = (loweredText, validStems) => {
    const out = new Set();
    try {
      const valid = new Set(validStems);
      const isConj = (w) => w === 'and' || w === 'or';
      // Coordination is detected over `and`/`or`/`&`/`+` separators between
      // entity-looking tokens (length >= 3, present in the request's entity
      // stems). Chains ("a, b and c") reduce to pairwise links — any link
      // qualifies both endpoints.
      const seq = String(loweredText || '').toLowerCase().split(/[^a-z0-9&+]+/).filter(Boolean);
      for (let i = 0; i < seq.length - 2; i += 1) {
        const a = seq[i];
        const sep = seq[i + 1];
        const b = seq[i + 2];
        if ((isConj(sep) || sep === '&' || sep === '+') && a.length >= 3 && b.length >= 3) {
          const sa = stemEntityToken(a);
          const sb = stemEntityToken(b);
          if (valid.has(sa)) out.add(sa);
          if (valid.has(sb)) out.add(sb);
        }
      }
    } catch { /* coordination evidence must never throw */ }
    return out;
  };
  const nameCoveredBy = (cand, stems) => {
    const out = [];
    try {
      for (const s of stems) {
        if (cand.nameTokenSet && cand.nameTokenSet.has(s)) out.push(s);
      }
    } catch { /* name evidence must never throw */ }
    return out;
  };
  // READ ↔ LIST bridge (generic collection semantics): a listing IS a read
  // ("what issues are open?" → list_issues) and a read may enumerate when
  // no lister exists ("what teams do I have?" → get_team only as a last
  // resort). The bridge fires ONLY when no exact-capability candidate
  // passes the gate, so precise single-pick behavior is unchanged whenever
  // a direct match exists.
  const bridgeCap = (cap) => (cap === 'READ' ? 'LIST' : (cap === 'LIST' ? 'READ' : null));
  // Mutation correctness (§CREATE): entity-bound writes (CREATE/UPDATE/
  // DELETE/COMMENT) can never be satisfied by a tool whose target entity
  // contradicts the request ("Create an issue" must never select a
  // COMMENT/LABEL/TEMPLATE tool merely because its description mentions
  // "create" or "issue" in passing). Scoped to entity-bound caps on
  // purpose: generic action verbs (EXECUTE/SEND/…) name processes, not
  // objects ("start the sync process" → session tools), so they keep the
  // shared-evidence path with entityMatch-first ranking. The tool's target
  // entity (bare name minus action verbs, stemmed) must match a request
  // entity stem whenever the request names whole entities. Entity-blind
  // tools fall through to the existing no-strong-entity fallback below.
  const MUTATION_CAPS = new Set([
    'CREATE', 'UPDATE', 'DELETE', 'SEND', 'COMMENT', 'UPLOAD', 'DOWNLOAD',
    'EXECUTE', 'MOVE', 'DUPLICATE', 'ARCHIVE', 'RESTORE'
  ]);
  const STRICT_ENTITY_CAPS = new Set(['CREATE', 'UPDATE', 'DELETE', 'COMMENT']);
  const stemOf = (t) => stemEntityToken(String(t || '').toLowerCase());
  const queryStems = new Set(entityTokens.map(stemOf));
  // Strong (whole-entity) request stems — part-nouns ("comment", "section")
  // being added into an existing target carry no whole-entity evidence.
  const strongQueryStems = new Set(
    entityTokens
      .filter((t) => {
        const s = stemOf(t);
        return s.length >= 3 && !PART_ENTITIES.has(s);
      })
      .map(stemOf)
  );
  const toolEntityOf = (cand) => {
    try { return String(toolEntityStem(cand && cand.schema) || '').toLowerCase(); }
    catch { return ''; }
  };
  const entityMatchOf = (cand) => {
    const te = toolEntityOf(cand);
    if (!te) return 0;
    for (const q of queryStems) {
      if (!q) continue;
      if (q === te || `${q}s` === te || q === `${te}s`) return 1;
    }
    return 0;
  };
  const entityCompatible = (cand, cap, nameCap) => {
    // No whole entity named → nothing to contradict (fallback path owns it).
    if (!strongQueryStems.size) return true;
    const te = toolEntityOf(cand);
    // Entity-blind tools cannot contradict; the hasStrongEntity rule below
    // still bars them from name-only fallback when entities exist.
    if (!te) return true;
    for (const q of strongQueryStems) {
      if (q === te || `${q}s` === te || q === `${te}s`) return true;
    }
    // Name-declared mutation verbs ("save project", "execute task") keep the
    // shared-evidence path — ranking (entityMatch first) still prefers the
    // entity-exact tool, and synonyms ("job" vs "task") keep working. Only
    // description-incidental declarers ("to create a comment, supply…")
    // need an exact entity match to satisfy a mutation.
    if (nameCap) return true;
    return false;
  };
  const candByName = new Map(exposedCands.map((c) => [c.name, c]));
  for (const cap of CAPABILITY_PICK_ORDER) {
    if (!intentCaps.has(cap)) continue;
    // Coverage dedupe (mutations only): an already-picked tool that
    // declares this mutating capability satisfies it — a second mutation
    // must not ride along ("Add a comment" needs UPDATE+COMMENT, but one
    // comment mutation covers both; picking save_issue as well would
    // execute an unrelated write). Scoped to mutations: lookup caps keep
    // their bridge/augment iterations (READ→LIST picks one lister, LIST
    // then picks its sibling) so multi-entity reads still resolve.
    let covered = false;
    try {
      if (MUTATION_CAPS.has(cap)) {
        for (const n of picked) {
          if (candByName.get(n)?.caps?.has(cap)) { covered = true; break; }
        }
      }
    } catch { covered = false; }
    if (covered) continue;
    const buildRanked = (declares) => exposedCands
      .filter((c) => declares(c) && !picked.has(c.name))
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
          entityMatch: entityMatchOf(c),
          entityHits,
          partHits,
          exactScore,
          score: sc ? sc.score : 0,
          shared: sharedEntityCount(c, entityTokens)
        };
      })
      .sort((a, b) =>
        // Primary-purpose first: a name-declared capability outranks an
        // entity-matching incidental declaration (fetch beats create-pages
        // for READ even though both touch pages). Entity match breaks ties
        // between equally-declared tools (save_issue beats save_comment for
        // CREATE(ISSUE)).
        (b.nameCap - a.nameCap) ||
        (b.entityMatch - a.entityMatch) ||
        (b.entityHits - a.entityHits) ||
        (b.partHits - a.partHits) ||
        (b.exactScore - a.exactScore) ||
        (a.cand.caps.size - b.cand.caps.size) ||
        (a.cand.name < b.cand.name ? -1 : a.cand.name > b.cand.name ? 1 : 0)
      );
    const exactDeclares = (c) => c.caps.has(cap);
    let candidates = buildRanked(exactDeclares);
    // Whether any exposed candidate matches a requested entity: gates the
    // qualifier-noun rejection below (only discriminates when the request
    // actually discriminates among candidates). Measured over ALL
    // declarers — never over the post-exclusion remainder, or the rule
    // silently disarms exactly when a passenger stands alone.
    const maxEntityMatch = { value: 0 };
    const refreshMaxEntityMatch = (declares) => {
      try {
        let m = 0;
        for (const c of exposedCands) {
          if (!declares(c)) continue;
          const e = entityMatchOf(c);
          if (e > m) m = e;
        }
        maxEntityMatch.value = m;
      } catch { maxEntityMatch.value = 0; }
    };
    refreshMaxEntityMatch(exactDeclares);
    // Capability + entity gate. Rank order is intent → entity → mutation/read
    // specificity → lexical. Entity evidence is namespace-free (the
    // integration slug in every wire name cannot match), so READ(PROJECT)
    // or LIST(COMMENT) tools no longer pass for CREATE(ISSUE) on shared
    // namespace tokens alone. A name-declared capability remains
    // primary-purpose evidence that needs no domain overlap — but ONLY
    // when the request names no whole entity the candidate ignores.
    // Part-nouns being added ("add a section to it") still allow it
    // (update-page); whole nouns ("teams and projects") forbid substituting
    // an entity-blind tool (list_comments for LIST(TEAM)).
    const isStrongEntityToken = (t) => {
      const s = stemEntityToken(String(t).toLowerCase());
      return s.length >= 3 && !PART_ENTITIES.has(s);
    };
    const hasStrongEntity = entityTokens.some(isStrongEntityToken);
    const passesGate = (cand) => {
      // Destructive capabilities need primary-purpose evidence: a DELETE
      // declaration from description prose alone ("are deleted once they
      // expire", "remove all filters") must never surface a tool that
      // cannot delete user content. Require a name-declared verb or a
      // server-supplied destructive hint.
      if (cap === 'DELETE' && !cand.nameCap && !cand.cand.destructive) return false;
      // Mutation/entity correctness (intent-first) for entity-bound
      // writes: CREATE(X) can never be satisfied by a tool whose target
      // entity is not X — not by READ(X), LIST(X), GET(X), and never by
      // COMMENT/LABEL/TEMPLATE tools for an ISSUE request.
      // Description-incidental capability mentions ("to create a comment,
      // supply…") plus a shared generic noun ("issue") must not promote
      // an entity-contradicting tool.
      if (STRICT_ENTITY_CAPS.has(cap) && !entityCompatible(cand.cand, cap, cand.nameCap)) return false;
      // Entity-true lookup rule (§9 qualifier-noun class): when the request
      // names whole entities AND some candidate actually matches one, a
      // candidate whose OWN entity contradicts the request is never a pick
      // — even with shared-token overlap or a name-declared capability
      // ("Team issues and projects…" must not promote list_teams for a
      // projects request; CREATE(PROJECT) can't satisfy CREATE(ISSUE)).
      // Entity-BLIND tools (verb-only names like fetch/spawn) are exempt:
      // with no entity they cannot contradict, and the ranking below still
      // prefers exact tools. When NOTHING matches (novel domain like
      // sync/session), the legacy shared/score path applies so the request
      // is never stranded with zero picks.
      if (hasStrongEntity && maxEntityMatch.value > 0 && cand.entityMatch === 0) {
        let te = '';
        try { te = String(toolEntityStem(cand.cand.schema) || '').toLowerCase(); } catch { te = ''; }
        if (te) return false;
      }
      if (cand.shared >= 1 || cand.score >= MCP_MIN_SCORE) return true;
      if (!cand.nameCap) return false;
      // Name-declared but entity-blind: acceptable only with no whole
      // entity to contradict ("add a section to it" → update-page).
      if (hasStrongEntity) return false;
      return true;
    };
    let primary = null;
    for (const cand of candidates) {
      if (!passesGate(cand)) continue;
      primary = cand;
      break;
    }
    if (primary) {
      picked.add(primary.cand.name);
      capabilityPicks.push(primary.cand.schema);
      // Augment: one sibling that name-declares the SAME capability and
      // names a DISTINCT *conjoined* requested entity the primary's name
      // does not. Primary-purpose only (nameCap) — a description-only
      // declaration can never augment.
      const entityStems = entityTokens.map((t) => stemEntityToken(String(t).toLowerCase()));
      const conjoined = collectConjoinedEntities(lowered, entityStems);
      if (conjoined.size >= 2) {
        const primaryNameCover = new Set(nameCoveredBy(primary.cand, entityStems));
        for (const cand of candidates) {
          if (cand.cand.name === primary.cand.name) continue;
          if (!cand.nameCap) continue;
          if (!passesGate(cand)) continue;
          // Entity-true sibling: the tool's TARGET entity (bare name minus
          // action verbs) must be a requested conjoined entity the primary
          // does not cover. A qualifier noun is not enough ("labels FOR A
          // PROJECT" must never augment a teams-and-projects request —
          // its entity is LABEL, not PROJECT).
          let siblingEntity = '';
          try { siblingEntity = stemOf(toolEntityStem(cand.cand.schema)); } catch { siblingEntity = ''; }
          if (!siblingEntity || !conjoined.has(siblingEntity)) continue;
          if (primaryNameCover.has(siblingEntity)) continue;
          const cover = nameCoveredBy(cand.cand, entityStems)
            .filter((t) => conjoined.has(t) && !primaryNameCover.has(t));
          if (!cover.length) continue;
          picked.add(cand.cand.name);
          capabilityPicks.push(cand.cand.schema);
          break;
        }
      }
      continue;
    }
    // READ ↔ LIST bridge: only when no exact-capability candidate passed.
    // A listing satisfies a read ("what issues are open?" → list_issues);
    // a read enumerates only when no lister can ("what teams?" with just
    // get_team). Single best bridge pick, no augmentation — exact matches
    // elsewhere are untouched.
    const bridged = bridgeCap(cap);
    if (!primary && bridged) {
      candidates = buildRanked((c) => c.caps.has(bridged));
      refreshMaxEntityMatch((c) => c.caps.has(bridged));
      for (const cand of candidates) {
        if (!passesGate(cand)) continue;
        primary = cand;
        break;
      }
      if (primary) {
        picked.add(primary.cand.name);
        capabilityPicks.push(primary.cand.schema);
        continue;
      }
    }
    // Fallback: a short follow-up ("add a section to it") carries no whole
    // entity, so nothing passes the shared-evidence gate. A tool whose NAME
    // declares the capability (update-page for UPDATE) is primary-purpose
    // evidence with no domain confusion — prefer the most specific such
    // tool (fewest declared capabilities). Never fires when a domain match
    // exists, never from description-only declarations, and never
    // entity-blind when the request names whole entities.
    const fallback = candidates.filter((cand) => cand.nameCap > 0 && !hasStrongEntity)
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
  // Entity-preferring tail: capability picks first, then lexically scored
  // tools that share request entities, then the entity-less remainder.
  // Rank order stays intent → entity → specificity → lexical, so a CREATE
  // (ISSUE) request keeps the issue mutation ahead of project/label/comment
  // tools that merely mention "create" in passing. Stable within groups.
  const candBySchema = new Map(exposedCands.map((c) => [c.schema, c]));
  // Lister-first selection among capability picks: a single-getter whose
  // NAME does not declare LIST (get_project) but whose bare-name nouns are
  // all covered by a NAME-declared lister (list_projects) cannot satisfy an
  // enumeration on its own — it needs an id the user never supplied, and
  // leaving it callable invites the model to call it id-less and then ask
  // the user for the id. Dropped from this turn's selection (stable
  // otherwise), so LIST(TEAM) is satisfied by list_teams with no get_team
  // trap beside it. Name-declared evidence only on both sides:
  // description boilerplate ("the complete list", "to create a project")
  // must not promote nor protect. One-directional and only for LIST-seeking
  // requests: listers are never dropped, getters with uncovered nouns keep
  // their rank, non-LIST intents are untouched, and the dropped tools stay
  // exposed server-side for turns that genuinely need them.
  const bareNounsOf = (cand) => {
    try {
      const out = [];
      for (const t of (cand && cand.nameTokenSet) || []) {
        if (t && t.length >= 3 && t !== 'mcp' && !TOOL_ACTION_VERBS.has(t)) out.push(t);
      }
      return out;
    } catch {
      return [];
    }
  };
  const listNameDeclared = (cand) => {
    try {
      return CAP_TOOL_PATTERNS.LIST.some((re) => re.test(String(cand?.nameLower || '').replace(/[_-]+/g, ' ')));
    } catch {
      return false;
    }
  };
  const wantsList = intentCaps.has('LIST');
  const listerNouns = new Set();
  if (wantsList) {
    for (const s of capabilityPicks) {
      const c = candBySchema.get(s);
      if (c && listNameDeclared(c)) {
        for (const t of bareNounsOf(c)) listerNouns.add(t);
      }
    }
  }
  const orderedPicks = [];
  for (const s of capabilityPicks) {
    const c = candBySchema.get(s);
    const nouns = bareNounsOf(c);
    if (wantsList && c && !listNameDeclared(c) && nouns.length > 0 && nouns.every((t) => listerNouns.has(t))) {
      continue;
    }
    orderedPicks.push(s);
  }
  // Feasibility ordering (generic schema shape, never vendor names):
  // identifier-gated tools rank below parameter-free enumerators within
  // the same group — stable, membership-preserving. A getter that needs
  // an id the request never supplies must not outrank the lister that
  // answers directly, but it stays available for multi-step drill-down
  // (a uniformly gated group keeps its relative order).
  const feasibleFirst = (schemas) => {
    const feasible = [];
    const gated = [];
    for (const s of schemas) {
      (requiresTargetId(s) ? gated : feasible).push(s);
    }
    return [...feasible, ...gated];
  };
  const entityTail = [];
  const genericTail = [];
  for (const s of exposedScored) {
    const cand = candBySchema.get(s.schema);
    const shares = cand ? sharedEntityCount(cand, entityTokens) : 0;
    (shares > 0 ? entityTail : genericTail).push(s);
  }
  const orderedTail = [
    ...feasibleFirst(entityTail.map((s) => s.schema)),
    ...feasibleFirst(genericTail.map((s) => s.schema))
  ];
  const finalPicks = feasibleFirst(orderedPicks);
  return {
    schemas: [...finalPicks, ...orderedTail],
    suppressed: false,
    blockedNames: [],
    mcpMatched: exposedScored.length,
    capabilityNames: finalPicks.map((s) => s?.function?.name).filter(Boolean)
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
  // Capability-matched MCP tools come next: the request demonstrably needs
  // these capabilities, so heuristic native-group matches (including the
  // memory default) must not crowd them out of the cap. Production case:
  // three default natives used to evict the second LIST pick for
  // "teams and projects".
  // Explicit server scope (user named the integration): restrict scoring
  // to that server's schemas. Empty scope keeps every server eligible.
  const mcpPick = selectMcpSchemasWithPolicy(text, options.mcpSchemas, options.mcpBlocked, {
    serverScope: options.serverScope
  });
  const capSchemas = [];
  for (const n of (mcpPick.capabilityNames || [])) {
    const hit = (mcpPick.schemas || []).find((s) => s?.function?.name === n);
    if (hit && !capSchemas.includes(hit)) capSchemas.push(hit);
  }
  for (const schema of capSchemas) {
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
  // Remaining scored MCP tools fill leftover slots — unless the request
  // targets a policy-blocked capability, in which case none are offered
  // (no-substitution rule; see above). Explicit and capability matches
  // above are unaffected by suppression: offering a user-named or
  // capability-required allowed tool is never substitution.
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
  // Enforcement remainder (§9): required MCP tools that have not executed
  // yet ride the continuation directly behind the active tools, ahead of
  // stale previous picks — round 1 executes one, continuation the rest.
  // Resolved ONLY from the exposed set (deny-wins preserved); unknown names
  // are skipped like any other unresolvable tool.
  const requiredNames = Array.isArray(options.requiredNames)
    ? options.requiredNames.filter((n) => typeof n === 'string' && n)
    : [];
  let requiredCount = 0;
  for (const name of requiredNames) {
    if (ordered.length >= Math.max(mandatory.length, maxTools)) break;
    const schema = byName.get(name);
    if (schema && !ordered.includes(schema)) {
      ordered.push(schema);
      requiredCount += 1;
    }
  }
  for (const s of prev) {
    if (ordered.length >= Math.max(mandatory.length, maxTools)) break;
    if (!ordered.includes(s)) ordered.push(s);
  }
  return {
    tools: ordered,
    activeNames: Array.isArray(activeNames) ? [...activeNames] : [],
    mandatoryCount: mandatory.length,
    requiredCount
  };
}

// ---- MCP capability inventory (agent-context availability) -------------------
// Compact, bounded metadata generated from the SAME policy-filtered exposed
// schemas used for execution. Single source of truth: only tools present in
// `exposedSchemas` appear. No secrets, tokens, OAuth metadata, or tool output.
// Per tool: wire name, canonical/original name, concise description, declared
// capabilities, required-parameter summary. Per server: slug/name, connection
// + authorization state, discovered tool count. Bounded so a 64-tool server
// stays a few KB: descriptions truncated, params capped, tools capped with
// an explicit "...and N more" line (names of the remainder still listed so
// the model never claims a listed capability is unavailable).
const MCP_INVENTORY_MAX_TOOLS_TOTAL = 64;
const MCP_INVENTORY_MAX_DESC_CHARS = 100;
const MCP_INVENTORY_MAX_PARAMS = 4;

const summarizeRequiredParams = (schema, max = MCP_INVENTORY_MAX_PARAMS) => {
  try {
    const params = schema?.function?.parameters;
    if (!params || typeof params !== 'object') return 'none';
    const required = Array.isArray(params.required)
      ? params.required.filter((r) => typeof r === 'string')
      : [];
    const props = params.properties && typeof params.properties === 'object'
      ? Object.keys(params.properties).filter((k) => typeof k === 'string')
      : [];
    const names = (required.length ? required : props).slice(0, Math.max(0, max));
    if (!names.length) return 'none';
    const suffix = (required.length || props.length) > names.length ? ', …' : '';
    const reqMark = required.length ? ' (required)' : '';
    return `${names.join(', ')}${suffix}${reqMark}`;
  } catch {
    return 'none';
  }
};

const inventoryServerIdOf = (schema) => {
  try {
    const meta = schema?.mcpMetadata;
    if (meta && typeof meta === 'object') {
      if (typeof meta.slug === 'string' && meta.slug) return meta.slug;
      if (typeof meta.configName === 'string' && meta.configName) return meta.configName;
      if (typeof meta.serverId === 'string' && meta.serverId) return meta.serverId;
    }
  } catch { /* fall through to wire-name derivation */ }
  const wire = String(schema?.function?.name || '');
  const rest = wire.replace(/^mcp_/i, '');
  const sep = rest.indexOf('_');
  if (sep > 0) return rest.slice(0, sep);
  return 'mcp';
};

function buildMcpCapabilityInventory(exposedSchemas = [], meta = {}) {
  try {
    const list = Array.isArray(exposedSchemas) ? exposedSchemas : [];
    if (!list.length) return { text: '', servers: [], totalTools: 0 };
    const metadata = meta?.metadata instanceof Map ? meta.metadata : null;
    const failures = Array.isArray(meta?.failures) ? meta.failures : [];
    const byServer = new Map();
    for (const schema of list) {
      const wire = String(schema?.function?.name || '');
      if (!wire) continue;
      const serverId = inventoryServerIdOf(schema);
      if (!byServer.has(serverId)) byServer.set(serverId, []);
      byServer.get(serverId).push(schema);
    }
    const lines = [];
    const servers = [];
    let totalShown = 0;
    for (const [serverId, tools] of byServer) {
      let displayName = serverId;
      try {
        for (const t of tools) {
          const m = metadata?.get(t?.function?.name);
          if (m && (m.configName || m.slug)) { displayName = m.configName || m.slug; break; }
        }
      } catch { /* display name is advisory */ }
      servers.push({
        server: displayName,
        slug: serverId,
        state: 'connected',
        authorized: true,
        toolCount: tools.length
      });
      lines.push(`- ${displayName} (slug: ${serverId}) — CONNECTED, authorized, ${tools.length} tools:`);
      const shown = tools.slice(0, MCP_INVENTORY_MAX_TOOLS_TOTAL);
      for (const schema of shown) {
        const wire = String(schema?.function?.name || '');
        let original = '';
        try {
          const m = metadata?.get(wire);
          original = String(m?.originalToolName || m?.canonicalName || '');
        } catch { original = ''; }
        if (!original) {
          const rest = wire.replace(/^mcp_/i, '');
          const parts = rest.split('_').filter(Boolean);
          original = parts.length > 1 ? parts.slice(1).join('_') : rest;
        }
        let caps = null;
        try { caps = declareToolCapabilities(schema); } catch { caps = null; }
        const capList = caps && caps.size ? [...caps].join('/') : '—';
        const rawDesc = String(schema?.function?.description || '').replace(/\s+/g, ' ').trim();
        const desc = rawDesc.length > MCP_INVENTORY_MAX_DESC_CHARS
          ? `${rawDesc.slice(0, MCP_INVENTORY_MAX_DESC_CHARS)}…`
          : (rawDesc || 'No description.');
        const params = summarizeRequiredParams(schema);
        lines.push(`  • ${wire} (orig: ${original.slice(0, 80)}) [${capList}] params: ${params} — ${desc}`);
        totalShown += 1;
      }
      if (tools.length > shown.length) {
        const restNames = tools.slice(shown.length).map((s) => s?.function?.name).filter(Boolean);
        lines.push(`  • …and ${tools.length - shown.length} more: ${restNames.slice(0, 12).join(', ')}${restNames.length > 12 ? ', …' : ''}`);
      }
    }
    for (const f of failures.slice(0, 4)) {
      const id = String(f?.configId || f?.server || 'server');
      lines.push(`- ${id} — unavailable (${String(f?.reason || 'connection failed').slice(0, 120)}). Ask the user to authorize/reconnect in Settings; never ask for a personal API token.`);
    }
    const text = [
      'MCP INTEGRATIONS (already-authorized tool sources — prefer these over any manual API):',
      ...lines
    ].join('\n');
    return { text, servers, totalTools: list.length, shownTools: totalShown };
  } catch {
    return { text: '', servers: [], totalTools: 0 };
  }
}

// ---- False-availability guards (generic prose shapes, no vendor knowledge) --
// The model must never claim a capability is unavailable when an eligible
// exposed MCP tool exists, and must never substitute a manual API/token/UI
// walkthrough for an exposed MCP capability.
const NO_TOOL_PROSE_RE = /\b(i\s+(don't|do\s+not)\s+have\s+(a\s+)?(tool|capability|access|integration|connection)|no\s+(tool|capability|integration)\s+(is\s+)?available|i\s+cannot\s+access|not\s+connected\s+to|does\s+not\s+(provide|offer|include|support|expose)\b[^.!?]{0,60}\btools?\b|no\s+(create|update|comment|delete)[\w-]*\s+tools?\b[^.!?]{0,40}\b(available|provided|exposed|found)\b)\b/i;
const MANUAL_API_PROSE_RE = /\b(api\s*token|personal\s+(access\s*)?(token|key)|provide\s+(your|a)\s+(api\s*)?(token|key)|paste\s+(your|a)\s+(api\s*)?(token|key)|graphql\s+(query|mutation|endpoint|api)|open\s+the\s+[a-z0-9_]+\s+(ui|dashboard|app|website)\s+(to|and)\s+(create|do|manage)|use\s+the\s+[a-z0-9_]+\s+graphql\s+api|click\s+(new|the\s+new)\s+(issue|ticket|task|page|record|project)\b|open\s+[a-z][a-z0-9_]*\s*\(\s*web\s+or\s+desktop\s+app\s*\))(?![a-z0-9_])/i;

const isNoToolAvailableProse = (text) => {
  try { return NO_TOOL_PROSE_RE.test(String(text || '')); } catch { return false; }
};

const isManualApiFallbackProse = (text) => {
  try { return MANUAL_API_PROSE_RE.test(String(text || '')); } catch { return false; }
};

// Provider tool-mismatch failsafe shape (generic, no provider names):
// "attempted to call tool 'X' which was not in request.tools" (or close
// variants). Extracts X so the caller can verify it against the
// policy-exposed set, add its exact schema once, and retry once. Returns
// null when the error names no tool. Pure, never throws.
const MISSING_TOOL_RES = [
  /attempted to call tool\s+['"“‘]([^'"”’]+)['"”’]/i,
  /tool\s+['"“‘]([^'"”’]+)['"”’]\s+(?:was\s+)?not in request\.tools/i,
  /not in request\.tools\s*[:—–-]\s*['"“‘]?([A-Za-z0-9_-]+)/i,
  /Tool call validation failed[^'"“‘]*['"“‘]([^'"”’]+)['"”’]/i
];

const extractMissingToolName = (err) => {
  try {
    const text = String(err?.message || err || '');
    if (!text) return null;
    for (const re of MISSING_TOOL_RES) {
      const m = text.match(re);
      const name = m && typeof m[1] === 'string' ? m[1].trim() : '';
      if (name && /^[A-Za-z0-9_.-]{1,128}$/.test(name)) return name;
    }
    return null;
  } catch {
    return null;
  }
};

// Deterministic capability reselection: when the user request maps to a
// capability and at least one exposed (policy-permitted) tool declares it,
// force the best such tool(s) into the request when safe. Pure helper over
// the same scored policy path — never fabricates tools, never touches
// blocked/denied names (they are absent from `exposed` by construction),
// never bypasses required arguments (validation stays downstream).
function reselectMcpCapabilities(text, exposed = [], alreadySelected = [], maxTools = MAX_TOOLS_PER_REQUEST) {
  try {
    const intentCaps = classifyIntentCapabilities(text);
    if (!intentCaps.size || !Array.isArray(exposed) || !exposed.length) return [];
    const selected = new Set(
      (Array.isArray(alreadySelected) ? alreadySelected : [])
        .map((s) => s?.function?.name)
        .filter(Boolean)
    );
    const missing = [...intentCaps].filter((cap) => {
      for (const name of selected) {
        const schema = exposed.find((s) => s?.function?.name === name)
          || (Array.isArray(alreadySelected) ? alreadySelected.find((s) => s?.function?.name === name) : null);
        if (!schema) continue;
        try { if (declareToolCapabilities(schema).has(cap)) return true; } catch { /* ignore */ }
      }
      return false;
    });
    if (!missing.length) return [];
    const pick = selectMcpSchemasWithPolicy(text, exposed, []);
    const out = [];
    for (const name of (pick.capabilityNames || [])) {
      if (out.length >= Math.max(0, maxTools)) break;
      const schema = exposed.find((s) => s?.function?.name === name);
      if (schema && !selected.has(name)) { out.push(schema); selected.add(name); }
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = {
  MAX_TOOLS_PER_REQUEST,
  CAPABILITY_GROUPS,
  GROUP_PRIORITY,
  DEFAULT_GROUPS,
  CAPABILITY_PICK_ORDER,
  GENERIC_DOMAIN_NOUNS,
  classifyIntentCapabilities,
  declareToolCapabilities,
  matchGroups,
  detectOutputIntent,
  selectMcpSchemasWithPolicy,
  matchExplicitMcpSchemas,
  partitionToolCallsByExposure,
  selectToolSchemas,
  activeToolNamesFromCalls,
  selectContinuationTools,
  buildMcpCapabilityInventory,
  summarizeRequiredParams,
  isNoToolAvailableProse,
  isManualApiFallbackProse,
  extractMissingToolName,
  bareToolNameOf,
  toolEntityStem,
  mcpServerKeyOf,
  mcpScopeMatches,
  detectMcpServerScope,
  requiresTargetId,
  reselectMcpCapabilities
};
