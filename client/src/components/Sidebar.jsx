import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useConversation } from '../contexts/ConversationContext';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { Button as UiButton, Input as UiInput } from './ui';

const SIDEBAR_RAIL_WIDTH = 68;
const SIDEBAR_FULL_WIDTH = 280;

const SidebarWrapper = styled.div`
  display: flex;
  flex-direction: column;
  width: ${({ $collapsed }) => ($collapsed ? `${SIDEBAR_RAIL_WIDTH}px` : `${SIDEBAR_FULL_WIDTH}px`)};
  height: 100%;
  min-height: 0;
  background: var(--surface);
  border-right: 1px solid var(--border-subtle);
  transition: width 0.25s ease, transform 0.25s ease;
  overflow: hidden;

  @media (max-width: 999px) {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 1000;
    width: 280px;
    height: 100vh;
    height: 100dvh;
    max-height: 100dvh;
    transform: translateX(${props => props.$isOpen ? '0' : '-100%'});
    box-shadow: 4px 0 32px rgba(0, 0, 0, 0.7);
  }
`;

const SidebarCore = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
`;

const SidebarHeader = styled.div`
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-subtle);
`;

const Logo = styled.div`
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: linear-gradient(135deg, var(--primary-hex), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const RailLogo = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.12), rgba(var(--violet-rgb), 0.08));
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  color: var(--primary-hex);
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: all 0.2s;
  &:hover { border-color: rgba(var(--primary-rgb), 0.35); }
`;

const ToggleButton = styled.button`
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--foreground-subtle);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all 0.2s;
  &:hover { color: var(--foreground); background: rgba(255, 255, 255, 0.05); }
  @media (max-width: 999px) { display: none; }
`;

const CloseButton = styled.button`
  display: none;
  background: none;
  border: none;
  color: var(--foreground-muted);
  font-size: 22px;
  cursor: pointer;
  padding: 0;
  transition: color 0.2s;
  &:hover { color: var(--foreground); }
  @media (max-width: 999px) { display: block; }
`;

const TopActions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  flex-shrink: 0;
  ${({ $collapsed }) => $collapsed && `
    align-items: center;
    padding: 12px 8px;
  `}
`;

const NewChatButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(var(--primary-rgb), 0.2);
  background: rgba(var(--primary-rgb), 0.06);
  color: var(--primary-hex);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  &:hover { background: rgba(var(--primary-rgb), 0.12); border-color: rgba(var(--primary-rgb), 0.35); }
  ${({ $collapsed }) => $collapsed && `
    padding: 10px 0;
    font-size: 18px;
  `}
`;

const SearchWrapper = styled.div`
  padding: 0 12px;
  flex-shrink: 0;
  position: relative;
  z-index: 5;
`;

const SearchDropdown = styled.div`
  position: absolute;
  top: calc(100% + 4px);
  left: 12px;
  right: 12px;
  max-height: 300px;
  overflow-y: auto;
  z-index: 30;
  background: var(--surface-overlay);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.5);
`;

const SearchItem = styled.button`
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--foreground);
  cursor: pointer;
  transition: background 0.15s;
  &:hover { background: rgba(255, 255, 255, 0.04); }
  &:last-child { border-bottom: none; }
`;

const SearchItemType = styled.div`
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 2px;
`;

const ConversationSection = styled.div`
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  display: ${({ $collapsed }) => ($collapsed ? 'none' : 'flex')};
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
`;

const ConversationItem = styled.button`
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: ${({ $active }) => ($active ? 'rgba(var(--primary-rgb), 0.06)' : 'transparent')};
  cursor: pointer;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  position: relative;
  &:hover { background: rgba(255, 255, 255, 0.04); }
`;

const ConvTitle = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: ${({ $active }) => ($active ? 'var(--foreground)' : 'var(--foreground-muted)')};
  font-weight: ${({ $active }) => ($active ? '600' : '400')};
`;

const ConvDate = styled.span`
  font-size: 10px;
  color: var(--foreground-subtle);
  white-space: nowrap;
  flex-shrink: 0;
`;

const DeleteButton = styled.span`
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: rgba(var(--destructive-rgb), 0.15);
  color: var(--destructive);
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  ${ConversationItem}:hover & {
    opacity: 1;
    pointer-events: auto;
  }
  &:focus-visible {
    opacity: 1;
    pointer-events: auto;
    outline: 2px solid rgba(var(--destructive-rgb), 0.6);
    outline-offset: 1px;
  }
  &:hover { background: rgba(var(--destructive-rgb), 0.25); }
`;

const EmptyState = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  color: var(--foreground-subtle);
  font-size: 12px;
  line-height: 1.6;
`;

const SectionLabel = styled.div`
  padding: 10px 14px 4px;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--foreground-subtle);
  font-weight: 700;
  flex-shrink: 0;
`;

const NavButton = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover { background: rgba(255, 255, 255, 0.04); color: var(--foreground); }
`;

const NavDivider = styled.div`
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 8px 12px 4px;
  flex-shrink: 0;
`;

const NavSection = styled.div`
  padding: 4px 8px 0;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const BottomSection = styled.div`
  flex-shrink: 0;
  border-top: 1px solid var(--border-subtle);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  ${({ $collapsed }) => $collapsed && `
    align-items: center;
    padding: 8px;
  `}
`;

const BottomButton = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover { background: rgba(255, 255, 255, 0.04); color: var(--foreground); }
  ${({ $collapsed }) => $collapsed && `
    justify-content: center;
    padding: 10px 0;
    font-size: 0;
    &::before { content: attr(data-icon); font-size: 16px; }
  `}
`;

const BottomIcon = styled.span`
  width: 20px;
  text-align: center;
  font-size: 14px;
  flex-shrink: 0;
`;

const RailConversationList = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
`;

const RailConvButton = styled.button`
  width: 44px;
  height: 44px;
  border-radius: 10px;
  border: 1px solid ${({ $active }) => ($active ? 'rgba(var(--primary-rgb), 0.35)' : 'var(--border-subtle)')};
  background: ${({ $active }) => ($active ? 'rgba(var(--primary-rgb), 0.08)' : 'transparent')};
  color: ${({ $active }) => ($active ? 'var(--primary-hex)' : 'var(--foreground-muted)')};
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  position: relative;
  &:hover { background: rgba(255, 255, 255, 0.04); border-color: var(--border); }
`;

const RailTooltipHost = styled.div`
  position: relative;
  display: flex;
  justify-content: center;
  width: 100%;
  &:hover > span { opacity: 1; transform: translateX(0); }
`;

const RailTooltip = styled.span`
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateX(-4px) translateY(-50%);
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--surface-overlay);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
  transition: opacity 0.15s, transform 0.15s;
  z-index: 20;
`;

const ConfirmOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 16px;
`;

const ConfirmModal = styled.div`
  width: min(340px, 100%);
  background: var(--surface-overlay);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 20px;
`;

const ConfirmTitle = styled.h4`
  margin: 0;
  font-size: 15px;
  color: var(--foreground);
`;

const ConfirmText = styled.p`
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--foreground-muted);
  line-height: 1.5;
`;

const ConfirmActions = styled.div`
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`;

const formatDate = (date) => {
  const d = new Date(date);
  const now = new Date();
  const diff = now - d;
  if (diff < 3600000) return 'Now';
  if (diff < 86400000) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diff < 604800000) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const Sidebar = ({
  isOpen = true,
  collapsed = false,
  onToggleCollapse = () => {},
  onClose = () => {},
  onCommandPaletteClick = () => {},
  onOpenSettings = () => {},
  onOpenTools = () => {},
  onOpenAccount = () => {},
  searchFocusToken = 0,
}) => {
  const {
    conversations, activeConversationId, loadingConversations,
    createNewConversation, switchConversation, deleteConversation,
    searchWorkspace, setFocusedMessageId
  } = useConversation();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const searchInputRef = React.useRef(null);

  useEffect(() => {
    if (searchFocusToken > 0) {
      searchInputRef.current?.focus();
    }
  }, [searchFocusToken]);

  const handleNewChat = async () => {
    try { await createNewConversation(); onClose(); } catch (e) { console.error(e); }
  };

  useEffect(() => {
    const q = String(searchQuery || '').trim();
    if (!q) { setSearchResults([]); return; }
    let cancelled = false;
    setSearchLoading(true);
    const timer = setTimeout(() => {
      searchWorkspace(q, { limit: 6 })
        .then(r => { if (!cancelled) setSearchResults(Array.isArray(r?.items) ? r.items : []); })
        .catch(() => { if (!cancelled) setSearchResults([]); })
        .finally(() => { if (!cancelled) setSearchLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery, searchWorkspace]);

  const handleSearchSelect = (item) => {
    if (item?.conversationId) switchConversation(item.conversationId);
    if (item?.messageId && setFocusedMessageId) setFocusedMessageId(item.messageId);
    onClose();
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleDelete = (e, conv) => { e.stopPropagation(); setPendingDelete(conv); };

  const handleConfirmDelete = async () => {
    if (!pendingDelete?._id || isDeleting) return;
    try { setIsDeleting(true); await deleteConversation(pendingDelete._id); setPendingDelete(null); }
    catch (e) { console.error(e); }
    finally { setIsDeleting(false); }
  };

  if (collapsed) {
    return (
      <SidebarWrapper $isOpen={isOpen} $collapsed>
        <SidebarCore>
          <div style={{ padding: '10px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <RailTooltipHost>
              <RailLogo onClick={onToggleCollapse}>A</RailLogo>
              <RailTooltip>Expand sidebar</RailTooltip>
            </RailTooltipHost>
            <RailTooltipHost>
              <NewChatButton $collapsed onClick={handleNewChat} aria-label="New Chat">+</NewChatButton>
              <RailTooltip>New Chat</RailTooltip>
            </RailTooltipHost>
            <RailTooltipHost>
              <BottomButton $collapsed data-icon="⌘" onClick={onCommandPaletteClick} aria-label="Command Palette" />
              <RailTooltip>Commands (Ctrl K)</RailTooltip>
            </RailTooltipHost>
            <RailTooltipHost>
              <BottomButton $collapsed data-icon="🛠️" onClick={() => { onOpenTools(); onClose(); }} aria-label="Tools" />
              <RailTooltip>Tools</RailTooltip>
            </RailTooltipHost>
          </div>

          <div style={{ width: '24px', height: '1px', background: 'var(--border-subtle)', margin: '4px auto' }} />

          <RailConversationList>
            {loadingConversations && (
              <div style={{ color: 'var(--foreground-subtle)', fontSize: 11, padding: '8px 0' }}>...</div>
            )}
            {conversations.map(conv => (
              <RailTooltipHost key={conv._id}>
                <RailConvButton
                  $active={activeConversationId === conv._id}
                  onClick={() => switchConversation(conv._id)}
                  aria-label={conv.title || 'Conversation'}
                >
                  {(conv.title || 'A').charAt(0).toUpperCase()}
                </RailConvButton>
                <RailTooltip>{conv.title || 'Conversation'}</RailTooltip>
              </RailTooltipHost>
            ))}
          </RailConversationList>

          <div style={{ padding: '8px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <RailTooltipHost>
              <BottomButton $collapsed data-icon="⚙" onClick={onOpenSettings} aria-label="Settings" />
              <RailTooltip>Settings</RailTooltip>
            </RailTooltipHost>
            <RailTooltipHost>
              <BottomButton $collapsed data-icon="👤" onClick={onOpenAccount} aria-label="Account" />
              <RailTooltip>Account</RailTooltip>
            </RailTooltipHost>
          </div>
        </SidebarCore>
      </SidebarWrapper>
    );
  }

  return (
    <SidebarWrapper $isOpen={isOpen} $collapsed={collapsed}>
      <SidebarCore>
        <SidebarHeader>
          <Logo>ARC-AI</Logo>
          <div style={{ display: 'flex', gap: 4 }}>
            <ToggleButton onClick={onToggleCollapse} aria-label="Collapse sidebar">‹</ToggleButton>
            <CloseButton onClick={onClose}>×</CloseButton>
          </div>
        </SidebarHeader>

        <TopActions>
          <NewChatButton onClick={handleNewChat} aria-label="New Chat">
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
            New Chat
          </NewChatButton>
        </TopActions>

        <SearchWrapper>
          <UiInput
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            aria-label="Search conversations"
          />
          {(searchLoading || searchResults.length > 0 || (searchQuery.trim() && !searchLoading)) && (
            <SearchDropdown>
              {searchLoading && <div style={{ padding: 10, color: 'var(--foreground-subtle)', fontSize: 12 }}>Searching...</div>}
              {!searchLoading && searchResults.length === 0 && searchQuery.trim() && (
                <div style={{ padding: 10, color: 'var(--foreground-subtle)', fontSize: 12 }}>No results</div>
              )}
              {searchResults.map(item => (
                <SearchItem key={item.id} onClick={() => handleSearchSelect(item)}>
                  <SearchItemType style={{ color: item.type === 'conversation' ? 'var(--primary-hex)' : item.type === 'message' ? 'var(--warning)' : 'var(--violet)' }}>
                    {item.type}
                  </SearchItemType>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{item.title || item.snippet || 'Result'}</div>
                </SearchItem>
              ))}
            </SearchDropdown>
          )}
        </SearchWrapper>

        <div style={{ height: 8 }} />

        <SectionLabel>Chats</SectionLabel>
        <ConversationSection>
          {loadingConversations && <EmptyState>Loading...</EmptyState>}
          {!loadingConversations && conversations.length === 0 && (
            <EmptyState>No conversations yet.<br />Start a new chat to begin.</EmptyState>
          )}
          {conversations.map(conv => (
            <ConversationItem
              key={conv._id}
              $active={activeConversationId === conv._id}
              onClick={() => { switchConversation(conv._id); onClose(); }}
              onMouseEnter={() => {}}
              onMouseLeave={() => {}}
            >
              <ConvTitle $active={activeConversationId === conv._id}>{conv.title}</ConvTitle>
              <ConvDate>{formatDate(conv.updatedAt)}</ConvDate>
              <DeleteButton
                role="button"
                tabIndex={0}
                aria-label={`Delete ${conv.title || 'conversation'}`}
                onClick={e => handleDelete(e, conv)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setPendingDelete(conv); } }}
                title="Delete"
              >×</DeleteButton>
            </ConversationItem>
          ))}
        </ConversationSection>

        <SectionLabel>Workspaces</SectionLabel>
        <div style={{ padding: '0 12px 4px', flexShrink: 0 }}>
          <WorkspaceSwitcher />
        </div>

        <NavDivider />
        <NavSection>
          <NavButton onClick={() => { onOpenTools(); onClose(); }} aria-label="Open tools">
            <BottomIcon>🛠️</BottomIcon>
            <span>Tools</span>
          </NavButton>
          <NavButton onClick={onCommandPaletteClick} aria-label="Open command palette">
            <BottomIcon>⌘</BottomIcon>
            <span>Commands</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--foreground-subtle)' }}>Ctrl K</span>
          </NavButton>
        </NavSection>

        <BottomSection>
          <BottomButton onClick={onOpenSettings} aria-label="Settings">
            <BottomIcon>⚙</BottomIcon>
            <span>Settings</span>
          </BottomButton>
          <BottomButton onClick={onOpenAccount} aria-label="Account">
            <BottomIcon>👤</BottomIcon>
            <span>Account</span>
          </BottomButton>
        </BottomSection>
      </SidebarCore>

      {pendingDelete && (
        <ConfirmOverlay onClick={() => !isDeleting && setPendingDelete(null)}>
          <ConfirmModal onClick={e => e.stopPropagation()}>
            <ConfirmTitle>Delete conversation?</ConfirmTitle>
            <ConfirmText>This will remove the conversation from your history.</ConfirmText>
            <ConfirmActions>
              <UiButton variant="ghost" onClick={() => setPendingDelete(null)} disabled={isDeleting}>Cancel</UiButton>
              <UiButton variant="danger-outline" onClick={handleConfirmDelete} disabled={isDeleting}>{isDeleting ? 'Deleting...' : 'Delete'}</UiButton>
            </ConfirmActions>
          </ConfirmModal>
        </ConfirmOverlay>
      )}
    </SidebarWrapper>
  );
};
