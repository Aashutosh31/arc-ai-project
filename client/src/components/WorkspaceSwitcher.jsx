import React, { useMemo, useState } from 'react';
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
  background: linear-gradient(180deg, rgba(13, 14, 32, 0.98), rgba(8, 10, 22, 0.98));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
`;

const ModalHeader = styled.div`
  padding: 14px 16px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
`;

const ModalTitle = styled.h4`
  margin: 0;
  color: #7df7ff;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 13px;
`;

const ModalSubtitle = styled.p`
  margin: 6px 0 0;
  color: #aeb8d9;
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
  color: #d8e5ff;
  font-size: 12px;
`;

const Input = styled.input`
  width: 100%;
  border-radius: 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.24);
  background: rgba(255, 255, 255, 0.04);
  color: #f4fbff;
  padding: 10px 12px;
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: rgba(var(--primary-rgb), 0.5);
    box-shadow: 0 0 0 2px rgba(var(--primary-rgb), 0.14);
  }
`;

const Textarea = styled.textarea`
  width: 100%;
  min-height: 90px;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.24);
  background: rgba(255, 255, 255, 0.04);
  color: #f4fbff;
  padding: 10px 12px;
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: rgba(var(--primary-rgb), 0.5);
    box-shadow: 0 0 0 2px rgba(var(--primary-rgb), 0.14);
  }
`;

const ModalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 16px 14px;
`;

const SecondaryButton = styled.button`
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.04);
  color: #e8ecff;
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 12px;
  cursor: pointer;
`;

const PrimaryButton = styled.button`
  border: 1px solid rgba(var(--primary-rgb), 0.36);
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.24), rgba(var(--secondary-rgb), 0.18));
  color: #eafcff;
  border-radius: 10px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const DangerButton = styled(PrimaryButton)`
  border-color: rgba(255, 70, 70, 0.5);
  background: rgba(255, 70, 70, 0.16);
  color: #ffb8b8;
`;

const InlineError = styled.div`
  font-size: 12px;
  color: #ff9f9f;
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
        <ActionButton type="button" onClick={openCreateModal} disabled={loadingWorkspaces || switchingWorkspace}>New</ActionButton>
        <ActionButton type="button" onClick={openRenameModal} disabled={!activeWorkspaceId || loadingWorkspaces || switchingWorkspace}>Rename</ActionButton>
        <ActionButton type="button" onClick={openDeleteModal} disabled={!activeWorkspaceId || loadingWorkspaces || switchingWorkspace}>Delete</ActionButton>
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
                    <Input
                      value={nameInput}
                      onChange={(event) => setNameInput(event.target.value)}
                      placeholder="Workspace name"
                      maxLength={80}
                      autoFocus
                    />
                  </FieldLabel>
                  <FieldLabel>
                    Description
                    <Textarea
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
              <SecondaryButton type="button" onClick={closeModal} disabled={submitting}>Cancel</SecondaryButton>
              {modalMode === 'create' ? (
                <PrimaryButton type="button" onClick={handleCreate} disabled={submitting}>Create</PrimaryButton>
              ) : null}
              {modalMode === 'rename' ? (
                <PrimaryButton type="button" onClick={handleRename} disabled={submitting}>Save</PrimaryButton>
              ) : null}
              {modalMode === 'delete' ? (
                <DangerButton type="button" onClick={handleDelete} disabled={submitting}>Archive</DangerButton>
              ) : null}
            </ModalActions>
          </Modal>
        </Overlay>
      ) : null}
    </Panel>
  );
};

export default WorkspaceSwitcher;