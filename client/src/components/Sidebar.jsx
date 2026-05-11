import React, { useState } from 'react';
import styled from 'styled-components';
import { useConversation } from '../contexts/ConversationContext';

const SidebarWrapper = styled.div`
  display: flex;
  flex-direction: column;
  width: 280px;
  height: 100%;
  background: linear-gradient(180deg, rgba(10, 10, 20, 0.95) 0%, rgba(15, 15, 30, 0.95) 100%);
  border-right: 2px solid rgba(var(--primary-rgb), 0.2);
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
  overflow: hidden;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);

  @media (max-width: 768px) {
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

const NewChatButton = styled.button`
  padding: 9px 14px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.25), rgba(var(--secondary-rgb), 0.15));
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  border-radius: 8px;
  color: var(--primary-hex);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  white-space: nowrap;

  &:hover {
    background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.35), rgba(var(--secondary-rgb), 0.25));
    border-color: rgba(var(--primary-rgb), 0.6);
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }

  @media (max-width: 480px) {
    padding: 8px 12px;
    font-size: 12px;
  }
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

  @media (max-width: 768px) {
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

export const Sidebar = ({ isOpen = true, onClose = () => {} }) => {
  const {
    conversations,
    activeConversationId,
    loadingConversations,
    createNewConversation,
    switchConversation,
    deleteConversation
  } = useConversation();

  const [hoveredId, setHoveredId] = useState(null);
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
    <SidebarWrapper $isOpen={isOpen}>
      <SidebarHeader>
        <Logo>ARC-AI</Logo>
        <CloseButton onClick={onClose}>×</CloseButton>
      </SidebarHeader>

      <NewChatButton onClick={handleNewChat}>
        + New Chat
      </NewChatButton>

      <ConversationListWrapper>
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
