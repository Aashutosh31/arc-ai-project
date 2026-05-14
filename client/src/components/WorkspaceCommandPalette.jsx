import React, { useEffect } from 'react';
import styled from 'styled-components';

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 16px 16px;
`;

const Palette = styled.div`
  width: min(720px, 100%);
  border-radius: 18px;
  border: 1px solid rgba(var(--primary-rgb), 0.25);
  background: linear-gradient(180deg, rgba(13, 14, 32, 0.98), rgba(8, 10, 22, 0.98));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
`;

const Header = styled.div`
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const Title = styled.h3`
  margin: 0;
  font-size: 14px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #7df7ff;
`;

const Subtitle = styled.p`
  margin: 6px 0 0;
  color: #aeb8d9;
  font-size: 12px;
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 14px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
`;

const ActionButton = styled.button`
  width: 100%;
  text-align: left;
  padding: 14px 14px;
  border-radius: 14px;
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  background: rgba(255, 255, 255, 0.03);
  color: #f4fbff;
  cursor: pointer;
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;

  &:hover {
    transform: translateY(-1px);
    background: rgba(var(--primary-rgb), 0.08);
    border-color: rgba(var(--primary-rgb), 0.35);
  }
`;

const ActionLabel = styled.div`
  font-weight: 700;
  font-size: 13px;
`;

const ActionHint = styled.div`
  margin-top: 5px;
  font-size: 12px;
  color: #aeb8d9;
  line-height: 1.4;
`;

const Footer = styled.div`
  padding: 0 14px 14px;
  color: #8fa2cf;
  font-size: 12px;
`;

const WorkspaceCommandPalette = ({
  isOpen,
  onClose,
  onNewChat,
  onOpenMemory,
  onToggleMemoryLearning,
  memoryLearningEnabled
}) => {
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <Overlay onClick={onClose}>
      <Palette onClick={(event) => event.stopPropagation()}>
        <Header>
          <Title>Command Palette</Title>
          <Subtitle>Ctrl+K shortcuts for workspace actions</Subtitle>
        </Header>
        <Grid>
          <ActionButton type="button" onClick={onNewChat}>
            <ActionLabel>New chat</ActionLabel>
            <ActionHint>Start a fresh conversation in the active workspace.</ActionHint>
          </ActionButton>
          <ActionButton type="button" onClick={onOpenMemory}>
            <ActionLabel>Open memory manager</ActionLabel>
            <ActionHint>Inspect, pin, edit, or delete memory entries.</ActionHint>
          </ActionButton>
          <ActionButton type="button" onClick={onToggleMemoryLearning}>
            <ActionLabel>{memoryLearningEnabled ? 'Disable' : 'Enable'} memory learning</ActionLabel>
            <ActionHint>Control whether ARC-AI auto-learns from new conversations.</ActionHint>
          </ActionButton>
          <ActionButton type="button" onClick={onClose}>
            <ActionLabel>Close palette</ActionLabel>
            <ActionHint>Dismiss this menu and return to chat.</ActionHint>
          </ActionButton>
        </Grid>
        <Footer>Tip: use sidebar search for semantic retrieval across conversations, messages, and memories.</Footer>
      </Palette>
    </Overlay>
  );
};

export default WorkspaceCommandPalette;
