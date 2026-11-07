/**
 * JARVIS Phase 4 — scheduled jobs API client.
 *
 * Owner- and workspace-scoped server routes under /api/jobs. Workspace is
 * always explicit when known: a missing value means the global workspace on
 * the server, never "all workspaces".
 */

import { API_URL } from '../config';

const authFetch = (url, options = {}) => fetch(url, {
  ...options,
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
});

const parseResponse = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error || `Scheduled job request failed (${res.status})`);
    error.status = res.status;
    error.code = data?.code || null;
    error.detail = data?.detail || null;
    throw error;
  }
  return data;
};

const request = (path, options = {}) =>
  authFetch(`${API_URL}/api/jobs${path}`, options).then(parseResponse);

const workspaceQuery = (workspaceId) =>
  workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';

export const listJobs = (workspaceId) =>
  request(`/${workspaceQuery(workspaceId)}`);

export const createJob = (payload) =>
  request('/', { method: 'POST', body: JSON.stringify(payload) });

export const getJob = (jobId, workspaceId) =>
  request(`/${encodeURIComponent(jobId)}${workspaceQuery(workspaceId)}`);

export const pauseJob = (jobId, workspaceId) =>
  request(`/${encodeURIComponent(jobId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspaceId || undefined })
  });

export const resumeJob = (jobId, workspaceId) =>
  request(`/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspaceId || undefined })
  });

export const cancelJob = (jobId, workspaceId) =>
  request(`/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspaceId || undefined })
  });

export const runJobNow = (jobId, workspaceId) =>
  request(`/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspaceId || undefined })
  });

export const listRuns = (jobId, workspaceId, limit = 10) =>
  request(`/${encodeURIComponent(jobId)}/runs${workspaceQuery(workspaceId)}${workspaceId ? '&' : '?'}limit=${Number(limit) || 10}`);

export const markNotificationsRead = (workspaceId) =>
  request('/notifications/read', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspaceId || undefined })
  });

export default {
  listJobs,
  createJob,
  getJob,
  pauseJob,
  resumeJob,
  cancelJob,
  runJobNow,
  listRuns,
  markNotificationsRead
};
