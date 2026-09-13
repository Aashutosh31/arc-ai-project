/**
 * MCP server configuration API client (Phase 2).
 *
 * All endpoints live under /api/mcp/servers and require a signed-in
 * account; guests receive 403 on mutations and lifecycle actions.
 * Responses are sanitized server-side: env-var NAMES and auth metadata
 * only — secret values never cross this boundary.
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
});

const parseResponse = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `MCP request failed (${res.status})`);
    err.status = res.status;
    err.detail = data?.detail || null;
    err.category = data?.category || null;
    throw err;
  }
  return data;
};

const request = (path, options = {}) =>
  fetch(`${API_URL}/api/mcp${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  }).then(parseResponse);

export const listMcpServers = () => request('/servers');

export const createMcpServer = (payload) =>
  request('/servers', { method: 'POST', body: JSON.stringify(payload) });

export const getMcpServer = (id) => request(`/servers/${id}`);

export const updateMcpServer = (id, payload) =>
  request(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });

export const deleteMcpServer = (id) =>
  request(`/servers/${id}`, { method: 'DELETE' });

export const connectMcpServer = (id) =>
  request(`/servers/${id}/connect`, { method: 'POST' });

export const disconnectMcpServer = (id) =>
  request(`/servers/${id}/disconnect`, { method: 'POST' });

export const refreshMcpServer = (id) =>
  request(`/servers/${id}/refresh`, { method: 'POST' });

export const getMcpServerTools = (id) => request(`/servers/${id}/tools`);

// OAuth (Phase 3). Responses carry safe metadata only — tokens, codes, and
// secrets never cross this boundary.
export const startMcpOAuth = (id) =>
  request(`/servers/${id}/oauth/start`, { method: 'POST' });

export const getMcpOAuthStatus = (id) => request(`/servers/${id}/oauth/status`);

export const forgetMcpOAuth = (id, issuer = null) =>
  request(`/servers/${id}/oauth/forget`, {
    method: 'POST',
    body: JSON.stringify(issuer ? { issuer } : {}),
  });

export default {
  listMcpServers,
  createMcpServer,
  getMcpServer,
  updateMcpServer,
  deleteMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  refreshMcpServer,
  getMcpServerTools,
  startMcpOAuth,
  getMcpOAuthStatus,
  forgetMcpOAuth,
};
