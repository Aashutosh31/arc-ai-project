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
  for (const group of groups) {
    for (const name of CAPABILITY_GROUPS[group] || []) {
      const schema = byName.get(name);
      if (schema && !ordered.includes(schema)) ordered.push(schema);
    }
  }
  const selected = ordered.slice(0, maxTools);
  return {
    tools: selected,
    groups,
    matchedGroups: matched,
    defaulted: matched.length === 0,
    totalAvailable: schemas.length
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

// TOOL-CONTINUATION turn (NOT a new intent classification event).
// The continuation belongs to the same tool-use transaction, so the tools
// referenced by the active tool calls are MANDATORY: dropping them produces
// `tools=[]` alongside `assistant.tool_calls`, which providers reject
// ("tool choice is none, but model called a tool"). Previously selected
// tools fill the remainder up to the cap. Unknown names are skipped — the
// registry is the source of truth, so a renamed tool can never break the
// request. Schemas are passed through untouched, never edited.
function selectContinuationTools(previousTools, activeNames, getSchemasFn = null, options = {}) {
  const maxTools = Math.max(0, Number(options.maxTools ?? MAX_TOOLS_PER_REQUEST));
  const prev = Array.isArray(previousTools) ? previousTools : [];
  let registry = [];
  try {
    registry = typeof getSchemasFn === 'function' ? getSchemasFn() : [];
  } catch {
    registry = [];
  }
  const byName = new Map();
  for (const s of [...prev, ...(Array.isArray(registry) ? registry : [])]) {
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
  selectToolSchemas,
  activeToolNamesFromCalls,
  selectContinuationTools
};
