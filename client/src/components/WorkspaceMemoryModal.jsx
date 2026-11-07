import React, { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { useConversation } from '../contexts/ConversationContext';
import { useWorkspace } from '../contexts/WorkspaceContext';

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1600;
  background: rgba(0, 0, 0, 0.68);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
`;

const Panel = styled.div`
  width: min(1120px, 100%);
  max-height: min(88vh, 920px);
  display: flex;
  flex-direction: column;
  border-radius: 18px;
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  background: linear-gradient(180deg, rgba(13, 14, 32, 0.98), rgba(7, 8, 18, 0.98));
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.65);
  overflow: hidden;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border-subtle);
`;

const Title = styled.h3`
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-soft);
`;

const Subtext = styled.p`
  margin: 6px 0 0;
  color: var(--foreground-muted);
  font-size: 12px;
`;

const CloseButton = styled.button`
  border: 1px solid rgba(var(--primary-rgb), 0.25);
  background: rgba(255, 255, 255, 0.03);
  color: var(--foreground);
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  cursor: pointer;
`;

const Body = styled.div`
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 0;
  flex: 1;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
`;

const Sidebar = styled.div`
  padding: 16px;
  border-right: 1px solid rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  gap: 12px;

  @media (max-width: 900px) {
    border-right: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
`;

const Main = styled.div`
  min-width: 0;
  overflow: auto;
  padding: 16px;
`;

const ToggleRow = styled.label`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(var(--primary-rgb), 0.12);
  color: var(--foreground-muted);
  font-size: 13px;
`;

const MemoryCard = styled.div`
  border-radius: 14px;
  border: 1px solid rgba(var(--primary-rgb), 0.12);
  background: rgba(255, 255, 255, 0.03);
  padding: 14px;
  margin-bottom: 12px;
`;

const SectionTitle = styled.h4`
  margin: 0 0 10px;
  color: var(--accent-soft);
  letter-spacing: 0.06em;
  font-size: 12px;
  text-transform: uppercase;
`;

const Text = styled.div`
  color: var(--foreground-muted);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const ItemMeta = styled.div`
  margin-top: 8px;
  color: var(--foreground-muted);
  font-size: 11px;
`;

const ActionRow = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
`;

const ActionButton = styled.button`
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  background: rgba(0, 0, 0, 0.18);
  color: var(--foreground);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
`;

const EmptyState = styled.div`
  padding: 18px;
  color: var(--foreground-muted);
  text-align: center;
`;

const InlineEditor = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-bottom: 14px;
  border-radius: 14px;
  border: 1px solid rgba(var(--primary-rgb), 0.16);
  background: rgba(var(--primary-rgb), 0.05);
`;

const FieldRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
`;

const Field = styled.input`
  flex: 1;
  min-width: 160px;
  box-sizing: border-box;
  border-radius: 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.2);
  background: rgba(0, 0, 0, 0.22);
  color: var(--foreground);
  padding: 9px 10px;
  font-size: 12px;
  font-family: inherit;
`;

const TextArea = styled.textarea`
  width: 100%;
  box-sizing: border-box;
  min-height: 92px;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.2);
  background: rgba(0, 0, 0, 0.22);
  color: var(--foreground);
  padding: 9px 10px;
  font-size: 12px;
  font-family: inherit;
`;

const Select = styled.select`
  border-radius: 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.2);
  background: rgba(0, 0, 0, 0.22);
  color: var(--foreground);
  padding: 9px 10px;
  font-size: 12px;
  font-family: inherit;
`;

const ErrorText = styled.div`
  color: #ff8f8f;
  font-size: 12px;
`;

const MEMORY_LAYERS = ['profile', 'episodic', 'project', 'semantic', 'procedural', 'temporal'];

const WorkspaceMemoryModal = ({ isOpen, onClose }) => {
  const {
    fetchMemoryDashboard,
    updateMemoryPreferences,
    createMemoryFact,
    updateMemoryFact,
    deleteMemoryFact,
    updateSemanticMemory,
    deleteSemanticMemory
  } = useConversation();
  const { activeWorkspaceId, workspaceRevision } = useWorkspace();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [memoryData, setMemoryData] = useState({ facts: [], memories: [], preferences: { memoryLearningEnabled: true } });
  const [newFact, setNewFact] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState('');

  const loadDashboard = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchMemoryDashboard();
      setMemoryData({
        facts: Array.isArray(data?.facts) ? data.facts : [],
        memories: Array.isArray(data?.memories) ? data.memories : [],
        preferences: data?.preferences || { memoryLearningEnabled: true }
      });
    } catch (err) {
      setError(err?.message || 'Failed to load memory workspace');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    loadDashboard();
  }, [isOpen, activeWorkspaceId, workspaceRevision]);

  const sortedFacts = useMemo(() => [...memoryData.facts].sort((left, right) => Number(right.pinned) - Number(left.pinned)), [memoryData.facts]);
  const sortedMemories = useMemo(() => [...memoryData.memories].sort((left, right) => Number(right.pinned) - Number(left.pinned)), [memoryData.memories]);

  const handleToggleLearning = async () => {
    const nextValue = !memoryData.preferences.memoryLearningEnabled;
    await updateMemoryPreferences(nextValue);
    setMemoryData((prev) => ({
      ...prev,
      preferences: {
        ...(prev.preferences || {}),
        memoryLearningEnabled: nextValue
      }
    }));
  };

  const handleAddFact = async () => {
    const factText = newFact.trim();
    if (!factText || addBusy) return;
    setAddBusy(true);
    setAddError('');
    try {
      await createMemoryFact({
        fact: factText,
        category: newCategory.trim() || 'general'
      });
      setNewFact('');
      setNewCategory('');
      await loadDashboard();
    } catch (err) {
      setAddError(err?.message || 'Failed to add fact');
    } finally {
      setAddBusy(false);
    }
  };

  const startEditFact = (fact) => {
    setEditError('');
    setEditing({
      kind: 'fact',
      id: fact._id,
      fact: fact.fact || '',
      category: fact.category || 'general',
      layer: fact.layer || 'semantic'
    });
  };

  const startEditMemory = (memory) => {
    setEditError('');
    setEditing({
      kind: 'memory',
      id: memory._id,
      query: memory.query || '',
      response: memory.response || '',
      tags: Array.isArray(memory.tags) ? memory.tags.join(', ') : '',
      layer: memory.layer || 'episodic'
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError('');
    try {
      if (editing.kind === 'fact') {
        await updateMemoryFact(editing.id, {
          fact: editing.fact,
          category: editing.category,
          layer: editing.layer
        });
      } else {
        await updateSemanticMemory(editing.id, {
          query: editing.query,
          response: editing.response,
          layer: editing.layer,
          tags: editing.tags.split(',').map((value) => value.trim()).filter(Boolean)
        });
      }
      setEditing(null);
      await loadDashboard();
    } catch (err) {
      setEditError(err?.message || 'Failed to save changes');
    }
  };

  if (!isOpen) return null;

  return (
    <Overlay onClick={onClose}>
      <Panel onClick={(event) => event.stopPropagation()}>
        <Header>
          <div>
            <Title>Memory Workspace</Title>
            <Subtext>Inspect, pin, edit, or remove remembered context.</Subtext>
          </div>
          <CloseButton type="button" onClick={onClose}>×</CloseButton>
        </Header>
        <Body>
          <Sidebar>
            <ToggleRow>
              <span>Auto memory learning</span>
              <input type="checkbox" checked={Boolean(memoryData.preferences.memoryLearningEnabled)} onChange={handleToggleLearning} />
            </ToggleRow>
            <div style={{ color: 'var(--foreground-muted)', fontSize: '12px', lineHeight: 1.55 }}>
              Conversation history stays separate from user facts and semantic memories. Auto-learning only controls whether ARC-AI writes new memory entries from ongoing chats.
            </div>
            <div style={{ color: 'var(--foreground-muted)', fontSize: '11px', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--foreground)' }}>Memory layers</strong>
              <div>profile · episodic · project · semantic · procedural · temporal</div>
            </div>
          </Sidebar>
          <Main>
            {loading && <EmptyState>Loading memories...</EmptyState>}
            {!loading && error && <EmptyState>{error}</EmptyState>}
            {!loading && !error && (
              <>
                {editing ? (
                  <InlineEditor>
                    <SectionTitle>{editing.kind === 'fact' ? 'Edit fact' : 'Edit memory'}</SectionTitle>
                    {editing.kind === 'fact' ? (
                      <>
                        <Field
                          value={editing.fact}
                          placeholder="Fact"
                          onChange={(event) => setEditing((prev) => ({ ...prev, fact: event.target.value }))}
                        />
                        <FieldRow>
                          <Field
                            value={editing.category}
                            placeholder="Category"
                            onChange={(event) => setEditing((prev) => ({ ...prev, category: event.target.value }))}
                          />
                          <Select
                            value={editing.layer}
                            onChange={(event) => setEditing((prev) => ({ ...prev, layer: event.target.value }))}
                          >
                            {MEMORY_LAYERS.map((layer) => <option key={layer} value={layer}>{layer}</option>)}
                          </Select>
                        </FieldRow>
                      </>
                    ) : (
                      <>
                        <Field
                          value={editing.query}
                          placeholder="Memory query"
                          onChange={(event) => setEditing((prev) => ({ ...prev, query: event.target.value }))}
                        />
                        <TextArea
                          value={editing.response}
                          placeholder="Memory response"
                          onChange={(event) => setEditing((prev) => ({ ...prev, response: event.target.value }))}
                        />
                        <FieldRow>
                          <Field
                            value={editing.tags}
                            placeholder="Tags (comma-separated)"
                            onChange={(event) => setEditing((prev) => ({ ...prev, tags: event.target.value }))}
                          />
                          <Select
                            value={editing.layer}
                            onChange={(event) => setEditing((prev) => ({ ...prev, layer: event.target.value }))}
                          >
                            {MEMORY_LAYERS.map((layer) => <option key={layer} value={layer}>{layer}</option>)}
                          </Select>
                        </FieldRow>
                      </>
                    )}
                    {editError ? <ErrorText role="alert">{editError}</ErrorText> : null}
                    <ActionRow>
                      <ActionButton type="button" onClick={saveEdit}>Save changes</ActionButton>
                      <ActionButton type="button" onClick={() => { setEditing(null); setEditError(''); }}>Cancel</ActionButton>
                    </ActionRow>
                  </InlineEditor>
                ) : null}

                <SectionTitle>Add a fact</SectionTitle>
                <InlineEditor>
                  <Field
                    value={newFact}
                    placeholder="e.g. I prefer concise status updates"
                    onChange={(event) => setNewFact(event.target.value)}
                  />
                  <FieldRow>
                    <Field
                      value={newCategory}
                      placeholder="Category (preferences, work, family…)"
                      onChange={(event) => setNewCategory(event.target.value)}
                    />
                    <ActionButton type="button" disabled={!newFact.trim() || addBusy} onClick={handleAddFact}>
                      {addBusy ? 'Saving…' : 'Add fact'}
                    </ActionButton>
                  </FieldRow>
                  {addError ? <ErrorText role="alert">{addError}</ErrorText> : null}
                </InlineEditor>

                <SectionTitle>Remembered facts</SectionTitle>
                {sortedFacts.length === 0 ? <EmptyState>No user facts saved yet.</EmptyState> : sortedFacts.map((fact) => (
                  <MemoryCard key={fact._id}>
                    <Text>{fact.fact}</Text>
                    <ItemMeta>Layer: {fact.layer || 'semantic'} · Category: {fact.category || 'general'} · {fact.pinned ? 'Pinned' : 'Unpinned'}</ItemMeta>
                    <ActionRow>
                      <ActionButton type="button" onClick={async () => { await updateMemoryFact(fact._id, { pinned: !fact.pinned }); await loadDashboard(); }}>
                        {fact.pinned ? 'Unpin' : 'Pin'}
                      </ActionButton>
                      <ActionButton type="button" onClick={() => startEditFact(fact)}>Edit</ActionButton>
                      <ActionButton type="button" onClick={async () => { await deleteMemoryFact(fact._id); await loadDashboard(); }}>Delete</ActionButton>
                    </ActionRow>
                  </MemoryCard>
                ))}

                <SectionTitle>Semantic memories</SectionTitle>
                {sortedMemories.length === 0 ? <EmptyState>No semantic memories stored yet.</EmptyState> : sortedMemories.map((memory) => (
                  <MemoryCard key={memory._id}>
                    <Text>{memory.query}</Text>
                    <ItemMeta>Layer: {memory.layer || 'episodic'} · Source: {memory.source || 'conversation'} · {memory.pinned ? 'Pinned' : 'Unpinned'} · Tags: {(memory.tags || []).join(', ') || 'none'}</ItemMeta>
                    <Text style={{ marginTop: '10px', color: 'var(--foreground)' }}>{memory.response}</Text>
                    <ActionRow>
                      <ActionButton type="button" onClick={async () => { await updateSemanticMemory(memory._id, { pinned: !memory.pinned }); await loadDashboard(); }}>
                        {memory.pinned ? 'Unpin' : 'Pin'}
                      </ActionButton>
                      <ActionButton type="button" onClick={() => startEditMemory(memory)}>Edit</ActionButton>
                      <ActionButton type="button" onClick={async () => { await deleteSemanticMemory(memory._id); await loadDashboard(); }}>Delete</ActionButton>
                    </ActionRow>
                  </MemoryCard>
                ))}
              </>
            )}
          </Main>
        </Body>
      </Panel>
    </Overlay>
  );
};

export default WorkspaceMemoryModal;
