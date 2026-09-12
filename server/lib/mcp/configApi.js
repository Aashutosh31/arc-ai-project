'use strict';

// Pure helpers for the MCP configuration API (server/routes/mcp.js).
//
// Kept dependency-free so the Phase 2 contract (validation, redaction,
// tool-policy parsing) is unit-testable without MongoDB. The route layer
// owns authz + persistence; this module owns shape only.
//
// Secret policy: McpServerConfig documents store environment-variable NAMES
// and auth metadata only — secret VALUES are never persisted. This module
// guarantees the API never echoes anything else back to the browser.

const VALID_TRANSPORTS = ['stdio', 'streamable-http'];
const VALID_SCOPES = ['workspace', 'global'];

// Fields the browser is allowed to see. Everything stored on the document
// outside this list is either internal (owner ObjectId, __v) or must stay
// server-side. Note: auth carries metadata ONLY (type/headerName/env-var
// NAME) — values are never stored, so there is nothing to leak.
const CLIENT_VISIBLE_FIELDS = [
  '_id', 'id', 'name', 'slug', 'scope', 'workspace',
  'transport', 'command', 'args', 'url',
  'envVarNames', 'allowlistEnv',
  'allowedTools', 'deniedTools',
  'auth', 'enabled', 'guestAllowed',
  'createdAt', 'updatedAt'
];

const sanitizeAuthForClient = (auth) => {
  if (!auth || typeof auth !== 'object') return { type: 'none' };
  return {
    type: auth.type === 'header' ? 'header' : 'none',
    headerName: auth.type === 'header' ? (auth.headerName || 'Authorization') : undefined,
    // Env-var NAME reference only. The value lives in process.env server-side.
    envVar: auth.type === 'header' ? (auth.envVar || null) : null,
    configured: auth.type === 'header' ? Boolean(auth.envVar) : false
  };
};

const sanitizeConfigForClient = (doc) => {
  if (!doc || typeof doc !== 'object') return null;
  const out = {};
  for (const field of CLIENT_VISIBLE_FIELDS) {
    if (doc[field] === undefined) continue;
    out[field] = doc[field];
  }
  if ('_id' in out) out.id = String(out._id);
  out.envVarNames = Array.isArray(out.envVarNames) ? [...out.envVarNames] : [];
  out.allowlistEnv = Array.isArray(out.allowlistEnv) ? [...out.allowlistEnv] : [];
  out.allowedTools = Array.isArray(out.allowedTools) ? [...out.allowedTools] : [];
  out.deniedTools = Array.isArray(out.deniedTools) ? [...out.deniedTools] : [];
  out.args = Array.isArray(out.args) ? [...out.args] : [];
  out.auth = sanitizeAuthForClient(out.auth);
  out.enabled = out.enabled !== false;
  out.guestAllowed = out.guestAllowed === true;
  return out;
};

// Accepts an array or a comma/newline-separated string; returns a deduped
// array of trimmed non-empty entries. Used for env-var names and tool policy
// lists. Never resolves values — names/identities only.
const parseNameList = (value) => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
};

const isValidHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// Validate a create/update payload. Returns { ok, error, data } where data
// is the persistence-safe subset (no secret values — callers must never add
// any). For updates, only fields present in the body are validated/emitted.
const validateConfigInput = (body = {}, { isUpdate = false } = {}) => {
  const fail = (error) => ({ ok: false, error, data: null });
  const data = {};
  const has = (key) => body[key] !== undefined;

  if (!isUpdate || has('name')) {
    const name = String(body.name ?? '').trim();
    if (!name) return fail('Server name is required.');
    if (name.length > 128) return fail('Server name must be 128 characters or fewer.');
    data.name = name;
  }

  if (has('slug')) {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (slug && !/^[a-z0-9_]{1,128}$/.test(slug)) {
      return fail('Slug may only contain lowercase letters, numbers, and underscores.');
    }
    data.slug = slug || undefined;
  }

  if (has('scope')) {
    if (!VALID_SCOPES.includes(body.scope)) return fail('Scope must be "workspace" or "global".');
    data.scope = body.scope;
  }

  if (has('workspace')) {
    data.workspace = body.workspace || null;
  }

  if (has('transport')) {
    if (!VALID_TRANSPORTS.includes(body.transport)) {
      return fail('Transport must be "stdio" or "streamable-http".');
    }
    data.transport = body.transport;
  }

  // Transport-specific fields validate against the EFFECTIVE transport so
  // partial updates (no transport key) still validate correctly. The route
  // passes effectiveTransport for updates.
  const effectiveTransport = body.transport || body._effectiveTransport || null;

  if (!isUpdate || has('command') || has('args') || has('url')) {
    if (effectiveTransport === 'stdio' || (!isUpdate && body.transport === 'stdio')) {
      if (!isUpdate || has('command')) {
        const command = String(body.command ?? '').trim();
        if (!command) return fail('Stdio transport requires a command.');
        data.command = command;
      }
      if (has('args')) {
        data.args = Array.isArray(body.args)
          ? body.args.map((a) => String(a ?? '').trim()).filter(Boolean)
          : String(body.args ?? '').split(/[\n]+/).map((a) => a.trim()).filter(Boolean);
      }
    }
    if (effectiveTransport === 'streamable-http' || (!isUpdate && body.transport === 'streamable-http')) {
      if (!isUpdate || has('url')) {
        const url = String(body.url ?? '').trim();
        if (!url) return fail('Streamable HTTP transport requires an endpoint URL.');
        if (!isValidHttpUrl(url)) return fail('Endpoint URL must be a valid http(s) URL.');
        data.url = url;
      }
    }
  }

  if (has('envVarNames')) data.envVarNames = parseNameList(body.envVarNames);
  if (has('allowlistEnv')) data.allowlistEnv = parseNameList(body.allowlistEnv);
  if (has('allowedTools')) data.allowedTools = parseNameList(body.allowedTools);
  if (has('deniedTools')) data.deniedTools = parseNameList(body.deniedTools);

  if (has('auth')) {
    const auth = body.auth;
    if (auth !== null && typeof auth !== 'object') return fail('Auth must be an object or null.');
    if (!auth) {
      data.auth = { type: 'none' };
    } else {
      const type = auth.type === 'header' ? 'header' : 'none';
      const headerName = String(auth.headerName || 'Authorization').trim() || 'Authorization';
      // Env-var NAME reference only — never a secret value.
      const envVar = auth.envVar ? String(auth.envVar).trim() : null;
      if (type === 'header' && envVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
        return fail('Auth env var must be a valid environment variable name.');
      }
      data.auth = { type, headerName, envVar };
    }
  }

  if (has('enabled')) data.enabled = body.enabled !== false;
  if (has('guestAllowed')) data.guestAllowed = body.guestAllowed === true;

  return { ok: true, error: null, data };
};

// Read-only discovery payload for GET /:id/tools. Tool schemas stay
// server-side; the browser gets names + descriptions + policy counts only.
const buildToolsPayload = ({ config, connectionState, protocolVersion, serverInfo, tools, failures, policy }) => ({
  serverId: config ? String(config._id || config.id) : null,
  connectionState: connectionState || 'disconnected',
  protocolVersion: protocolVersion || null,
  serverInfo: serverInfo ? { name: serverInfo.name || null, version: serverInfo.version || null } : null,
  toolCount: Array.isArray(tools) ? tools.length : 0,
  tools: Array.isArray(tools) ? tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    allowed: t.allowed !== false
  })) : [],
  policy: policy || { allowedTools: [], deniedTools: [] },
  failures: Array.isArray(failures) ? failures : []
});

module.exports = {
  VALID_TRANSPORTS,
  VALID_SCOPES,
  CLIENT_VISIBLE_FIELDS,
  sanitizeAuthForClient,
  sanitizeConfigForClient,
  parseNameList,
  isValidHttpUrl,
  validateConfigInput,
  buildToolsPayload
};
