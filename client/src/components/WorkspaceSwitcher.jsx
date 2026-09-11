import React, { useMemo, useState } from 'react';
import styled from 'styled-components';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { Button as UiButton, Input as UiInput, Textarea as UiTextarea } from './ui';

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
`;

const Select = styled.select`
  width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  background: var(--surface);
  color: var(--foreground);
  padding: 11px 12px;
  font-size: 13px;
  outline: none;
`;

const ActionRow = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
`;

const WorkspaceMeta = styled.div`
  color: var(--foreground-muted);
  font-size: 12px;
  line-height: 1.45;
`;

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1700;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
`;

const Modal = styled.div`
  width: min(460px, 100%);
  border-radius: 16px;
  border: 1px solid rgba(var(--primary-rgb), 0.28);
  background: linear-gradient(180deg, var(--surface-elevated), var(--surface));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
`;

const ModalHeader = styled.div`
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border-subtle);
`;

const ModalTitle = styled.h4`
  margin: 0;
  color: var(--accent-soft);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 13px;
`;

const ModalSubtitle = styled.p`
  margin: 6px 0 0;
  color: var(--foreground-muted);
  font-size: 12px;
`;

const ModalBody = styled.div`
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const FieldLabel = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--foreground);
  font-size: 12px;
`;

const ModalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 16px 14px;
`;

const InlineError = styled.div`
  font-size: 12px;
  color: var(--destructive-soft);
`;

const CurrentName = styled.div`
  color: var(--accent-soft);
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
  const [modalMode, setModalMode] = useState(null); // create | rename | delete | null
  const [nameInput, setNameInput] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState('');

  const closeModal = () => {
    if (submitting) return;
    setModalMode(null);
    setNameInput('');
    setDescriptionInput('');
    setModalError('');
  };

  const openCreateModal = () => {
    setModalMode('create');
    setNameInput('New Workspace');
    setDescriptionInput('');
    setModalError('');
  };

  const openRenameModal = () => {
    if (!activeWorkspaceId) return;
    setModalMode('rename');
    setNameInput(activeWorkspace?.name || 'Workspace');
    setDescriptionInput(activeWorkspace?.description || '');
    setModalError('');
  };

  const openDeleteModal = () => {
    if (!activeWorkspaceId) return;
    setModalMode('delete');
    setModalError('');
  };

  const handleCreate = async () => {
    const nextName = String(nameInput || '').trim();
    if (!nextName) {
      setModalError('Workspace name is required.');
      return;
    }
    setSubmitting(true);
    setModalError('');
    try {
      await createWorkspace({ name: nextName, description: String(descriptionInput || '').trim() });
      closeModal();
    } catch (err) {
      setModalError(err?.message || 'Failed to create workspace');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async () => {
    if (!activeWorkspaceId) return;
    const nextName = String(nameInput || '').trim();
    if (!nextName) {
      setModalError('Workspace name is required.');
      return;
    }
    setSubmitting(true);
    setModalError('');
    try {
      await renameWorkspace(activeWorkspaceId, {
        name: nextName,
        description: String(descriptionInput || '').trim()
      });
      closeModal();
    } catch (err) {
      setModalError(err?.message || 'Failed to rename workspace');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!activeWorkspaceId) return;
    setSubmitting(true);
    setModalError('');
    try {
      await deleteWorkspace(activeWorkspaceId);
      closeModal();
    } catch (err) {
      setModalError(err?.message || 'Failed to archive workspace');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel>
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
        <UiButton variant="outline" size="sm" className="w-full" type="button" onClick={openCreateModal} disabled={loadingWorkspaces || switchingWorkspace}>New</UiButton>
        <UiButton variant="outline" size="sm" className="w-full" type="button" onClick={openRenameModal} disabled={!activeWorkspaceId || loadingWorkspaces || switchingWorkspace}>Rename</UiButton>
        <UiButton variant="outline" size="sm" className="w-full" type="button" onClick={openDeleteModal} disabled={!activeWorkspaceId || loadingWorkspaces || switchingWorkspace}>Delete</UiButton>
      </ActionRow>
      <WorkspaceMeta>
        {workspaceError ? workspaceError : `${workspaceOptions.length} workspace${workspaceOptions.length === 1 ? '' : 's'} loaded.`}
      </WorkspaceMeta>

      {modalMode ? (
        <Overlay onClick={closeModal}>
          <Modal onClick={(event) => event.stopPropagation()}>
            <ModalHeader>
              <ModalTitle>
                {modalMode === 'create' ? 'Create Workspace' : modalMode === 'rename' ? 'Rename Workspace' : 'Archive Workspace'}
              </ModalTitle>
              <ModalSubtitle>
                {modalMode === 'create'
                  ? 'Create a dedicated runtime space with isolated conversations and executions.'
                  : modalMode === 'rename'
                    ? 'Update the workspace label and description visible in your runtime shell.'
                    : `Archive ${activeWorkspace?.name || 'this workspace'} and switch to another workspace.`}
              </ModalSubtitle>
            </ModalHeader>

            <ModalBody>
              {modalMode !== 'delete' ? (
                <>
                  <FieldLabel>
                    Workspace Name
                    <UiInput
                      value={nameInput}
                      onChange={(event) => setNameInput(event.target.value)}
                      placeholder="Workspace name"
                      maxLength={80}
                      autoFocus
                    />
                  </FieldLabel>
                  <FieldLabel>
                    Description
                    <UiTextarea
                      value={descriptionInput}
                      onChange={(event) => setDescriptionInput(event.target.value)}
                      placeholder="Optional workspace description"
                      maxLength={320}
                    />
                  </FieldLabel>
                </>
              ) : (
                <WorkspaceMeta>
                  This action archives the workspace and keeps existing records safe. You can no longer route runtime state to it unless recovered later.
                </WorkspaceMeta>
              )}

              {modalError ? <InlineError>{modalError}</InlineError> : null}
            </ModalBody>

            <ModalActions>
              <UiButton variant="ghost" type="button" onClick={closeModal} disabled={submitting}>Cancel</UiButton>
              {modalMode === 'create' ? (
                <UiButton variant="outline" type="button" onClick={handleCreate} disabled={submitting}>Create</UiButton>
              ) : null}
              {modalMode === 'rename' ? (
                <UiButton variant="outline" type="button" onClick={handleRename} disabled={submitting}>Save</UiButton>
              ) : null}
              {modalMode === 'delete' ? (
                <UiButton variant="danger-outline" type="button" onClick={handleDelete} disabled={submitting}>Archive</UiButton>
              ) : null}
            </ModalActions>
          </Modal>
        </Overlay>
      ) : null}
    </Panel>
  );
};

export default WorkspaceSwitcher;