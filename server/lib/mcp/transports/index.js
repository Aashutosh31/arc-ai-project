'use strict';

// Transport factories: build MCP client transports from a resolved config.
//
// Secret policy: configs reference environment VARIABLE NAMES, never values.
// `envVarNames` is the allowlist of env vars the spawned server is permitted
// to see; `auth.envVar` names the env var holding a bearer/header secret,
// which is read only at connect time into request headers. Values never touch
// logs or the registry.

const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/client/stdio');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { toMcpToolError, CATEGORIES } = require('../errors');

const readEnv = (name) => process.env[name];

const buildChildEnv = (config) => {
  const env = {};
  for (const [key, value] of Object.entries(getDefaultEnvironment())) {
    if (typeof value === 'string' && value) env[key] = value;
  }
  for (const name of config.envVarNames || []) {
    if (typeof name !== 'string' || !name) continue;
    const value = readEnv(name);
    if (value !== undefined && value !== null) env[name] = String(value);
  }
  if (config.allowlistEnv && Array.isArray(config.allowlistEnv)) {
    for (const name of config.allowlistEnv) {
      const value = readEnv(name);
      if (value !== undefined && value !== null) env[name] = String(value);
    }
  }
  return env;
};

const createStdioTransport = (config) => {
  const command = config.command;
  const args = Array.isArray(config.args) ? config.args : [];
  if (!command || typeof command !== 'string' || !command.trim()) {
    throw toMcpToolError(new Error('stdio transport requires a command.'), {
      category: CATEGORIES.PROTOCOL_ERROR,
      serverId: config.id
    });
  }
  const env = buildChildEnv(config);
  return new StdioClientTransport({
    command,
    args,
    env,
    cwd: config.cwd || undefined,
    stderr: config.stderr || 'pipe'
  });
};

const createStreamableHTTPTransport = (config) => {
  const url = config.url;
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw toMcpToolError(new Error('streamable-http transport requires a url.'), {
      category: CATEGORIES.PROTOCOL_ERROR,
      serverId: config.id
    });
  }
  const requestInit = { headers: buildAuthHeaders(config) };
  return new StreamableHTTPClientTransport(url, { requestInit });
};

const buildAuthHeaders = (config) => {
  const headers = {};
  const auth = config.auth || {};
  if (auth.type !== 'header') return headers;
  const headerName = auth.headerName || 'Authorization';
  const envVar = auth.envVar;
  const value = envVar ? readEnv(envVar) : undefined;
  let headerValue = value !== undefined && value !== null ? String(value) : '';
  if (headerName.toLowerCase() === 'authorization' && headerValue && !/^\w+ /.test(headerValue)) {
    headerValue = `Bearer ${headerValue}`;
  }
  if (headerValue) headers[headerName] = headerValue;
  return headers;
};

module.exports = {
  createStdioTransport,
  createStreamableHTTPTransport,
  buildChildEnv,
  buildAuthHeaders,
  readEnv
};