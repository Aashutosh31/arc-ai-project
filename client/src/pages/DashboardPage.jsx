// client/src/pages/DashboardPage.jsx
import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import { ConversationProvider, useConversation } from '../contexts/ConversationContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceViewport } from '../hooks/useWorkspaceViewport';
import { Sidebar } from '../components/Sidebar';
import AdvancedVoiceButton from '../components/AdvancedVoiceButton.jsx';
import ChatInterface from '../components/ChatInterface.jsx';
import ExecutionPanel from '../components/ExecutionPanel.jsx';
import TestUserAccessModal from '../components/TestUserAccessModal';
import WhatsAppModal from '../components/WhatsAppModal.jsx';
import WhatsAppConnectModal from '../components/WhatsAppConnectModal.jsx';
import WorkspaceMemoryModal from '../components/WorkspaceMemoryModal.jsx';
import WorkspaceCommandPalette from '../components/WorkspaceCommandPalette.jsx';

const Page = styled.div`
  min-height: 100dvh;
  height: 100dvh;
  background: radial-gradient(circle at top, #1a1a3a 0, #050511 55%, #020208 100%);
  color: #ffffff;
  display: flex;
  flex-direction: row;
  width: 100%;
  max-width: 100vw;
  overflow-x: hidden;
  overflow-y: hidden;

  @media (max-width: 999px) {
    height: auto;
    min-height: 100vh;
    flex-direction: column;
    overflow-y: auto;
  }
`;

const MainContent = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: hidden;
  min-width: 0;

  @media (max-width: 999px) {
    min-height: auto;
    overflow-y: visible;
  }
`;

const HamburgerButton = styled.button`
  display: none;
  background: none;
  border: none;
  color: var(--primary-hex);
  font-size: 24px;
  cursor: pointer;
  padding: 8px;
  transition: all 0.3s ease;
  z-index: 100;

  &:hover {
    color: var(--secondary-hex);
    transform: scale(1.1);
  }

  @media (max-width: 999px) {
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

const SidebarOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 999;
  display: ${({ $isOpen }) => ($isOpen ? 'block' : 'none')};
`;

const DesktopSidebarWrapper = styled.div`
  display: ${({ $visible }) => ($visible ? 'block' : 'none')};
  height: 100%;
  align-self: stretch;
`;

const MobileSidebarWrapper = styled.div`
  display: ${({ $visible }) => ($visible ? 'block' : 'none')};
  position: fixed;
  left: 0;
  top: 0;
  z-index: 1000;
`;

const Header = styled.header`
  background: rgba(10, 10, 28, 0.95);
  padding: 16px 18px;
  border-bottom: 1px solid rgba(0, 255, 255, 0.18);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  backdrop-filter: blur(12px);
  position: sticky;
  top: 0;
  z-index: 10;
  width: 100%;
  flex-wrap: wrap;

  @media (max-width: 640px) {
    padding: 14px 12px;
    gap: 10px;
  }
`;

const TitleWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 24px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 800;
  color: #00ffff;
  text-shadow: 0 0 6px rgba(0, 255, 255, 0.65);

  @media (min-width: 768px) {
    font-size: 28px;
  }
`;

const Subtitle = styled.p`
  margin: 0;
  font-size: 12px;
  color: #aaa;
  max-width: 380px;

  @media (max-width: 480px) {
    max-width: 100%;
  }
`;

const StatusBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: ${({ $connected }) =>
    $connected ? 'rgba(0, 255, 120, 0.08)' : 'rgba(255, 40, 40, 0.08)'};
  border: 1px solid
    ${({ $connected }) => ($connected ? '#26ff8a' : 'rgba(255, 80, 80, 0.9)')};
  border-radius: 999px;
  font-weight: 600;
  color: ${({ $connected }) => ($connected ? '#4dffb0' : '#ff7070')};
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  box-shadow: 0 0 18px
    ${({ $connected }) =>
      $connected ? 'rgba(0, 255, 120, 0.25)' : 'rgba(255, 80, 80, 0.2)'};
`;

const Dot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: ${({ $connected }) =>
    $connected ? '#26ff8a' : 'rgba(255, 80, 80, 0.9)'};
  box-shadow: 0 0 10px
    ${({ $connected }) =>
      $connected ? 'rgba(0, 255, 120, 0.8)' : 'rgba(255, 80, 80, 0.8)'};
`;

const Container = styled.main`
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: ${({ $layoutMode }) => ($layoutMode === 'expanded' ? 'min(1600px, calc(100vw - 24px))' : 'none')};
  margin: ${({ $layoutMode }) => ($layoutMode === 'expanded' ? '0 auto' : '0')};
  padding: ${({ $layoutMode }) => ($layoutMode === 'expanded' ? '16px 12px 24px' : '16px 14px 24px')};
  display: grid;
  grid-template-columns: ${({ $mode }) => {
    if ($mode === 'desktop-wide') return 'minmax(0, 1fr) minmax(300px, 340px)';
    if ($mode === 'desktop-compact') return 'minmax(0, 1fr) minmax(260px, 300px)';
    return 'minmax(0, 1fr)';
  }};
  grid-auto-flow: row;
  gap: 16px;
  /* Must NOT have overflow: hidden — lets sticky work */
  align-items: stretch;
  min-width: 0;
  overflow-x: clip;

  @media (max-width: 999px) {
    grid-template-columns: minmax(0, 1fr);
  }

  @media (min-width: 1440px) {
    max-width: min(1680px, calc(100vw - 32px));
  }

  @media (max-width: 600px) {
    padding: 12px 10px 20px;
    gap: 12px;
    max-width: 100%;
  }
`;

const ChatBox = styled.section`
  flex: 1;
  min-width: 0;
  background: rgba(11, 11, 35, 0.95);
  border-radius: 16px;
  padding: 12px;
  border: 1px solid rgba(70, 70, 130, 0.8);
  box-shadow:
    0 16px 32px rgba(0, 0, 0, 0.75),
    0 0 18px rgba(0, 255, 255, 0.08);
  min-height: 360px;
  height: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  min-height: 0;

  @media (min-width: 768px) {
    padding: 16px;
  }

  @media (min-width: 1025px) {
    min-height: clamp(560px, 78vh, calc(100vh - 164px));
  }

  @media (max-width: 600px) {
    min-height: 320px;
  }
`;

const SidePanel = styled.aside`
  flex: 0 0 auto;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;

  @media (min-width: 1025px) {
    align-self: stretch;
    max-height: calc(100vh - 164px);
    overflow-y: auto;
  }

  /* Keep the panel in normal page flow on laptops so it scrolls with the page. */
  @media (min-width: 1440px) {
    position: sticky;
    top: 80px; /* clears the sticky header height */
    align-self: flex-start;
    max-height: calc(100vh - 96px);
    overflow-y: auto;
    /* hide scrollbar but still scrollable if content overflows */
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
  }

  @media (max-width: 1399px) {
    max-width: 100%;
  }

  @media (max-width: 999px) {
    position: relative;
    top: auto;
    align-self: stretch;
    max-height: none;
  }

  @media (max-width: 768px) {
    gap: 12px;
  }
`;

const Card = styled.div`
  background: linear-gradient(
    135deg,
    rgba(15, 15, 40, 0.96),
    rgba(12, 12, 32, 0.96)
  );
  border-radius: 14px;
  padding: 14px 12px;
  border: 1px solid rgba(60, 60, 120, 0.85);
  box-shadow:
    0 12px 22px rgba(0, 0, 0, 0.85),
    0 0 14px rgba(138, 43, 226, 0.18);
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  overflow: hidden;
  flex: 0 0 auto;
  min-width: 0;
  width: 100%;

  &::before {
    content: '';
    position: absolute;
    inset: -30%;
    opacity: 0.04;
    background: radial-gradient(
      circle at top right,
      rgba(0, 255, 255, 0.5),
      transparent 60%
    );
    pointer-events: none;
  }

  @media (min-width: 768px) {
    padding: 16px 14px;
  }
`;

const CardTitle = styled.h3`
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #b887ff;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  position: relative;
  z-index: 1;
`;

const CardSubtitle = styled.p`
  margin: 2px 0 0;
  font-size: 11px;
  color: #888;
  position: relative;
  z-index: 1;
`;

const CardStatus = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ $connected }) => ($connected ? '#4dffb0' : '#ff7070')};
  border: 1px solid ${({ $connected }) => ($connected ? 'rgba(38,255,138,0.9)' : 'rgba(255,80,80,0.9)')};
  background: ${({ $connected }) => ($connected ? 'rgba(0,255,120,0.08)' : 'rgba(255,40,40,0.08)')};
`;

const CardButton = styled.button`
  border: 1px solid rgba(0, 255, 255, 0.35);
  background: linear-gradient(135deg, rgba(0, 255, 255, 0.18), rgba(138, 43, 226, 0.12));
  color: #d9fbff;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 180ms ease, box-shadow 180ms ease, opacity 180ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 0 16px rgba(0, 255, 255, 0.18);
    opacity: 0.95;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    transform: none;
  }
`;

const CardText = styled.div`
  margin: 0;
  font-size: 12px;
  color: #c9cee6;
  line-height: 1.45;
`;

const CardStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  z-index: 1;
`;

const SessionPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ $guest }) => ($guest ? '#ffcf70' : '#4dffb0')};
  border: 1px solid ${({ $guest }) => ($guest ? 'rgba(255, 207, 112, 0.9)' : 'rgba(38,255,138,0.9)')};
  background: ${({ $guest }) => ($guest ? 'rgba(255, 207, 112, 0.08)' : 'rgba(0,255,120,0.08)')};
`;

const CreditLine = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: #c9cee6;
`;

const CreditValue = styled.strong`
  color: #7df7ff;
`;

const CardActionButton = styled.button`
  border: 1px solid rgba(0, 255, 255, 0.35);
  background: linear-gradient(135deg, rgba(0, 255, 255, 0.18), rgba(138, 43, 226, 0.12));
  color: #d9fbff;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 180ms ease, box-shadow 180ms ease, opacity 180ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 0 16px rgba(0, 255, 255, 0.18);
    opacity: 0.95;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    transform: none;
  }
`;

const VoiceWrapper = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding-top: 4px;
  position: relative;
  z-index: 1;
`;

const Description = styled.p`
  margin: 0;
  font-size: 12px;
  color: #b0b0b0;
  text-align: center;
  line-height: 1.5;
  max-width: 260px;
`;

const Hint = styled.span`
  font-size: 10px;
  color: #7ad7ff;
  opacity: 0.9;
`;

const List = styled.ul`
  list-style: none;
  padding: 4px 0 0;
  margin: 0;
  position: relative;
  z-index: 1;
`;

const ListItem = styled.li`
  padding: 7px 0;
  border-bottom: 1px solid rgba(65, 65, 110, 0.9);
  color: #d0d0e6;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;

  &:last-child {
    border-bottom: none;
  }

  &::before {
    content: '✓';
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    min-width: 15px;
    height: 15px;
    border-radius: 999px;
    border: 1px solid rgba(0, 255, 255, 0.85);
    font-size: 9px;
    color: #00ffff;
    margin-right: 4px;
  }
`;

const DashboardPageContent = () => {
  const { isConnected, authInfo, setAuthInfo, socket } = useSocket();
  const { createNewConversation } = useConversation();
  const { activeWorkspace } = useWorkspace();
  const { workspaceMode, isDesktopWide, isDesktopCompact, isTablet, isMobile } = useWorkspaceViewport();
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleMessage, setGoogleMessage] = useState('');
  const [showTestUserModal, setShowTestUserModal] = useState(false);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showWhatsAppConnect, setShowWhatsAppConnect] = useState(false);
  const [showMemoryModal, setShowMemoryModal] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [memoryLearningEnabled, setMemoryLearningEnabled] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const showWhatsAppDebug = import.meta.env.DEV && localStorage.getItem('arc_whatsapp_debug') === 'true';
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
  const apiOrigin = (() => {
    try {
      return new URL(apiUrl).origin;
    } catch {
      return 'http://localhost:5000';
    }
  })();

  useEffect(() => {
    // Do not auto-collapse on "laptop" widths (desktop-compact).
    // Treat compact desktops like wide desktops: start expanded by default.
    if (isDesktopWide || isDesktopCompact) {
      setSidebarCollapsed(false);
      setSidebarDrawerOpen(false);
      return;
    }

    // For tablet and mobile keep default (drawer controls visibility).
    setSidebarCollapsed(false);
    setSidebarDrawerOpen(false);
  }, [isDesktopWide, isDesktopCompact, isTablet, isMobile]);

  const handleNewChat = async () => {
    try {
      await createNewConversation();
      setSidebarDrawerOpen(false);
    } catch (error) {
      console.error('Failed to create conversation from command palette:', error);
    }
  };

  const persistAuthPayload = (payload) => {
    const user = payload?.user || payload;
    const token = payload?.token || user?.token;

    if (!token || !user?._id) return;

    const nextAuthInfo = {
      ...(authInfo || {}),
      ready: true,
      token,
      userId: user._id,
      authType: user.authType || 'user',
      authProvider: user.authProvider || 'google',
      username: user.username || 'User',
      creditsRemaining: Number(user.creditsRemaining ?? authInfo?.creditsRemaining ?? 0),
      googleLinked: Boolean(user.googleLinked)
    };

    localStorage.setItem('token', token);
    localStorage.setItem('userId', user._id);
    localStorage.setItem('authType', nextAuthInfo.authType);
    localStorage.setItem('authProvider', nextAuthInfo.authProvider);
    localStorage.setItem('username', nextAuthInfo.username);
    localStorage.setItem('creditsRemaining', String(nextAuthInfo.creditsRemaining));
    localStorage.setItem('googleLinked', String(nextAuthInfo.googleLinked));

    if (setAuthInfo) {
      setAuthInfo(nextAuthInfo);
    }
  };

  useEffect(() => {
    if (!socket) return;
    const onReady = () => setWhatsappConnected(true);
    const onDisconnected = () => setWhatsappConnected(false);
    socket.on('whatsapp:ready', onReady);
    socket.on('whatsapp:disconnected', onDisconnected);
    return () => { socket.off('whatsapp:ready', onReady); socket.off('whatsapp:disconnected', onDisconnected); };
  }, [socket]);

    useEffect(() => {
    const handleGoogleMessage = (event) => {
      if (event.origin !== apiOrigin) return;
      if (event.data?.type !== 'arc-ai-google-auth-success') return;

      persistAuthPayload(event.data.payload);
      setGoogleMessage('Google account linked successfully.');
      setGoogleConnected(true);
    };

    window.addEventListener('message', handleGoogleMessage);
    return () => window.removeEventListener('message', handleGoogleMessage);
  }, [apiOrigin]);

  useEffect(() => {
    const loadMemoryStatus = async () => {
      const token = authInfo?.token || localStorage.getItem('token');
      if (!authInfo?.ready || !token) return;
      try {
        const workspaceId = activeWorkspace?._id || null;
        const response = await fetch(`${apiUrl}/api/memory${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) return;
        const data = await response.json();
        setMemoryLearningEnabled(Boolean(data?.preferences?.memoryLearningEnabled));
      } catch {
        // ignore memory status load failures
      }
    };

    loadMemoryStatus();
  }, [authInfo?.ready, authInfo?.token, apiUrl, activeWorkspace?._id]);

  useEffect(() => {
    const loadGoogleStatus = async () => {
      const token = authInfo?.token || localStorage.getItem('token');
      if (!authInfo?.ready || !token || authInfo?.authType === 'guest') {
        setGoogleConnected(false);
        return;
      }

      try {
        const response = await fetch(`${apiUrl}/api/google/status`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (!response.ok) return;

        const data = await response.json();
        setGoogleConnected(Boolean(data.connected));
      } catch {
        // ignore status load failures
      }
    };

    loadGoogleStatus();
  }, [authInfo?.ready, authInfo?.token, authInfo?.authType, googleConnected, apiUrl]);

  const handleOpenMemory = () => setShowMemoryModal(true);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleGoogleConnect = async () => {
    const token = authInfo?.token || localStorage.getItem('token');
    if (!token) {
      setGoogleMessage('Please log in first.');
      return;
    }

    if (authInfo?.authType === 'guest') {
      setGoogleMessage('Sign in with a real account to connect Google Calendar.');
      return;
    }

    setShowTestUserModal(true);
  };

  const handleProceedAsTestUser = async () => {
    setShowTestUserModal(false);
    const token = authInfo?.token || localStorage.getItem('token');
    try {
      setGoogleLoading(true);
      setGoogleMessage('');
      const response = await fetch(`${apiUrl}/api/google/auth-url`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await response.json();
      if (!response.ok || !data.url) {
        throw new Error(data.message || 'Failed to start Google connection.');
      }

      window.open(data.url, '_blank', 'noopener,noreferrer,width=520,height=700');
      setGoogleMessage('Google consent window opened. Finish login there.');
    } catch (error) {
      setGoogleMessage(error.message || 'Unable to start Google connection.');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleGoogleLink = async () => {
    const token = authInfo?.token || localStorage.getItem('token');
    if (!token) {
      setGoogleMessage('Please sign in first.');
      return;
    }

    if (authInfo?.authType === 'guest') {
      setGoogleMessage('Guest mode cannot link Google. Please sign in first.');
      return;
    }

    try {
      setGoogleLoading(true);
      setGoogleMessage('');
      const response = await fetch(`${apiUrl}/api/auth/google/link-url`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await response.json();
      if (!response.ok || !data.url) {
        throw new Error(data.message || 'Failed to start Google link flow.');
      }

      const popup = window.open(data.url, 'arc-ai-google-link', 'width=520,height=720');
      if (!popup) {
        throw new Error('Popup blocked by the browser. Please allow popups and try again.');
      }
    } catch (error) {
      setGoogleMessage(error.message || 'Unable to start Google link flow.');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleCommandPaletteClick = () => {
    setShowCommandPalette(true);
    setSidebarDrawerOpen(false);
  };

  const handleSidebarToggle = () => {
    if (isDesktopWide || isDesktopCompact) {
      setSidebarCollapsed((prev) => !prev);
      return;
    }

    setSidebarDrawerOpen((prev) => !prev);
  };

  const handleSidebarClose = () => {
    setSidebarDrawerOpen(false);
  };

  const shellLayoutMode = (isDesktopWide || isDesktopCompact)
    ? (sidebarCollapsed ? 'rail' : 'expanded')
    : isTablet
      ? 'tablet'
      : 'mobile';

  return (
    <Page>
      {/* Desktop Sidebar - Always visible on desktop */}
      <DesktopSidebarWrapper $visible={isDesktopWide || isDesktopCompact}>
        <Sidebar
          isOpen={true}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleSidebarToggle}
          onClose={() => {}}
          onCommandPaletteClick={handleCommandPaletteClick}
        />
      </DesktopSidebarWrapper>

      {/* Mobile Sidebar Overlay */}
      <SidebarOverlay $isOpen={sidebarDrawerOpen} onClick={handleSidebarClose} />

      {/* Mobile Sidebar Drawer */}
      <MobileSidebarWrapper $visible={!isDesktopWide && !isDesktopCompact && sidebarDrawerOpen}>
        <Sidebar
          isOpen={sidebarDrawerOpen}
          collapsed={false}
          onToggleCollapse={handleSidebarToggle}
          onClose={handleSidebarClose}
          onCommandPaletteClick={handleCommandPaletteClick}
        />
      </MobileSidebarWrapper>

      <MainContent>
        <Header>
          <TitleWrapper>
            <Title>ARC-AI</Title>
            <Subtitle>
              Conversational AI workspace with real-time chat, voice control, and calendar integration.
            </Subtitle>
          </TitleWrapper>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <HamburgerButton onClick={handleSidebarToggle}>
              ☰
            </HamburgerButton>
            <StatusBadge $connected={isConnected}>
              <Dot $connected={isConnected} />
              {isConnected ? 'ONLINE' : 'OFFLINE'}
            </StatusBadge>
          </div>
        </Header>

        <Container $mode={workspaceMode} $layoutMode={shellLayoutMode}>
          <ChatBox>
            <ChatInterface workspaceMode={workspaceMode} sidebarCollapsed={sidebarCollapsed} />
          </ChatBox>

          <SidePanel>
            <ExecutionPanel />

            <Card>
              <CardTitle>Voice Control</CardTitle>
              <CardSubtitle>Hands-free interaction</CardSubtitle>
              <VoiceWrapper>
                <Description>
                  Click the button below to activate voice input and talk to ARC-AI
                  like a real assistant.
                </Description>
                <AdvancedVoiceButton />
                <Hint>Tip: Use a clear, steady voice for best accuracy.</Hint>
              </VoiceWrapper>
            </Card>

            <Card>
              <CardTitle>Account</CardTitle>
              <CardSubtitle>Session and credits</CardSubtitle>
              <CardStack>
                <SessionPill $guest={authInfo?.authType === 'guest'}>
                  {authInfo?.authType === 'guest' ? 'Guest Session' : 'Signed In'}
                </SessionPill>
                <CreditLine>
                  <span>Credits remaining</span>
                  <CreditValue>{authInfo?.creditsRemaining ?? '—'}</CreditValue>
                </CreditLine>
                {authInfo?.authType === 'guest' ? (
                  <CardText>
                    Guest mode is limited. Sign up or sign in to unlock more credits and Google Calendar.
                  </CardText>
                ) : (
                  <CardText>
                  <CreditLine>
                    <span>Google link</span>
                    <CreditValue>{authInfo?.googleLinked ? 'Linked' : 'Not linked'}</CreditValue>
                  </CreditLine>
                  {authInfo?.authType !== 'guest' ? (
                    <CardActionButton type="button" onClick={handleGoogleLink} disabled={googleLoading}>
                      {authInfo?.googleLinked ? 'Reconnect Google Account' : 'Link Google Account'}
                    </CardActionButton>
                  ) : null}
                    Your signed-in account can use the full ARC-AI feature set with higher credit limits.
                  </CardText>
                )}
              </CardStack>
            </Card>

            <Card>
              <CardTitle>Google Calendar</CardTitle>
              <CardSubtitle>Executive scheduling</CardSubtitle>
              <CardStack>
                <CardStatus $connected={googleConnected}>
                  {googleConnected ? 'Connected' : 'Not connected'}
                </CardStatus>
                <CardText>
                  Connect ARC-AI to Google Calendar so it can read availability and schedule meetings.
                </CardText>
                <CardButton type="button" onClick={handleGoogleConnect} disabled={googleLoading}>
                  {authInfo?.authType === 'guest'
                    ? 'Sign in to connect'
                    : googleLoading
                      ? 'Opening...'
                      : googleConnected
                        ? 'Reconnect Calendar'
                        : 'Connect Google Calendar'}
                </CardButton>
                {googleMessage ? <CardText>{googleMessage}</CardText> : null}
              </CardStack>
            </Card>

            {showWhatsAppDebug ? (
              <Card>
                <CardTitle>WhatsApp Debug</CardTitle>
                <CardSubtitle>Hidden developer utility</CardSubtitle>
                <CardStack>
                  <CardText>
                    Temporary QR/session testing UI for local development only.
                  </CardText>
                  <CardButton type="button" onClick={() => {
                    setShowWhatsAppModal(true);
                    try {
                      if (socket && socket.connected) socket.emit('whatsapp:connect');
                    } catch (e) { console.warn('socket emit failed', e); }
                  }}>
                    Connect WhatsApp
                  </CardButton>
                </CardStack>
              </Card>
            ) : null}

            {/* Product-facing WhatsApp connect */}
            {authInfo?.authType !== 'guest' ? (
              <Card>
                <CardTitle>WhatsApp</CardTitle>
                <CardSubtitle>Connect ARC to your WhatsApp</CardSubtitle>
                <CardStack>
                  <CardStatus $connected={whatsappConnected}>{whatsappConnected ? 'Connected' : 'Not connected'}</CardStatus>
                  <CardText>
                    Connect once to use ARC to send messages on your behalf. Sessions persist until you unlink.
                  </CardText>
                  <CardButton type="button" onClick={() => {
                    if (!authInfo?.ready) {
                      alert('Please sign in first to connect WhatsApp.');
                      return;
                    }
                    setShowWhatsAppConnect(true);
                    try { if (socket && socket.connected) socket.emit('whatsapp:connect'); } catch (error) { console.warn('socket emit failed', error); }
                  }}>
                    {whatsappConnected ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}
                  </CardButton>
                </CardStack>
              </Card>
            ) : null}

            <Card>
              <CardTitle>Features</CardTitle>
              <CardSubtitle>What you get out of the box</CardSubtitle>
              <List>
                <ListItem>Persistent conversation history</ListItem>
                <ListItem>AI-powered responses tailored to your queries</ListItem>
                <ListItem>Built-in voice recognition for hands-free usage</ListItem>
                <ListItem>Real-time chat with low-latency updates</ListItem>
                <ListItem>Google Calendar scheduling with OAuth</ListItem>
              </List>
            </Card>
          </SidePanel>
        </Container>
        
        <TestUserAccessModal
          isOpen={showTestUserModal}
          onClose={() => setShowTestUserModal(false)}
          onProceed={handleProceedAsTestUser}
        />
        <WhatsAppModal isOpen={showWhatsAppModal} onClose={() => setShowWhatsAppModal(false)} />
        <WhatsAppConnectModal isOpen={showWhatsAppConnect} onClose={() => setShowWhatsAppConnect(false)} onConnected={() => setShowWhatsAppConnect(false)} />
        <WorkspaceMemoryModal isOpen={showMemoryModal} onClose={() => setShowMemoryModal(false)} />
        <WorkspaceCommandPalette 
          isOpen={showCommandPalette} 
          onClose={() => setShowCommandPalette(false)} 
          onNewChat={handleNewChat} 
          onOpenMemory={handleOpenMemory} 
          onToggleMemoryLearning={() => {
            setMemoryLearningEnabled(!memoryLearningEnabled);
            const token = authInfo?.token || localStorage.getItem('token');
            if (token) {
              fetch(`${apiUrl}/api/memory/preferences`, {
                method: 'PATCH',
                headers: { 
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ memoryLearningEnabled: !memoryLearningEnabled, workspaceId: activeWorkspace?._id || null })
              }).catch(() => {});
            }
          }}
          memoryLearningEnabled={memoryLearningEnabled}
        />
      </MainContent>
    </Page>
  );
};

const DashboardPage = () => {
  return (
    <ConversationProvider>
      <DashboardPageContent />
    </ConversationProvider>
  );
};

export default DashboardPage;
