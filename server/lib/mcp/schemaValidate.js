'use strict';

// Structural argument validation for MCP tool calls (dependency-free).
//
// Invariant: arguments sent to an MCP tool must conform to the selected
// tool's actual inputSchema. The execution boundary (McpToolAdapter) runs
// this BEFORE any network call so a model-hallucinated shape (e.g. an
// object where the schema declares a string) fails fast with a structured
// error instead of burning a provider round-trip or a server 400 — and
// existing recovery/replanning handles the failure like any other.
//
// Enforced (only what is explicitly declared):
//   - required presence (missing counts; false/0 are VALID values)
//   - primitive types: string, number, integer, boolean, array, object, null
//   - enum membership (strict)
//   - nested object properties + array item schemas (depth-bounded)
//
// Deliberately NOT enforced (fail OPEN, never false-reject):
//   - unknown keywords (anyOf/oneOf/allOf/not/pattern/format/const/...)
//   - undeclared properties, missing/unknown type fields, empty schemas
//   - anything beyond depth/error caps
//
// No coercion, no invented defaults: a mismatch is reported, never
// rewritten. Pure functions, never throw on odd shapes.

const MAX_DEPTH = 10;
const MAX_ERRORS = 12;

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer-or-number' : 'number';
  return typeof value;
};

// Declared 'integer' accepts integers only; declared 'number' accepts any
// finite number. Everything else is strict.
const typeMatches = (declared, value) => {
  const t = String(declared || '').toLowerCase();
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (t === 'string') return typeof value === 'string';
  if (t === 'boolean' || t === 'bool') return typeof value === 'boolean';
  if (t === 'array') return Array.isArray(value);
  if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (t === 'null') return value === null;
  return true; // unknown/absent type: fail open
};

const isMissing = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

// Missing counts for required presence, EXCEPT null is a value when the
// declared type explicitly allows it (type 'null' or enum containing null).
const isMissingForDef = (value, def) => {
  if (value !== null) return isMissing(value);
  const t = String((def && def.type) || '').toLowerCase();
  if (t === 'null') return false;
  if (Array.isArray(def && def.enum) && def.enum.some((e) => e === null)) return false;
  return true;
};

const pushError = (errors, path, expected, value) => {
  if (errors.length >= MAX_ERRORS) return;
  let received = typeOf(value);
  if (received === 'integer-or-number') received = 'number';
  errors.push({ path: path || '(root)', expected, received });
};

const checkValue = (value, def, path, errors, depth) => {
  if (errors.length >= MAX_ERRORS) return;
  if (!def || typeof def !== 'object') return; // nothing declared: fail open
  if (depth > MAX_DEPTH) return;

  if (def.type !== undefined && def.type !== null && def.type !== '') {
    if (!typeMatches(def.type, value)) {
      pushError(errors, path, String(def.type).toLowerCase(), value);
      return; // shape wrong: deeper checks would only pile on
    }
  }

  if (Array.isArray(def.enum) && def.enum.length) {
    const hit = def.enum.some((e) => e === value);
    if (!hit) {
      pushError(errors, path, `one of ${def.enum.map((e) => JSON.stringify(e)).join(', ')}`, value);
      return;
    }
  }

  // Compositional keywords (generic JSON Schema semantics):
  //   anyOf — valid when AT LEAST ONE branch validates (never collapsed);
  //   oneOf — valid when EXACTLY ONE branch validates (never collapsed
  //           into anyOf: overlapping branches must fail);
  //   allOf — valid when ALL branches validate.
  // Sibling constraints (type/enum above) apply conjunctively, per spec.
  // Branch internals never leak into the error set unless the composition
  // itself fails — then one summary error keeps output bounded.
  for (const key of ['allOf']) {
    if (Array.isArray(def[key]) && def[key].length) {
      for (const branch of def[key].slice(0, 16)) {
        const before = errors.length;
        checkValue(value, branch, path, errors, depth + 1);
        if (errors.length !== before) return; // branch detail already recorded
      }
    }
  }
  if (Array.isArray(def.anyOf) && def.anyOf.length) {
    const matched = def.anyOf.slice(0, 16).some((branch) => {
      const probe = [];
      checkValue(value, branch, path, probe, depth + 1);
      return probe.length === 0;
    });
    if (!matched) {
      pushError(errors, path, `match anyOf (${def.anyOf.length} branches)`, value);
      return;
    }
  }
  if (Array.isArray(def.oneOf) && def.oneOf.length) {
    let matches = 0;
    for (const branch of def.oneOf.slice(0, 16)) {
      const probe = [];
      checkValue(value, branch, path, probe, depth + 1);
      if (probe.length === 0) matches += 1;
      if (matches > 1) break;
    }
    if (matches !== 1) {
      pushError(errors, path, `match exactly one oneOf branch (matched ${matches})`, value);
      return;
    }
  }

  const t = String(def.type || '').toLowerCase();
  if ((t === 'object' || (!def.type && value && typeof value === 'object' && !Array.isArray(value)))
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = (def.properties && typeof def.properties === 'object') ? def.properties : {};
    const required = Array.isArray(def.required) ? def.required : [];
    for (const name of required) {
      if (typeof name !== 'string') continue;
      if (isMissingForDef(value[name], props[name])) {
        pushError(errors, path ? `${path}.${name}` : name, 'required', value[name]);
      }
    }
    for (const [name, sub] of Object.entries(props)) {
      // Absent or explicit-null OPTIONAL values are skipped: models emit
      // nulls for unknown optionals constantly, and servers ignore them.
      // Required-null is already reported as missing above.
      if (value[name] === undefined || value[name] === null) continue;
      checkValue(value[name], sub, path ? `${path}.${name}` : name, errors, depth + 1);
    }
    return;
  }

  if ((t === 'array' || (!def.type && Array.isArray(value))) && Array.isArray(value)) {
    const items = (def.items && typeof def.items === 'object') ? def.items : null;
    if (items) {
      for (let i = 0; i < value.length; i += 1) {
        checkValue(value[i], items, `${path}[${i}]`, errors, depth + 1);
        if (errors.length >= MAX_ERRORS) break;
      }
    }
  }
};

// Validate an args object against a JSON-Schema-style inputSchema.
// Returns { ok, errors } — errors capped, JSON-pointer-ish paths.
// Non-object schemas or args fail OPEN (nothing enforceable).
function validateArgsAgainstSchema(args, schema) {
  const errors = [];
  try {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true, errors };
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      // Scalar args against an object schema: only enforceable when the
      // schema demands properties; otherwise fail open.
      const required = Array.isArray(schema.required) ? schema.required.filter((n) => typeof n === 'string') : [];
      if (!required.length) return { ok: true, errors };
      for (const name of required) pushError(errors, name, 'required', undefined);
      return { ok: errors.length === 0, errors };
    }
    checkValue(args, schema, '', errors, 0);
    return { ok: errors.length === 0, errors };
  } catch {
    return { ok: true, errors: [] }; // validation must never break execution
  }
}

const formatValidationErrors = (errors) =>
  (Array.isArray(errors) ? errors : [])
    .slice(0, MAX_ERRORS)
    .map((e) => `${e.path}: expected ${e.expected}, received ${e.received === undefined ? 'missing' : e.received}`)
    .join('; ');

module.exports = {
  MAX_DEPTH,
  MAX_ERRORS,
  validateArgsAgainstSchema,
  formatValidationErrors
};
