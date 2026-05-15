import React, { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { useConversation } from '../contexts/ConversationContext';

const SidebarWrapper = styled.div`
  display: flex;
  flex-direction: column;
  width: ${({ $collapsed }) => ($collapsed ? '84px' : '280px')};
  height: 100%;
  background: linear-gradient(180deg, rgba(10, 10, 20, 0.95) 0%, rgba(15, 15, 30, 0.95) 100%);
  border-right: 2px solid rgba(var(--primary-rgb), 0.2);
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
  overflow: hidden;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);

  @media (max-width: 999px) {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 1000;
    width: 260px;
    height: 100vh;
    transform: translateX(${props => props.$isOpen ? '0' : '-100%'});
    box-shadow: 4px 0 32px rgba(0, 0, 0, 0.7);
  }

  @media (max-width: 480px) {
    width: 240px;
  }
`;

const SidebarHeader = styled.div`
  padding: 18px 16px;
  border-bottom: 1px solid rgba(var(--primary-rgb), 0.15);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;

  @media (max-width: 768px) {
    padding: 16px 14px;
  }
`;

const SidebarHeaderStack = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`;

const Logo = styled.div`
  font-size: 18px;
  font-weight: 700;
  color: var(--primary-hex);
  letter-spacing: 1px;
  text-transform: uppercase;
  background: linear-gradient(135deg, var(--primary-hex), var(--secondary-hex));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;

  @media (max-width: 768px) {
    font-size: 16px;
  }
`;

const LogoFull = styled.span`
  display: ${({ $collapsed }) => ($collapsed ? 'none' : 'inline')};

  @media (max-width: 768px) {
    display: inline;
  }
`;

const LogoCompact = styled.span`
  display: ${({ $collapsed }) => ($collapsed ? 'inline' : 'none')};

  @media (max-width: 768px) {
    display: none;
  }
`;

const SidebarToggleButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid rgba(var(--primary-rgb), 0.24);
  background: rgba(255, 255, 255, 0.04);
  color: var(--primary-hex);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(var(--primary-rgb), 0.12);
    border-color: rgba(var(--primary-rgb), 0.4);
  }

  @media (max-width: 768px) {
    display: none;
  }
`;

const NewChatButton = styled.button`
  padding: 10px 14px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.25), rgba(var(--secondary-rgb), 0.15));
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  border-radius: 8px;
  color: var(--primary-hex);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  white-space: nowrap;
  flex: 1;
  min-width: 0;

  &:hover {
    background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.35), rgba(var(--secondary-rgb), 0.25));
    border-color: rgba(var(--primary-rgb), 0.6);
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }

  ${({ $collapsed }) => $collapsed && `
    width: 100%;
    min-width: 44px;
    padding: 10px 0;
    font-size: 0;

    &::before {
      content: '+';
      font-size: 16px;
      font-weight: 700;
    }
  `}

  @media (max-width: 480px) {
    padding: 9px 12px;
    font-size: 12px;
  }
`;

const CommandPaletteButton = styled.button`
  padding: 10px 14px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.15), rgba(var(--secondary-rgb), 0.08));
  border: 1px solid rgba(var(--primary-rgb), 0.3);
  border-radius: 8px;
  color: var(--primary-hex);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  justify-content: center;

  &:hover {
    background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.25), rgba(var(--secondary-rgb), 0.15));
    border-color: rgba(var(--primary-rgb), 0.5);
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }

  ${({ $collapsed }) => $collapsed && `
    width: 100%;
    min-width: 44px;
    padding: 10px 0;
    font-size: 0;
    gap: 0;

    &::before {
      content: '⌘';
      font-size: 16px;
      font-weight: 700;
    }
  `}

  @media (max-width: 480px) {
    padding: 9px 12px;
    font-size: 12px;
    gap: 8px;
  }
`;

const ActionButtonsContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 12px 14px 12px;
  border-bottom: 1px solid rgba(var(--primary-rgb), 0.15);

  ${({ $collapsed }) => $collapsed && `
    align-items: stretch;
    padding: 12px 10px 12px 10px;
  `}

  @media (max-width: 768px) {
    gap: 9px;
    padding: 14px 10px 12px 10px;
  }

  @media (max-width: 480px) {
    gap: 8px;
    padding: 12px 8px 10px 8px;
  }
`;

const CommandPaletteIcon = styled.div`
  width: 24px;
  height: 24px;
  min-width: 24px;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.4), rgba(var(--secondary-rgb), 0.3));
  border: 1.5px solid rgba(var(--primary-rgb), 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--primary-hex);
  font-weight: 700;
`;

const ButtonLabel = styled.span`
  min-width: 0;

  ${({ $collapsed }) => $collapsed && `
    display: none;
  `}
`;

const CompactSearchHint = styled.div`
  display: ${({ $collapsed }) => ($collapsed ? 'flex' : 'none')};
  align-items: center;
  justify-content: center;
  padding: 14px 10px 12px;
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  text-align: center;
  border-bottom: 1px solid rgba(var(--primary-rgb), 0.15);
`;

const CloseButton = styled.button`
  display: none;
  background: none;
  border: none;
  color: var(--primary-hex);
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  transition: all 0.3s ease;

  &:hover {
    color: var(--secondary-hex);
  }

  @media (max-width: 999px) {
    display: block;
  }
`;

const ConversationListWrapper = styled.div`
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  display: ${({ $collapsed }) => ($collapsed ? 'none' : 'flex')};

  /* Custom scrollbar */
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 10px;
  }
  &::-webkit-scrollbar-thumb {
    background: rgba(var(--primary-rgb), 0.3);
    border-radius: 10px;

    &:hover {
      background: rgba(var(--primary-rgb), 0.5);
    }
  }

  @media (max-width: 480px) {
    padding: 10px 6px;
    gap: 5px;
  }
`;

const ConversationItem = styled.div`
  padding: 11px 12px;
  background: ${props =>
    props.$isActive
      ? 'linear-gradient(135deg, rgba(var(--primary-rgb), 0.2), rgba(var(--secondary-rgb), 0.1))'
      : 'rgba(255, 255, 255, 0.02)'};
  border: 1px solid ${props =>
    props.$isActive
      ? 'rgba(var(--primary-rgb), 0.4)'
      : 'rgba(var(--primary-rgb), 0.1)'};
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.25s ease;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  overflow: hidden;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(var(--primary-rgb), 0.25);
  }

  @media (max-width: 480px) {
    padding: 10px 10px;
    font-size: 13px;
  }
`;

const ConversationTitle = styled.div`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
  color: ${props => (props.$isActive ? 'var(--primary-hex)' : '#e0e0e0')};
  transition: color 0.3s ease;
`;

const ConversationMeta = styled.div`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  margin-top: 4px;
  line-height: 1.2;
`;

const DeleteButton = styled.button`
  padding: 4px 6px;
  background: rgba(255, 60, 60, 0.15);
  border: 1px solid rgba(255, 60, 60, 0.3);
  border-radius: 6px;
  color: #ff6b6b;
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s ease;
  flex-shrink: 0;

  ${ConversationItem}:hover & {
    opacity: 1;
  }

  &:hover {
    background: rgba(255, 60, 60, 0.25);
    border-color: rgba(255, 60, 60, 0.5);
  }

  @media (max-width: 480px) {
    opacity: 1;
    padding: 3px 5px;
    font-size: 10px;
  }
`;

const EmptyState = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 20px;
  text-align: center;
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;
  line-height: 1.6;
`;

const ConfirmOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 16px;
`;

const ConfirmModal = styled.div`
  width: min(360px, 100%);
  background: linear-gradient(180deg, rgba(16, 16, 36, 0.98), rgba(10, 10, 24, 0.98));
  border: 1px solid rgba(var(--primary-rgb), 0.35);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.55);
  border-radius: 14px;
  padding: 16px;
`;

const ConfirmTitle = styled.h4`
  margin: 0;
  font-size: 15px;
  color: #f6f8ff;
`;

const ConfirmText = styled.p`
  margin: 10px 0 0;
  font-size: 13px;
  color: #b8c2e8;
  line-height: 1.45;
`;

const ConfirmActions = styled.div`
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`;

const CancelButton = styled.button`
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.04);
  color: #e8ecff;
  font-size: 12px;
  cursor: pointer;
`;

const ConfirmDeleteButton = styled.button`
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 70, 70, 0.5);
  background: rgba(255, 70, 70, 0.15);
  color: #ff9f9f;
  font-size: 12px;
  cursor: pointer;
`;

const formatDate = (date) => {
  const d = new Date(date);
  const now = new Date();
  const diff = now - d;

  if (diff < 3600000) return 'Just now'; // < 1 hour
  if (diff < 86400000) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); // < 1 day
  if (diff < 604800000) return d.toLocaleDateString('en-US', { weekday: 'short' }); // < 7 days
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const Sidebar = ({
  isOpen = true,
  collapsed = false,
  onToggleCollapse = () => {},
  onClose = () => {},
  onCommandPaletteClick = () => {}
}) => {
  const {
    conversations,
    activeConversationId,
    loadingConversations,
    createNewConversation,
    switchConversation,
    deleteConversation,
    searchWorkspace,
    setFocusedMessageId
  } = useConversation();

  const [hoveredId, setHoveredId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleNewChat = async () => {
    try {
      await createNewConversation();
      onClose(); // Close sidebar on mobile after creating new chat
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  useEffect(() => {
    const query = String(searchQuery || '').trim();
    if (!query) {
      setSearchResults([]);
      setSearchError('');
      setSearchLoading(false);
      return undefined;
    }

    let isCancelled = false;
    setSearchLoading(true);
    setSearchError('');

    const timer = setTimeout(() => {
      searchWorkspace(query, { limit: 8 })
        .then((result) => {
          if (isCancelled) return;
          setSearchResults(Array.isArray(result?.items) ? result.items : []);
        })
        .catch((error) => {
          if (isCancelled) return;
          setSearchError(error?.message || 'Search failed');
          setSearchResults([]);
        })
        .finally(() => {
          if (!isCancelled) setSearchLoading(false);
        });
    }, 250);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchWorkspace]);

  const groupedSearchResults = useMemo(() => {
    const conversationsHit = searchResults.filter((item) => item.type === 'conversation');
    const messageHit = searchResults.filter((item) => item.type === 'message');
    const memoryHit = searchResults.filter((item) => item.type !== 'conversation' && item.type !== 'message');
    return { conversationsHit, messageHit, memoryHit };
  }, [searchResults]);

  const handleSearchSelect = (item) => {
    if (item?.conversationId) {
      switchConversation(item.conversationId);
    }
    if (item?.messageId && setFocusedMessageId) {
      setFocusedMessageId(item.messageId);
    }
    onClose();
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleDelete = async (e, conversationId) => {
    e.stopPropagation();
    const selectedConversation = conversations.find((conv) => conv._id === conversationId) || null;
    setPendingDeleteConversation(selectedConversation);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDeleteConversation?._id || isDeleting) return;

    try {
      setIsDeleting(true);
      await deleteConversation(pendingDeleteConversation._id);
      setPendingDeleteConversation(null);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <SidebarWrapper $isOpen={isOpen} $collapsed={collapsed}>
      <SidebarHeader>
        <SidebarHeaderStack>
          <Logo $collapsed={collapsed}>
            <LogoFull $collapsed={collapsed}>ARC-AI</LogoFull>
            <LogoCompact $collapsed={collapsed}>ARC</LogoCompact>
          </Logo>
        </SidebarHeaderStack>
        <SidebarToggleButton type="button" onClick={onToggleCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? '›' : '‹'}
        </SidebarToggleButton>
        <CloseButton onClick={onClose}>×</CloseButton>
      </SidebarHeader>

      <ActionButtonsContainer $collapsed={collapsed}>
        <NewChatButton $collapsed={collapsed} onClick={handleNewChat} aria-label="Start a new chat">
          <ButtonLabel $collapsed={collapsed}>+ New Chat</ButtonLabel>
        </NewChatButton>

        <CommandPaletteButton $collapsed={collapsed} onClick={onCommandPaletteClick} aria-label="Open command palette">
          <CommandPaletteIcon>⌘</CommandPaletteIcon>
          <ButtonLabel $collapsed={collapsed}>Command Palette</ButtonLabel>
        </CommandPaletteButton>
      </ActionButtonsContainer>

      <CompactSearchHint $collapsed={collapsed}>Search and conversations expand when you open the rail.</CompactSearchHint>

      <div style={{ padding: collapsed ? '0' : '12px 12px 0', position: 'relative', display: collapsed ? 'none' : 'block' }}>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search conversations, messages, memories"
          style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: '12px',
            border: '1px solid rgba(var(--primary-rgb), 0.28)',
            background: 'rgba(0,0,0,0.22)',
            color: '#f3fbff',
            outline: 'none',
            fontSize: '13px'
          }}
        />
        {(searchLoading || searchError || searchResults.length > 0) && (
          <div style={{
            marginTop: '10px',
            background: 'rgba(7, 10, 24, 0.96)',
            border: '1px solid rgba(var(--primary-rgb), 0.18)',
            borderRadius: '12px',
            overflow: 'hidden'
          }}>
            {searchLoading && <div style={{ padding: '10px 12px', color: '#9ddcff', fontSize: '12px' }}>Searching workspace...</div>}
            {!searchLoading && searchError && <div style={{ padding: '10px 12px', color: '#ff9f9f', fontSize: '12px' }}>{searchError}</div>}
            {!searchLoading && !searchError && searchResults.length === 0 && searchQuery.trim() && <div style={{ padding: '10px 12px', color: '#8ca0c7', fontSize: '12px' }}>No workspace matches.</div>}
            {!searchLoading && !searchError && groupedSearchResults.conversationsHit.map((item) => (
              <button key={item.id} type="button" onClick={() => handleSearchSelect(item)} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', color: '#f1f7ff', cursor: 'pointer', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: '12px', color: '#7df7ff', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Conversation</div>
                <div style={{ fontWeight: 700, marginTop: '2px' }}>{item.title || 'Conversation'}</div>
                <div style={{ fontSize: '12px', color: '#b5c4e4', marginTop: '4px' }}>{item.snippet || 'Open conversation'}</div>
              </button>
            ))}
            {!searchLoading && !searchError && groupedSearchResults.messageHit.map((item) => (
              <button key={item.id} type="button" onClick={() => handleSearchSelect(item)} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', color: '#f1f7ff', cursor: 'pointer', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: '12px', color: '#ffcf70', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Message</div>
                <div style={{ fontWeight: 700, marginTop: '2px' }}>{item.snippet || 'Matched message'}</div>
                <div style={{ fontSize: '12px', color: '#b5c4e4', marginTop: '4px' }}>Jump to conversation</div>
              </button>
            ))}
            {!searchLoading && !searchError && groupedSearchResults.memoryHit.map((item) => (
              <button key={item.id} type="button" onClick={() => handleSearchSelect(item)} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', color: '#f1f7ff', cursor: 'pointer', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: '12px', color: '#b887ff', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Memory</div>
                <div style={{ fontWeight: 700, marginTop: '2px' }}>{item.snippet || 'Memory result'}</div>
                <div style={{ fontSize: '12px', color: '#b5c4e4', marginTop: '4px' }}>{item.type === 'userFact' ? 'User fact' : 'Semantic memory'}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <ConversationListWrapper $collapsed={collapsed}>
        {loadingConversations && (
          <EmptyState>Loading conversations...</EmptyState>
        )}

        {!loadingConversations && conversations.length === 0 && (
          <EmptyState>
            <div>No conversations yet.</div>
            <div style={{ marginTop: '8px', fontSize: '12px' }}>
              Start a new chat to get going!
            </div>
          </EmptyState>
        )}

        {conversations.map((conv) => (
          <ConversationItem
            key={conv._id}
            $isActive={activeConversationId === conv._id}
            onClick={() => {
              switchConversation(conv._id);
              onClose(); // Close sidebar on mobile
            }}
            onMouseEnter={() => setHoveredId(conv._id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <ConversationTitle $isActive={activeConversationId === conv._id}>
                {conv.title}
              </ConversationTitle>
              <ConversationMeta>
                {formatDate(conv.updatedAt)}
              </ConversationMeta>
            </div>
            {hoveredId === conv._id && (
              <DeleteButton
                onClick={(e) => handleDelete(e, conv._id)}
                title="Delete"
              >
                ⊗
              </DeleteButton>
            )}
          </ConversationItem>
        ))}
      </ConversationListWrapper>

      {pendingDeleteConversation && (
        <ConfirmOverlay onClick={() => !isDeleting && setPendingDeleteConversation(null)}>
          <ConfirmModal onClick={(event) => event.stopPropagation()}>
            <ConfirmTitle>Delete conversation?</ConfirmTitle>
            <ConfirmText>
              This conversation will be removed from your sidebar history.
            </ConfirmText>
            <ConfirmActions>
              <CancelButton
                type="button"
                onClick={() => setPendingDeleteConversation(null)}
                disabled={isDeleting}
              >
                Cancel
              </CancelButton>
              <ConfirmDeleteButton
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </ConfirmDeleteButton>
            </ConfirmActions>
          </ConfirmModal>
        </ConfirmOverlay>
      )}
    </SidebarWrapper>
  );
};
