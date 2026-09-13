// Deterministic pending tool-call state machine (multi-turn argument collection).
//
// Production failure: `mcp_mcp_reference_annotatedMessage` requires
// { messageType, includeImage }. Turn 1 ("execute ...") selected the tool,
// but every later turn ("success", then "true") starts a FRESH stateless
// request — provider messages carry only the current user turn, selection
// re-runs on the fragmentary text (zero MCP tools), and no code anywhere
// stores partially supplied arguments. "success" lived nowhere structured,
// "true" could never merge into it, the model had no schema, so it asked
// again forever. Relying on the model to remember slots through prose does
// not work; this module preserves the pending call deterministically.
//
// Shape: { toolName, args, missing, rounds, updatedAt }.
// Pure functions only — persistence lives with the caller (Conversation
// document). Generic over native and MCP schemas: nothing here names a
// specific tool. Policy is enforced by the caller (a denied tool must never
// be stored or resumed — pass only permitted tools/schemas in).

const MAX_CLARIFICATION_ROUNDS = 4;
const PENDING_TTL_MS = 30 * 60 * 1000;
const SINGLE_STRING_FILL_MAX_CHARS = 200;

// Full-message cancel phrases (anchored — a bare "no" answering a boolean
// question must NOT cancel).
const CANCEL_RE = /^(cancel|stop|never\s?mind|forget\s(it|about\sit)|no\s?thanks|abort)\s*\.?!?\s*$/i;

const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0', 'off']);

const wordsOf = (text) => String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];

// Required params in schema order: [{ name, def }].
function requiredParams(schema) {
  const params = schema?.function?.parameters || schema?.parameters || {};
  const required = Array.isArray(params.required) ? params.required : [];
  const props = (params.properties && typeof params.properties === 'object') ? params.properties : {};
  return required
    .filter((n) => typeof n === 'string')
    .map((name) => ({ name, def: (props[name] && typeof props[name] === 'object') ? props[name] : {} }));
}

// Names whose value is absent. `false` and `0` are VALID values — only
// undefined/null/'' count as missing.
function isMissingValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function missingRequired(schema, args) {
  const present = (args && typeof args === 'object') ? args : {};
  return requiredParams(schema).filter(({ name }) => isMissingValue(present[name])).map(({ name }) => name);
}

// Coerce one raw value to a param definition. Returns { ok, value } —
// never throws. Used both for model-issued calls and merged user answers.
function coerceArgValue(def, raw) {
  const d = (def && typeof def === 'object') ? def : {};
  const type = String(d.type || 'string').toLowerCase();
  const enums = Array.isArray(d.enum) ? d.enum : null;

  if (raw === undefined || raw === null) return { ok: false, value: raw };
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, value: raw };

  if (enums && enums.length) {
    const hit = enums.find((e) => String(e).toLowerCase() === String(raw).trim().toLowerCase());
    return hit === undefined ? { ok: false, value: raw } : { ok: true, value: hit };
  }
  if (type === 'boolean' || type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const t = String(raw).trim().toLowerCase();
    if (TRUE_TOKENS.has(t)) return { ok: true, value: true };
    if (FALSE_TOKENS.has(t)) return { ok: true, value: false };
    return { ok: false, value: raw };
  }
  if (type === 'integer' || type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return { ok: false, value: raw };
    if (type === 'integer' && !Number.isInteger(n)) return { ok: false, value: raw };
    if (typeof d.minimum === 'number' && n < d.minimum) return { ok: false, value: raw };
    if (typeof d.maximum === 'number' && n > d.maximum) return { ok: false, value: raw };
    return { ok: true, value: n };
  }
  // Strings (and unknown types): accept non-empty text as-is.
  return { ok: true, value: typeof raw === 'string' ? raw : String(raw) };
}

// Validate a full args object: required presence + per-value coercion.
// Returns { ok, errors, coerced } — coerced holds canonical values
// (enum canonical case, real booleans/numbers) for everything valid.
function validateArgs(schema, args) {
  const present = (args && typeof args === 'object') ? args : {};
  const errors = [];
  const coerced = { ...present };
  for (const { name, def } of requiredParams(schema)) {
    if (isMissingValue(present[name])) {
      errors.push({ name, reason: 'missing' });
      continue;
    }
    const c = coerceArgValue(def, present[name]);
    if (!c.ok) errors.push({ name, reason: 'invalid' });
    else coerced[name] = c.value;
  }
  return { ok: errors.length === 0, errors, coerced };
}

// Extract confident values for MISSING params from free text. Only matches
// constrained by the schema itself (enum membership, boolean/number words);
// open strings fill only when a single string param remains missing.
// Returns { paramName: typedValue } — possibly empty, never throws.
function extractArgValues(text, params) {
  const out = {};
  const list = Array.isArray(params) ? params : [];
  if (!list.length) return out;
  const lowered = String(text || '').toLowerCase();
  const tokens = wordsOf(text);
  if (!tokens.length) return out;

  const missingStrings = list.filter(({ def }) => {
    const d = (def && typeof def === 'object') ? def : {};
    return !(Array.isArray(d.enum) && d.enum.length)
      && !['boolean', 'bool', 'integer', 'number'].includes(String(d.type || 'string').toLowerCase());
  });

  for (const { name, def } of list) {
    const d = (def && typeof def === 'object') ? def : {};
    if (Array.isArray(d.enum) && d.enum.length) {
      const hit = d.enum.find((e) => {
        const v = String(e).toLowerCase();
        // Whole-token hit ("success") or exact quoted/phrase hit.
        return tokens.includes(v) || lowered.includes(`"${v}"`) || lowered.includes(`'${v}'`);
      });
      if (hit !== undefined) out[name] = hit;
      continue;
    }
    const type = String(d.type || 'string').toLowerCase();
    if (type === 'boolean' || type === 'bool') {
      // Ordered scan, last decisive token wins ("yes, no image" -> false).
      let val = null;
      for (const tok of tokens) {
        if (TRUE_TOKENS.has(tok)) val = true;
        else if (FALSE_TOKENS.has(tok)) val = false;
      }
      if (val !== null) out[name] = val;
      continue;
    }
    if (type === 'integer' || type === 'number') {
      const tok = tokens.find((t) => /^-?\d+(\.\d+)?$/.test(t));
      if (tok !== undefined) {
        const c = coerceArgValue(d, tok);
        if (c.ok) out[name] = c.value;
      }
      continue;
    }
    // Open string: fill only when it is the SOLE missing param — never guess
    // across several open slots.
    if (missingStrings.length === 1 && missingStrings[0].name === name) {
      const trimmed = String(text || '').trim();
      if (trimmed && trimmed.length <= SINGLE_STRING_FILL_MAX_CHARS) out[name] = trimmed;
    }
  }
  return out;
}

function buildClarification(toolName, missing, captured) {
  const parts = (Array.isArray(missing) ? missing : []).map(({ name, def }) => {
    const d = (def && typeof def === 'object') ? def : {};
    if (Array.isArray(d.enum) && d.enum.length) {
      const opts = d.enum.map((e) => `"${e}"`).join(', ');
      return `${name} (${opts})`;
    }
    const type = String(d.type || 'string').toLowerCase();
    if (type === 'boolean' || type === 'bool') return `${name} (true/false)`;
    return name;
  });
  let text = `To run ${toolName} I still need: ${parts.join('; ')}.`;
  const kept = Object.entries(captured || {}).filter(([, v]) => !isMissingValue(v));
  if (kept.length) text += ` Already have: ${kept.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}.`;
  return text;
}

function createPending(toolName, args, schema, now = Date.now()) {
  const safeArgs = (args && typeof args === 'object') ? { ...args } : {};
  return {
    toolName,
    args: safeArgs,
    missing: missingRequired(schema, safeArgs),
    rounds: 0,
    updatedAt: Number(now) || Date.now()
  };
}

function isExpired(pending, now = Date.now()) {
  if (!pending || typeof pending.updatedAt !== 'number') return true;
  return (Number(now) || Date.now()) - pending.updatedAt > PENDING_TTL_MS;
}

function isCancelText(text) {
  return CANCEL_RE.test(String(text || '').trim());
}

// Advance one user turn. Pure: { action, pending, args?, question?, missing? }.
//   execute — all required args complete and valid; caller must issue exactly
//             ONE tool call with `args` and clear the pending record.
//   ask     — merged what was found, still missing values; caller must send
//             `question` verbatim (no extra clarification afterwards) and
//             persist `pending`.
//   abandon — user cancelled, record expired, or rounds exhausted; caller
//             must clear and continue the normal flow.
function advancePending(pending, text, schema, now = Date.now()) {
  if (!pending || typeof pending.toolName !== 'string') return { action: 'abandon', reason: 'no-pending' };
  if (isCancelText(text)) return { action: 'abandon', reason: 'cancelled' };
  if (isExpired(pending, now)) return { action: 'abandon', reason: 'expired' };
  if (Number(pending.rounds) >= MAX_CLARIFICATION_ROUNDS) return { action: 'abandon', reason: 'rounds-exhausted' };

  const params = requiredParams(schema);
  const byName = new Map(params.map((p) => [p.name, p]));
  const stillMissing = (Array.isArray(pending.missing) ? pending.missing : []).filter((n) => byName.has(n));
  const extracted = extractArgValues(text, stillMissing.map((n) => byName.get(n)));

  // Merge: fill missing always; overwrite an already-captured value only
  // with a confident same-turn extraction — non-boolean overwrites freely
  // ("actually error"), boolean overwrites only when it is the SOLE
  // extraction ("false" corrects true; "no, I meant success" must not flip
  // a captured true to false). Invalid text ("banana") extracts nothing, so
  // valid prior values are never destroyed.
  const extractionNames = Object.keys(extracted);
  const merged = { ...(pending.args || {}) };
  for (const name of stillMissing) {
    if (extracted[name] !== undefined) merged[name] = extracted[name];
  }
  for (const name of Object.keys(merged)) {
    if (stillMissing.includes(name) || extracted[name] === undefined) continue;
    const def = byName.get(name)?.def || {};
    const type = String(def.type || 'string').toLowerCase();
    const soleExtraction = extractionNames.length === 1;
    if (type !== 'boolean' && type !== 'bool') merged[name] = extracted[name];
    else if (soleExtraction) merged[name] = extracted[name];
  }

  const validation = validateArgs(schema, merged);
  const missing = validation.errors.map((e) => e.name);
  const at = Number(now) || Date.now();

  if (validation.ok) {
    return { action: 'execute', args: validation.coerced, pending: null, missing: [] };
  }
  const next = {
    toolName: pending.toolName,
    args: merged,
    missing,
    rounds: Number(pending.rounds || 0) + 1,
    updatedAt: at
  };
  const missingParams = missing.map((n) => byName.get(n)).filter(Boolean);
  return {
    action: 'ask',
    pending: next,
    args: merged,
    missing,
    question: buildClarification(pending.toolName, missingParams, merged)
  };
}

module.exports = {
  MAX_CLARIFICATION_ROUNDS,
  PENDING_TTL_MS,
  CANCEL_RE,
  requiredParams,
  missingRequired,
  coerceArgValue,
  validateArgs,
  extractArgValues,
  buildClarification,
  createPending,
  advancePending,
  isExpired,
  isCancelText
};
