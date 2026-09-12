/**
 * MCP / Integrations management UI (Phase 2).
 *
 * Read-write management for MCP server configurations through the Phase 2
 * API (/api/mcp/servers). The browser only ever sees sanitized metadata:
 * env-var NAMES and auth metadata (type/header/env-var name + configured
 * flag). Secret values live in process.env server-side and are never
 * rendered, edited, or echoed here.
 *
 * Tool discovery display is read-only; the server/runtime remains the only
 * execution authority.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { Button, Input, Textarea, Card, Badge, Dialog } from './ui';
import mcpApi from '../lib/mcpApi';

const STATUS_META = {
  connected: { tone: 'success', dot: 'bg-success', label: 'Connected' },
  connecting: { tone: 'warning', dot: 'bg-warning', label: 'Connecting' },
  disconnected: { tone: 'default', dot: 'bg-muted-foreground', label: 'Disconnected' },
};

const emptyForm = (workspaceId) => ({
  name: '',
  slug: '',
  scope: 'workspace',
  workspace: workspaceId || '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  envVarNames: '',
  allowlistEnv: '',
  authType: 'none',
  authHeaderName: 'Authorization',
  authEnvVar: '',
  enabled: true,
  guestAllowed: false,
  allowedTools: '',
  deniedTools: '',
});

const serverToForm = (server, fallbackWorkspaceId) => ({
  name: server?.name || '',
  slug: server?.slug || '',
  scope: server?.scope || 'workspace',
  workspace: server?.workspace ? String(server.workspace) : (fallbackWorkspaceId || ''),
  transport: server?.transport || 'stdio',
  command: server?.command || '',
  args: Array.isArray(server?.args) ? server.args.join('\n') : '',
  url: server?.url || '',
  envVarNames: Array.isArray(server?.envVarNames) ? server.envVarNames.join(', ') : '',
  allowlistEnv: Array.isArray(server?.allowlistEnv) ? server.allowlistEnv.join(', ') : '',
  authType: server?.auth?.type === 'header' ? 'header' : 'none',
  authHeaderName: server?.auth?.headerName || 'Authorization',
  authEnvVar: server?.auth?.envVar || '',
  enabled: server?.enabled !== false,
  guestAllowed: server?.guestAllowed === true,
  allowedTools: Array.isArray(server?.allowedTools) ? server.allowedTools.join(', ') : '',
  deniedTools: Array.isArray(server?.deniedTools) ? server.deniedTools.join(', ') : '',
});

const formToPayload = (form) => {
  const payload = {
    name: form.name.trim(),
    scope: form.scope,
    transport: form.transport,
    enabled: form.enabled,
    guestAllowed: form.guestAllowed,
  };
  if (form.slug.trim()) payload.slug = form.slug.trim().toLowerCase();
  if (form.scope === 'workspace') payload.workspace = form.workspace || null;
  if (form.transport === 'stdio') {
    payload.command = form.command.trim();
    payload.args = form.args.split(/[\n]+/).map((a) => a.trim()).filter(Boolean);
    payload.envVarNames = form.envVarNames.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
    payload.allowlistEnv = form.allowlistEnv.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
  } else {
    payload.url = form.url.trim();
    payload.envVarNames = form.envVarNames.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
    payload.allowlistEnv = form.allowlistEnv.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
    payload.auth = form.authType === 'header'
      ? { type: 'header', headerName: form.authHeaderName.trim() || 'Authorization', envVar: form.authEnvVar.trim() || null }
      : { type: 'none' };
  }
  payload.allowedTools = form.allowedTools.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
  payload.deniedTools = form.deniedTools.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
  return payload;
};

const Field = ({ label, hint, children }) => (
  <label className="block mb-3">
    <span className="block text-xs font-semibold text-foreground mb-1">{label}</span>
    {children}
    {hint ? <span className="block text-[11px] text-muted-foreground mt-1 leading-relaxed">{hint}</span> : null}
  </label>
);

const McpSettings = ({ isGuest }) => {
  const { workspaces, activeWorkspaceId } = useWorkspace();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(() => emptyForm(activeWorkspaceId));
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [toolsOpen, setToolsOpen] = useState({});
  const [toolsCache, setToolsCache] = useState({});
  const [formTools, setFormTools] = useState([]);
  const [formToolsLoading, setFormToolsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await mcpApi.listMcpServers();
      setServers(Array.isArray(data?.servers) ? data.servers : []);
    } catch (err) {
      setError(err?.message || 'Failed to load MCP servers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const set = (key) => (e) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e?.target?.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm(activeWorkspaceId));
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (server) => {
    setEditing(server);
    setForm(serverToForm(server, activeWorkspaceId));
    setFormError('');
    setFormTools([]);
    setFormOpen(true);
    // Load the ACTUAL discovered wire names so allow/deny entries can be
    // picked exactly — hand-typed names that don't match real tool identity
    // silently fail open. Best effort; the form works without it.
    const id = server.id || server._id;
    setFormToolsLoading(true);
    mcpApi.getMcpServerTools(id)
      .then((payload) => setFormTools(Array.isArray(payload?.tools) ? payload.tools : []))
      .catch(() => setFormTools([]))
      .finally(() => setFormToolsLoading(false));
  };

  const appendToolName = (field, wireName) => {
    setForm((f) => {
      const current = String(f[field] || '').split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
      if (current.includes(wireName)) return f;
      return { ...f, [field]: [...current, wireName].join(', ') };
    });
  };

  const validateLocal = () => {
    if (!form.name.trim()) return 'Server name is required.';
    if (form.scope === 'workspace' && !form.workspace) return 'Workspace-scoped servers require a workspace assignment.';
    if (form.transport === 'stdio' && !form.command.trim()) return 'Stdio transport requires a command.';
    if (form.transport === 'streamable-http' && !form.url.trim()) return 'Streamable HTTP requires an endpoint URL.';
    if (form.transport === 'streamable-http' && form.url.trim() && !/^https?:\/\//i.test(form.url.trim())) {
      return 'Endpoint URL must start with http(s)://.';
    }
    return '';
  };

  const handleSave = async () => {
    const localError = validateLocal();
    if (localError) { setFormError(localError); return; }
    setSaving(true);
    setFormError('');
    try {
      const payload = formToPayload(form);
      if (editing) {
        await mcpApi.updateMcpServer(editing.id || editing._id, payload);
      } else {
        await mcpApi.createMcpServer(payload);
      }
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setFormError(err?.message || 'Failed to save MCP server.');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (server, action) => {
    const id = server.id || server._id;
    setBusyId(`${action}:${id}`);
    setError('');
    try {
      if (action === 'delete') {
        await mcpApi.deleteMcpServer(id);
      } else if (action === 'connect') {
        await mcpApi.connectMcpServer(id);
      } else if (action === 'disconnect') {
        await mcpApi.disconnectMcpServer(id);
      } else if (action === 'refresh') {
        const payload = await mcpApi.refreshMcpServer(id);
        setToolsCache((c) => ({ ...c, [id]: payload }));
        setToolsOpen((o) => ({ ...o, [id]: true }));
      } else if (action === 'toggle') {
        await mcpApi.updateMcpServer(id, { enabled: !(server.enabled !== false) });
      }
      await refresh();
    } catch (err) {
      setError(err?.detail ? `${err.message}: ${err.detail}` : (err?.message || 'Action failed.'));
    } finally {
      setBusyId(null);
    }
  };

  const toggleTools = async (server) => {
    const id = server.id || server._id;
    const open = !toolsOpen[id];
    setToolsOpen((o) => ({ ...o, [id]: open }));
    if (open && !toolsCache[id]) {
      setBusyId(`tools:${id}`);
      try {
        const payload = await mcpApi.getMcpServerTools(id);
        setToolsCache((c) => ({ ...c, [id]: payload }));
      } catch (err) {
        setError(err?.message || 'Failed to load discovered tools.');
      } finally {
        setBusyId(null);
      }
    }
  };

  const statusOf = (server) => {
    const key = server?.status?.connectionState || 'disconnected';
    return STATUS_META[key] || STATUS_META.disconnected;
  };

  const workspaceName = useMemo(() => {
    const map = {};
    for (const w of workspaces || []) map[String(w._id)] = w.name || 'Workspace';
    return map;
  }, [workspaces]);

  if (isGuest) {
    return (
      <div>
        <h3 className="text-base font-bold text-foreground mb-1">MCP / Integrations</h3>
        <p className="text-xs text-muted-foreground leading-relaxed mb-4">
          Model Context Protocol servers extend ARC with external tools.
        </p>
        <Card className="p-4">
          <p className="text-sm text-foreground">Sign in to manage MCP servers.</p>
          <p className="text-xs text-muted-foreground mt-1">Guest sessions cannot configure integrations.</p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-base font-bold text-foreground">MCP / Integrations</h3>
        <Button size="sm" variant="outline" onClick={openAdd}>+ Add MCP Server</Button>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed mb-4">
        Connect ARC to external tools over the Model Context Protocol (stdio or Streamable HTTP).
        Credentials stay server-side — only variable names and connection metadata appear here.
      </p>

      {error ? (
        <div className="mb-3 px-3 py-2 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 text-xs text-foreground" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading MCP servers…</p>
      ) : servers.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-foreground">No MCP servers configured.</p>
          <p className="text-xs text-muted-foreground mt-1">Add a stdio command or a Streamable HTTP endpoint to get started.</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {servers.map((server) => {
            const id = server.id || server._id;
            const meta = statusOf(server);
            const enabled = server.enabled !== false;
            const toolCount = server?.status?.toolCount ?? 0;
            const busy = (a) => busyId === `${a}:${id}`;
            const tools = toolsCache[id];
            return (
              <Card key={id} className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground truncate">{server.name}</span>
                      <Badge tone={meta.tone} outline className="uppercase tracking-wide text-[10px]">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${meta.dot}`} aria-hidden="true" />
                        {meta.label}
                      </Badge>
                      <Badge tone="default" outline className="uppercase tracking-wide text-[10px]">
                        {server.transport === 'streamable-http' ? 'Streamable HTTP' : 'stdio'}
                      </Badge>
                      <Badge tone={server.scope === 'global' ? 'primary' : 'default'} outline className="uppercase tracking-wide text-[10px]">
                        {server.scope === 'global' ? 'Global' : `Workspace · ${workspaceName[String(server.workspace)] || 'assigned'}`}
                      </Badge>
                      {!enabled ? (
                        <Badge tone="warning" outline className="uppercase tracking-wide text-[10px]">Disabled</Badge>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {toolCount} tool{toolCount === 1 ? '' : 's'}
                      {server?.status?.protocolVersion ? ` · protocol ${server.status.protocolVersion}` : ''}
                      {server?.auth?.type === 'header' ? ` · auth via ${server.auth.envVar || 'env var'}${server.auth.configured ? '' : ' (not configured)'}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" variant="ghost" onClick={() => toggleTools(server)} disabled={busy('tools')}>
                      {toolsOpen[id] ? 'Hide tools' : 'Tools'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(server)}>Configure</Button>
                    {meta.label === 'Connected' || toolCount > 0 ? (
                      <Button size="sm" variant="ghost" onClick={() => runAction(server, 'disconnect')} disabled={busy('disconnect')}>
                        {busy('disconnect') ? '…' : 'Disconnect'}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => runAction(server, 'connect')} disabled={!enabled || busy('connect')}>
                        {busy('connect') ? '…' : 'Connect'}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => runAction(server, 'refresh')} disabled={!enabled || busy('refresh')}>
                      {busy('refresh') ? '…' : 'Refresh'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => runAction(server, 'toggle')} disabled={busy('toggle')}>
                      {enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-outline"
                      onClick={() => { if (window.confirm(`Delete "${server.name}"?`)) runAction(server, 'delete'); }}
                      disabled={busy('delete')}
                    >
                      Delete
                    </Button>
                  </div>
                </div>

                {toolsOpen[id] ? (
                  <div className="mt-3 pt-3 border-t border-border">
                    {busy('tools') || !tools ? (
                      <p className="text-[11px] text-muted-foreground">Loading discovered tools…</p>
                    ) : tools.tools?.length ? (
                      <ul className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
                        {tools.tools.map((t) => (
                          <li key={t.name} className="flex items-start justify-between gap-2 text-[12px]">
                            <span className="min-w-0">
                              <code className="text-foreground break-all">{t.name}</code>
                              {t.description ? <span className="block text-muted-foreground truncate">{t.description}</span> : null}
                            </span>
                            {!t.allowed ? (
                              <Badge tone="warning" outline className="text-[10px] shrink-0">blocked by policy</Badge>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        {tools.connectionState === 'connected'
                          ? 'Connected, no tools discovered.'
                          : 'Not connected. Connect or refresh to discover tools.'}
                      </p>
                    )}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={formOpen} onClose={() => setFormOpen(false)} title={editing ? 'Configure MCP Server' : 'Add MCP Server'} className="max-w-lg max-h-[85vh] overflow-y-auto">
        {formError ? (
          <div className="mb-3 px-3 py-2 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 text-xs text-foreground" role="alert">
            {formError}
          </div>
        ) : null}

        <Field label="Name">
          <Input value={form.name} onChange={set('name')} placeholder="e.g. Local Tools" maxLength={128} />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Slug (optional)" hint="Lowercase letters, numbers, underscores. Auto-generated when empty.">
            <Input value={form.slug} onChange={set('slug')} placeholder="local_tools" />
          </Field>
          <Field label="Transport">
            <select
              value={form.transport}
              onChange={set('transport')}
              className="w-full h-10 bg-card text-foreground border border-border rounded-[var(--radius-md)] px-3 text-sm outline-none focus:border-primary"
            >
              <option value="stdio">stdio (local command)</option>
              <option value="streamable-http">Streamable HTTP (endpoint URL)</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Scope">
            <select
              value={form.scope}
              onChange={set('scope')}
              className="w-full h-10 bg-card text-foreground border border-border rounded-[var(--radius-md)] px-3 text-sm outline-none focus:border-primary"
            >
              <option value="workspace">Workspace-specific</option>
              <option value="global">Global</option>
            </select>
          </Field>
          {form.scope === 'workspace' ? (
            <Field label="Workspace" hint="Only workspaces you own can be assigned.">
              <select
                value={form.workspace}
                onChange={set('workspace')}
                className="w-full h-10 bg-card text-foreground border border-border rounded-[var(--radius-md)] px-3 text-sm outline-none focus:border-primary"
              >
                <option value="">Select a workspace…</option>
                {(workspaces || []).map((w) => (
                  <option key={w._id} value={String(w._id)}>{w.name || 'Workspace'}</option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>

        {form.transport === 'stdio' ? (
          <>
            <Field label="Command" hint="Executable spawned by the ARC server.">
              <Input value={form.command} onChange={set('command')} placeholder="e.g. npx" />
            </Field>
            <Field label="Arguments (one per line)">
              <Textarea value={form.args} onChange={set('args')} placeholder={'-y\nmy-mcp-server'} rows={2} />
            </Field>
            <Field label="Environment variable names (comma-separated)" hint="Names only — values stay in the server environment and are never shown here.">
              <Input value={form.envVarNames} onChange={set('envVarNames')} placeholder="e.g. MCP_API_TOKEN" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Endpoint URL">
              <Input value={form.url} onChange={set('url')} placeholder="https://…" inputMode="url" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Auth">
                <select
                  value={form.authType}
                  onChange={set('authType')}
                  className="w-full h-10 bg-card text-foreground border border-border rounded-[var(--radius-md)] px-3 text-sm outline-none focus:border-primary"
                >
                  <option value="none">None</option>
                  <option value="header">Header (env var reference)</option>
                </select>
              </Field>
              {form.authType === 'header' ? (
                <Field label="Header name">
                  <Input value={form.authHeaderName} onChange={set('authHeaderName')} placeholder="Authorization" />
                </Field>
              ) : null}
            </div>
            {form.authType === 'header' ? (
              <Field label="Auth env-var name" hint="Name only — the secret value is read from the server environment at connect time.">
                <Input value={form.authEnvVar} onChange={set('authEnvVar')} placeholder="e.g. MCP_API_TOKEN" autoComplete="off" />
              </Field>
            ) : null}
          </>
        )}

        <Field label="Allowed tools (optional, comma-separated)" hint="Empty = all discovered tools allowed. Denied always wins. Prefer the exact names below — entries must match real tool identity.">
          <Textarea value={form.allowedTools} onChange={set('allowedTools')} placeholder="e.g. mcp_tools_echo" rows={2} />
        </Field>
        <Field label="Denied tools (optional, comma-separated)" hint="Matched against wire / canonical / original tool identity.">
          <Textarea value={form.deniedTools} onChange={set('deniedTools')} placeholder="e.g. mcp_tools_admin" rows={2} />
        </Field>
        {editing ? (
          <div className="mb-4">
            <span className="block text-xs font-semibold text-foreground mb-1">Discovered tools (click to add exact name)</span>
            {formToolsLoading ? (
              <span className="text-[11px] text-muted-foreground">Loading discovered tools…</span>
            ) : formTools.length ? (
              <div className="flex flex-wrap gap-1.5">
                {formTools.map((t) => (
                  <span key={t.name} className="inline-flex items-center gap-1 text-[11px] bg-card border border-border rounded-full pl-2 py-0.5">
                    <code className="text-foreground break-all">{t.name}</code>
                    <button
                      type="button"
                      title={`Allow ${t.name}`}
                      aria-label={`Allow ${t.name}`}
                      className="px-1.5 text-success hover:brightness-125 cursor-pointer"
                      onClick={() => appendToolName('allowedTools', t.name)}
                    >+A</button>
                    <button
                      type="button"
                      title={`Deny ${t.name}`}
                      aria-label={`Deny ${t.name}`}
                      className="pr-2 text-destructive hover:brightness-125 cursor-pointer"
                      onClick={() => appendToolName('deniedTools', t.name)}
                    >+D</button>
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-[11px] text-muted-foreground">Connect the server first to pick exact tool names. Typed entries still work.</span>
            )}
          </div>
        ) : null}

        <div className="flex items-center gap-5 mt-1 mb-4 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={set('enabled')} className="accent-[var(--primary-hex)]" />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer" title="Guests may use this server's tools where the runtime allows.">
            <input type="checkbox" checked={form.guestAllowed} onChange={set('guestAllowed')} className="accent-[var(--primary-hex)]" />
            Visible to guests
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add server'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
};

export default McpSettings;
