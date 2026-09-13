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

const toMcpCandidate = (schema) => ({
  schema,
  name: schema?.function?.name || '',
  nameLower: (schema?.function?.name || '').toLowerCase(),
  descLower: (schema?.function?.description || '').toLowerCase()
});

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
    return { schemas: [], suppressed: false, blockedNames: [], mcpMatched: 0 };
  }
  const combined = [...exposedCands, ...blockedCands];
  const N = combined.length;
  const df = mcpTokenDf(tokens, combined);
  const scoreAll = (cands) => cands
    .map((c) => ({ schema: c.schema, score: scoreMcpCandidate(c, tokens, df, N), name: c.name }))
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
      mcpMatched: 0
    };
  }
  return {
    schemas: exposedScored.map((s) => s.schema),
    suppressed: false,
    blockedNames: [],
    mcpMatched: exposedScored.length
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
    mcpExplicit: explicitMcp.map((s) => s?.function?.name).filter(Boolean)
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
