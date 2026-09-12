'use strict';

// Namespace and wire-name utilities for MCP-discovered tools.
//
// Every MCP tool gets TWO stable identities, deterministic and 1:1:
//
//   canonical name (internal identity, human readable)
//     mcp.<serverSlug>.<originalToolName>   e.g. mcp.github.create_issue
//
//   wire name (what the LLM and its tool-calls see)
//     mcp_<serverSlug>_<originalToolName>   e.g. mcp_github_create_issue
//
// The underscore form is REQUIRED for the live LLM providers: Groq silently
// drops any tool whose name is not ^[a-zA-Z0-9_-]+$ (GroqProvider.buildTools),
// Mistral and Gemini are relaxed, so the canonical dotted form can never be
// sent to the model. The McpRegistry keeps the canonical -> wire map so a
// model-produced wire name resolves back to the exact (server, tool).
//
// Guests of the namespace:
//  - Natives tools are plain names with no `mcp.`/`mcp_` prefix, so an MCP
//    server can never collide with a native ARC tool through this prefix.
//  - Two servers with the same slug get deterministic suffixes; two tools
//    with the same wire name get deterministic numeric suffixes.

const crypto = require('crypto');

const MCP_PREFIX = 'mcp';
const SLUG_SEP = '.';
const WIRE_SEP = '_';

const MAX_WIRE_NAME_LENGTH = 64;

// Server slug: lowercase [a-z0-9_], deterministic from a config name/id.
const sanitizeSlug = (value) => {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, WIRE_SEP)
    .replace(new RegExp(`${WIRE_SEP}+`, 'g'), WIRE_SEP)
    .replace(new RegExp(`^${WIRE_SEP}|${WIRE_SEP}$`, 'g'), '');
  return cleaned || 'server';
};

// Tool segment: keeps [a-zA-Z0-9_-], folds anything else to '_'.
const sanitizeToolSegment = (value) => {
  const cleaned = String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, WIRE_SEP)
    .replace(new RegExp(`${WIRE_SEP}+`, 'g'), WIRE_SEP)
    .replace(new RegExp(`^${WIRE_SEP}|${WIRE_SEP}$`, 'g'), '');
  return cleaned || 'tool';
};

const canonicalName = (slug, toolName) =>
  `${MCP_PREFIX}${SLUG_SEP}${slug}${SLUG_SEP}${toolName}`;

const wireName = (slug, toolName) =>
  `${MCP_PREFIX}${WIRE_SEP}${slug}${WIRE_SEP}${toolName}`;

const isMcpCanonicalName = (name) =>
  typeof name === 'string' && name.startsWith(`${MCP_PREFIX}${SLUG_SEP}`);

const isMcpWireName = (name) =>
  typeof name === 'string' && name.startsWith(`${MCP_PREFIX}${WIRE_SEP}`);

// Providers reject names over 64 chars. Deterministic shortening with a
// content hash suffix so distinct long names stay distinct.
const fitWireName = (name) => {
  if (name.length <= MAX_WIRE_NAME_LENGTH) return name;
  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  const head = `${name.slice(0, MAX_WIRE_NAME_LENGTH - hash.length - 1)}${WIRE_SEP}`;
  return `${head}${hash}`;
};

// Best-effort reverse of wireName(); the authoritative mapping lives in the
// registry (which is what production resolves through). This decoder handles
// the deterministic wire format only, never truncated hash forms.
const decodeWireName = (wire) => {
  if (!isMcpWireName(wire)) return null;
  const rest = wire.slice(MCP_PREFIX.length + WIRE_SEP.length);
  const firstSep = rest.indexOf(WIRE_SEP);
  if (firstSep < 0) return null;
  return { slug: rest.slice(0, firstSep), toolName: rest.slice(firstSep + WIRE_SEP.length) };
};

// Collision-safe registration naming. `claimed` is a Set of already-taken
// names; returns a name that does not collide by appending _2, _3, ... in
// ascending order (deterministic — stable regardless of connection order
// because callers feed tombstones in canonical id order).
const uniqueName = (base, claimed) => {
  if (!claimed || !claimed.has(base)) return base;
  let n = 2;
  const max = 9999;
  while (claimed.has(`${base}${WIRE_SEP}${n}`) && n < max) n += 1;
  return `${base}${WIRE_SEP}${n}`;
};

module.exports = {
  MCP_PREFIX,
  SLUG_SEP,
  WIRE_SEP,
  MAX_WIRE_NAME_LENGTH,
  sanitizeSlug,
  sanitizeToolSegment,
  canonicalName,
  wireName,
  isMcpCanonicalName,
  isMcpWireName,
  fitWireName,
  decodeWireName,
  uniqueName
};