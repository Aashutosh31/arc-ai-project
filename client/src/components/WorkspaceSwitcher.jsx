import React, { useMemo } from 'react';
import styled from 'styled-components';
import { useWorkspace } from '../contexts/WorkspaceContext';

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 12px 12px;
  border-bottom: 1px solid rgba(var(--primary-rgb), 0.15);
`;

const Label = styled.div`
  color: #a8b5d8;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
`;

const Select = styled.select`
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  background: rgba(0, 0, 0, 0.22);
  color: #f4fbff;
  padding: 11px 12px;
  font-size: 13px;
  outline: none;
`;

const ActionRow = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
`;

const ActionButton = styled.button`
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  background: rgba(255, 255, 255, 0.04);
  color: #eefcff;
  border-radius: 10px;
  padding: 9px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(var(--primary-rgb), 0.35);
    background: rgba(var(--primary-rgb), 0.08);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
    transform: none;
  }
`;

const WorkspaceMeta = styled.div`
  color: #8fa2cf;
  font-size: 12px;
  line-height: 1.45;
`;

const CurrentName = styled.div`
  color: #7df7ff;
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const WorkspaceSwitcher = () => {
  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    loadingWorkspaces,
    switchingWorkspace,
    workspaceError,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace
  } = useWorkspace();

  const workspaceOptions = useMemo(() => workspaces || [], [workspaces]);

  const handleCreate = async () => {
    const name = window.prompt('Workspace name', 'New Workspace');
    if (name === null || !name.trim()) return;
    const description = window.prompt('Workspace description', '') || '';
    await createWorkspace({ name: name.trim(), description: description.trim() });
  };

  const handleRename = async () => {
    if (!activeWorkspaceId) return;
    const nextName = window.prompt('Rename workspace', activeWorkspace?.name || 'Workspace');
    if (nextName === null || !nextName.trim()) return;
    const nextDescription = window.prompt('Workspace description', activeWorkspace?.description || '') || activeWorkspace?.description || '';
    await renameWorkspace(activeWorkspaceId, {
      name: nextName.trim(),
      description: String(nextDescription).trim()
    });
  };

  const handleDelete = async () => {
    if (!activeWorkspaceId) return;
    const confirmed = window.confirm(`Archive workspace "${activeWorkspace?.name || 'Workspace'}"?`);
    if (!confirmed) return;
    await deleteWorkspace(activeWorkspaceId);
  };

  return (
    <Panel>
      <Label>Workspace</Label>
      <CurrentName title={activeWorkspace?.name || 'Workspace'}>
        {activeWorkspace?.name || 'No active workspace'}
      </CurrentName>
      <Select
        value={activeWorkspaceId || ''}
        disabled={loadingWorkspaces || switchingWorkspace || workspaceOptions.length === 0}
        onChange={(event) => switchWorkspace(event.target.value)}
        aria-label="Switch workspace"
      >
        {workspaceOptions.length === 0 ? (
          <option value="">Loading workspaces...</option>
        ) : workspaceOptions.map((workspace) => (
          <option key={workspace._id} value={workspace._id}>
            {workspace.name || 'Workspace'}
          </option>
        ))}
      </Select>
      <ActionRow>
        <ActionButton type="button" onClick={handleCreate} disabled={loadingWorkspaces || switchingWorkspace}>New</ActionButton>
        <ActionButton type="button" onClick={handleRename} disabled={!activeWorkspaceId || loadingWorkspaces || switchingWorkspace}>Rename</ActionButton>
        <ActionButton type="button" onClick={handleDelete} disabled={!activeWorkspaceId || loadingWorkspaces || switchingWorkspace}>Delete</ActionButton>
      </ActionRow>
      <WorkspaceMeta>
        {workspaceError ? workspaceError : `${workspaceOptions.length} workspace${workspaceOptions.length === 1 ? '' : 's'} loaded.`}
      </WorkspaceMeta>
    </Panel>
  );
};

export default WorkspaceSwitcher;