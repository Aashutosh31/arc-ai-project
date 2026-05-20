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
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const Title = styled.h3`
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #7df7ff;
`;

const Subtext = styled.p`
  margin: 6px 0 0;
  color: #a8b5d8;
  font-size: 12px;
`;

const CloseButton = styled.button`
  border: 1px solid rgba(var(--primary-rgb), 0.25);
  background: rgba(255, 255, 255, 0.03);
  color: #f4fbff;
  width: 40px;
  height: 40px;
  border-radius: 12px;
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
  color: #dbe5ff;
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
  color: #7df7ff;
  letter-spacing: 0.06em;
  font-size: 12px;
  text-transform: uppercase;
`;

const Text = styled.div`
  color: #dbe5ff;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const ItemMeta = styled.div`
  margin-top: 8px;
  color: #8fa2cf;
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
  color: #effcff;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12px;
  cursor: pointer;
`;

const EmptyState = styled.div`
  padding: 18px;
  color: #94a4cb;
  text-align: center;
`;

const WorkspaceMemoryModal = ({ isOpen, onClose }) => {
  const {
    fetchMemoryDashboard,
    updateMemoryPreferences,
    updateMemoryFact,
    deleteMemoryFact,
    updateSemanticMemory,
    deleteSemanticMemory
  } = useConversation();
  const { activeWorkspaceId, workspaceRevision } = useWorkspace();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [memoryData, setMemoryData] = useState({ facts: [], memories: [], preferences: { memoryLearningEnabled: true } });

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

  const handleEditFact = async (fact) => {
    const nextFact = window.prompt('Edit this fact', fact.fact || '');
    if (nextFact === null) return;
    const nextCategory = window.prompt('Category', fact.category || 'general');
    if (nextCategory === null) return;
    await updateMemoryFact(fact._id, { fact: nextFact, category: nextCategory });
    await loadDashboard();
  };

  const handleEditMemory = async (memory) => {
    const nextQuery = window.prompt('Edit memory query', memory.query || '');
    if (nextQuery === null) return;
    const nextResponse = window.prompt('Edit memory response', memory.response || '');
    if (nextResponse === null) return;
    const nextTags = window.prompt('Tags (comma-separated)', Array.isArray(memory.tags) ? memory.tags.join(', ') : '');
    if (nextTags === null) return;
    await updateSemanticMemory(memory._id, { query: nextQuery, response: nextResponse, tags: nextTags.split(',').map((value) => value.trim()).filter(Boolean) });
    await loadDashboard();
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
            <div style={{ color: '#8fa2cf', fontSize: '12px', lineHeight: 1.55 }}>
              Conversation history stays separate from user facts and semantic memories. Auto-learning only controls whether ARC-AI writes new memory entries from ongoing chats.
            </div>
          </Sidebar>
          <Main>
            {loading && <EmptyState>Loading memories...</EmptyState>}
            {!loading && error && <EmptyState>{error}</EmptyState>}
            {!loading && !error && (
              <>
                <SectionTitle>Remembered facts</SectionTitle>
                {sortedFacts.length === 0 ? <EmptyState>No user facts saved yet.</EmptyState> : sortedFacts.map((fact) => (
                  <MemoryCard key={fact._id}>
                    <Text>{fact.fact}</Text>
                    <ItemMeta>Category: {fact.category || 'general'} · {fact.pinned ? 'Pinned' : 'Unpinned'}</ItemMeta>
                    <ActionRow>
                      <ActionButton type="button" onClick={async () => { await updateMemoryFact(fact._id, { pinned: !fact.pinned }); await loadDashboard(); }}>
                        {fact.pinned ? 'Unpin' : 'Pin'}
                      </ActionButton>
                      <ActionButton type="button" onClick={() => handleEditFact(fact)}>Edit</ActionButton>
                      <ActionButton type="button" onClick={async () => { await deleteMemoryFact(fact._id); await loadDashboard(); }}>Delete</ActionButton>
                    </ActionRow>
                  </MemoryCard>
                ))}

                <SectionTitle>Semantic memories</SectionTitle>
                {sortedMemories.length === 0 ? <EmptyState>No semantic memories stored yet.</EmptyState> : sortedMemories.map((memory) => (
                  <MemoryCard key={memory._id}>
                    <Text>{memory.query}</Text>
                    <ItemMeta>{memory.pinned ? 'Pinned' : 'Unpinned'} · Tags: {(memory.tags || []).join(', ') || 'none'}</ItemMeta>
                    <Text style={{ marginTop: '10px', color: '#cdd7f5' }}>{memory.response}</Text>
                    <ActionRow>
                      <ActionButton type="button" onClick={async () => { await updateSemanticMemory(memory._id, { pinned: !memory.pinned }); await loadDashboard(); }}>
                        {memory.pinned ? 'Unpin' : 'Pin'}
                      </ActionButton>
                      <ActionButton type="button" onClick={() => handleEditMemory(memory)}>Edit</ActionButton>
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
