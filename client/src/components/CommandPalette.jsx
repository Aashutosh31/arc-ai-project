import React, { useEffect, useRef, useState, useMemo } from 'react';
import styled from 'styled-components';
import { useWorkspace } from '../contexts/WorkspaceContext';

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 2500;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 16px;
`;

const Palette = styled.div`
  width: min(600px, 100%);
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: linear-gradient(180deg, var(--surface-elevated), var(--surface));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
`;

const SearchInput = styled.input`
  width: 100%;
  padding: 16px 18px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--foreground);
  font-size: 15px;
  outline: none;
  &::placeholder { color: var(--foreground-subtle); }
`;

const ResultsList = styled.div`
  max-height: 400px;
  overflow-y: auto;
  padding: 8px;
`;

const ResultItem = styled.button`
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: none;
  background: ${({ $focused }) => ($focused ? 'rgba(var(--primary-rgb), 0.08)' : 'transparent')};
  color: var(--foreground);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: background 0.15s;
  &:hover { background: rgba(var(--primary-rgb), 0.06); }
`;

const ResultIcon = styled.span`
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
`;

const ResultText = styled.div`
  min-width: 0;
  flex: 1;
`;

const ResultLabel = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
`;

const ResultHint = styled.div`
  font-size: 11px;
  color: var(--foreground-subtle);
  margin-top: 2px;
`;

const ActiveTag = styled.span`
  font-size: 10px;
  font-weight: 700;
  color: var(--success);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex-shrink: 0;
`;

const SectionLabel = styled.div`
  padding: 8px 12px 4px;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(var(--accent-soft-rgb), 0.5);
  font-weight: 700;
`;

const Footer = styled.div`
  padding: 10px 14px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--foreground-subtle);
`;

const Shortcut = styled.kbd`
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  font-size: 10px;
  font-family: inherit;
  color: var(--foreground-muted);
`;

const CommandPalette = ({
  isOpen,
  onClose,
  onNewChat,
  onSearchConversations,
  onOpenTools,
  onOpenMemory,
  onToggleMemoryLearning,
  onOpenVoice,
  onOpenVision,
  onOpenSettings,
  onOpenAccount,
  onOpenIntegrations,
  onLogout,
  memoryLearningEnabled,
}) => {
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const inputRef = useRef(null);
  const { workspaces, activeWorkspaceId, switchWorkspace } = useWorkspace();

  const runAndClose = (fn) => { try { fn?.(); } finally { onClose(); } };

  const staticCommands = useMemo(() => [
    { id: 'new-chat', icon: '+', label: 'New chat', hint: 'Start a fresh conversation', section: 'Actions', run: onNewChat },
    { id: 'search', icon: '🔍', label: 'Search conversations', hint: 'Focus sidebar search', section: 'Actions', run: onSearchConversations },
    { id: 'tools', icon: '🛠️', label: 'Open tools', hint: 'Browse what ARC can do', section: 'Tools', run: onOpenTools },
    { id: 'voice', icon: '🎤', label: 'Open voice mode', hint: 'Talk to ARC hands-free', section: 'Tools', run: onOpenVoice },
    { id: 'vision', icon: '📷', label: 'Open vision camera', hint: 'Attach live camera frames', section: 'Tools', run: onOpenVision },
    { id: 'memory', icon: '💾', label: 'Open memory manager', hint: 'Inspect and manage memories', section: 'Tools', run: onOpenMemory },
    { id: 'toggle-memory', icon: memoryLearningEnabled ? '⏸' : '▶', label: `${memoryLearningEnabled ? 'Disable' : 'Enable'} memory learning`, hint: 'Toggle auto-learning from conversations', section: 'Tools', run: onToggleMemoryLearning },
    { id: 'settings', icon: '⚙', label: 'Open settings', hint: 'Account, appearance, voice, model', section: 'Navigate', run: () => onOpenSettings?.('general') },
    { id: 'account', icon: '👤', label: 'Open account', hint: 'Identity, credits, sign out', section: 'Navigate', run: () => onOpenAccount?.() ?? onOpenSettings?.('account') },
    { id: 'integrations', icon: '🔗', label: 'Open integrations', hint: 'Google Calendar, WhatsApp', section: 'Navigate', run: () => onOpenIntegrations?.() ?? onOpenSettings?.('integrations') },
    { id: 'logout', icon: '⏻', label: 'Log out', hint: 'End this session', section: 'Session', run: onLogout },
  ], [onNewChat, onSearchConversations, onOpenTools, onOpenVoice, onOpenVision, onOpenMemory, onToggleMemoryLearning, onOpenSettings, onOpenAccount, onOpenIntegrations, onLogout, memoryLearningEnabled]);

  const workspaceCommands = useMemo(() => (workspaces || []).map(w => ({
    id: `ws-${w._id}`,
    icon: '📁',
    label: w.name || 'Workspace',
    hint: String(w._id) === String(activeWorkspaceId) ? 'Current workspace' : 'Switch to this workspace',
    section: 'Workspaces',
    active: String(w._id) === String(activeWorkspaceId),
    run: () => { if (String(w._id) !== String(activeWorkspaceId)) switchWorkspace(w._id); },
  })), [workspaces, activeWorkspaceId, switchWorkspace]);

  const allCommands = useMemo(() => [...staticCommands, ...workspaceCommands], [staticCommands, workspaceCommands]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const q = query.toLowerCase();
    return allCommands.filter(cmd =>
      cmd.label.toLowerCase().includes(q) || cmd.hint.toLowerCase().includes(q)
    );
  }, [query, allCommands]);

  const grouped = useMemo(() => {
    const groups = {};
    filtered.forEach(cmd => {
      if (!groups[cmd.section]) groups[cmd.section] = [];
      groups[cmd.section].push(cmd);
    });
    return groups;
  }, [filtered]);

  useEffect(() => { setFocusedIndex(0); }, [query]);

  useEffect(() => {
    if (isOpen) { setQuery(''); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocusedIndex(p => Math.min(p + 1, filtered.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFocusedIndex(p => Math.max(p - 1, 0)); }
      if (e.key === 'Enter') { e.preventDefault(); const cmd = filtered[focusedIndex]; if (cmd) runAndClose(cmd.run); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!isOpen) return null;

  let flatIndex = 0;

  return (
    <Overlay onClick={onClose} role="dialog" aria-label="Command palette">
      <Palette onClick={e => e.stopPropagation()}>
        <SearchInput
          ref={inputRef}
          type="text"
          placeholder="Type a command or search workspaces..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search commands"
        />
        <ResultsList role="listbox">
          {Object.entries(grouped).map(([section, commands]) => (
            <React.Fragment key={section}>
              <SectionLabel>{section}</SectionLabel>
              {commands.map(cmd => {
                const idx = flatIndex++;
                return (
                  <ResultItem
                    key={cmd.id}
                    role="option"
                    aria-selected={idx === focusedIndex}
                    $focused={idx === focusedIndex}
                    onClick={() => runAndClose(cmd.run)}
                    onMouseEnter={() => setFocusedIndex(idx)}
                  >
                    <ResultIcon>{cmd.icon}</ResultIcon>
                    <ResultText>
                      <ResultLabel>{cmd.label}</ResultLabel>
                      <ResultHint>{cmd.hint}</ResultHint>
                    </ResultText>
                    {cmd.active && <ActiveTag>Active</ActiveTag>}
                  </ResultItem>
                );
              })}
            </React.Fragment>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'rgba(255,255,255,0.35)', fontSize: '13px' }}>
              No matching commands
            </div>
          )}
        </ResultsList>
        <Footer>
          <span><Shortcut>↑↓</Shortcut> navigate</span>
          <span><Shortcut>↵</Shortcut> select</span>
          <span><Shortcut>esc</Shortcut> close</span>
        </Footer>
      </Palette>
    </Overlay>
  );
};

export default CommandPalette;
