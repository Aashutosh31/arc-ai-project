import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import { ConversationProvider, useConversation } from '../contexts/ConversationContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useExecution } from '../contexts/ExecutionContext';
import { useWorkspaceViewport } from '../hooks/useWorkspaceViewport';
import { Sidebar } from '../components/Sidebar';
import ChatInterface from '../components/ChatInterface.jsx';
import ExecutionPanel from '../components/ExecutionPanel.jsx';
import TestUserAccessModal from '../components/TestUserAccessModal';
import WhatsAppModal from '../components/WhatsAppModal.jsx';
import WhatsAppConnectModal from '../components/WhatsAppConnectModal.jsx';
import WorkspaceMemoryModal from '../components/WorkspaceMemoryModal.jsx';
import CommandPalette from '../components/CommandPalette.jsx';
import VoiceOverlay from '../components/VoiceOverlay.jsx';
import VisionOverlay from '../components/VisionOverlay.jsx';
import ToolsPanel from '../components/ToolsPanel.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import AccountMenu from '../components/AccountMenu.jsx';

const Page = styled.div`
  min-height: 100dvh;
  height: 100dvh;
  background: #050510;
  color: #fff;
  display: flex;
  flex-direction: row;
  width: 100%;
  max-width: 100vw;
  overflow: hidden;

  @media (max-width: 999px) {
    height: auto;
    min-height: 100vh;
    flex-direction: column;
  }
`;

const MainContent = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  @media (max-width: 999px) {
    min-height: 100vh;
  }
`;

const ChatHeader = styled.header`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(5, 5, 16, 0.95);
  backdrop-filter: blur(8px);
  gap: 12px;
  z-index: 10;
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
`;

const Hamburger = styled.button`
  display: none;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font-size: 18px;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  &:hover { color: #fff; background: rgba(255, 255, 255, 0.04); }
  @media (max-width: 999px) { display: flex; }
`;

const HeaderTitle = styled.div`
  min-width: 0;
`;

const HeaderName = styled.h1`
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const HeaderMeta = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
`;

const PaletteButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover { color: rgba(255, 255, 255, 0.75); border-color: rgba(255, 255, 255, 0.16); }
  @media (max-width: 640px) { display: none; }
`;

const HeaderRight = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
`;

const StatusPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ $on }) => ($on ? 'rgba(77,255,176,0.8)' : 'rgba(255,112,112,0.8)')};
  @media (max-width: 480px) { display: none; }
`;

const StatusDot = styled.span`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: ${({ $on }) => ($on ? '#4dffb0' : '#ff7070')};
`;

const ChatArea = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const SidebarOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 999;
  display: ${({ $open }) => ($open ? 'block' : 'none')};
`;

const ExecutionDrawer = styled.div`
  position: fixed;
  bottom: 80px;
  right: 16px;
  width: min(340px, calc(100vw - 32px));
  max-height: 50vh;
  overflow-y: auto;
  z-index: 100;
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
`;

const DashboardPageContent = () => {
  const { isConnected, authInfo, socket } = useSocket();
  const { conversations, activeConversationId, createNewConversation } = useConversation();
  const { activeWorkspace } = useWorkspace();
  const { activeExecution } = useExecution();
  const { isDesktopWide, isDesktopCompact } = useWorkspaceViewport();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showMemoryModal, setShowMemoryModal] = useState(false);
  const [showTestUserModal, setShowTestUserModal] = useState(false);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showWhatsAppConnect, setShowWhatsAppConnect] = useState(false);
  const [showVoiceOverlay, setShowVoiceOverlay] = useState(false);
  const [showVisionOverlay, setShowVisionOverlay] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [settingsView, setSettingsView] = useState(null); // null | sectionId
  const [memoryLearningEnabled, setMemoryLearningEnabled] = useState(true);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [seedText, setSeedText] = useState(null);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleNote, setGoogleNote] = useState('');
  const [whatsappConnected, setWhatsappConnected] = useState(false);

  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
  const showWhatsAppDebug = import.meta.env.DEV && typeof localStorage !== 'undefined' && localStorage.getItem('arc_whatsapp_debug') === 'true';

  useEffect(() => {
    if (isDesktopWide || isDesktopCompact) { setSidebarCollapsed(false); setSidebarDrawerOpen(false); }
  }, [isDesktopWide, isDesktopCompact]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(p => !p);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onReady = () => setWhatsappConnected(true);
    const onDisconnected = () => setWhatsappConnected(false);
    socket.on('whatsapp:ready', onReady);
    socket.on('whatsapp:disconnected', onDisconnected);
    return () => { socket.off('whatsapp:ready', onReady); socket.off('whatsapp:disconnected', onDisconnected); };
  }, [socket]);

  useEffect(() => {
    const load = async () => {
      const token = authInfo?.token || localStorage.getItem('token');
      if (!authInfo?.ready || !token) return;
      try {
        const wsId = activeWorkspace?._id || null;
        const r = await fetch(`${apiUrl}/api/memory${wsId ? `?workspaceId=${wsId}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) { const d = await r.json(); setMemoryLearningEnabled(Boolean(d?.preferences?.memoryLearningEnabled)); }
      } catch { /* ignore */ }
    };
    load();
  }, [authInfo?.ready, authInfo?.token, apiUrl, activeWorkspace?._id]);

  useEffect(() => {
    const load = async () => {
      const token = authInfo?.token || localStorage.getItem('token');
      if (!authInfo?.ready || !token || authInfo?.authType === 'guest') { setGoogleConnected(false); return; }
      try {
        const r = await fetch(`${apiUrl}/api/google/status`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) { const d = await r.json(); setGoogleConnected(Boolean(d.connected)); }
      } catch { /* ignore */ }
    };
    load();
  }, [authInfo?.ready, authInfo?.token, authInfo?.authType, apiUrl]);

  const handleNewChat = async () => { try { await createNewConversation(); setSidebarDrawerOpen(false); } catch (e) { console.error(e); } };

  const handleSignOut = () => {
    ['token', 'userId', 'authType', 'authProvider', 'username', 'creditsRemaining', 'googleLinked'].forEach(k => localStorage.removeItem(k));
    window.location.href = '/';
  };

  const handleToggleMemoryLearning = () => {
    setMemoryLearningEnabled(p => !p);
    const token = authInfo?.token || localStorage.getItem('token');
    if (token) {
      fetch(`${apiUrl}/api/memory/preferences`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryLearningEnabled: !memoryLearningEnabled, workspaceId: activeWorkspace?._id || null })
      }).catch(() => {});
    }
  };

  const openSettings = (section = 'account') => { setSettingsView(section); setSidebarDrawerOpen(false); };

  const handleGoogleConnectCalendar = () => {
    if (authInfo?.authType === 'guest') { setGoogleNote('Sign in with a real account to connect Google Calendar.'); return; }
    setShowTestUserModal(true);
  };

  const handleProceedAsTestUser = async () => {
    setShowTestUserModal(false);
    const token = authInfo?.token || localStorage.getItem('token');
    if (!token) { setGoogleNote('Please sign in first.'); return; }
    try {
      setGoogleBusy(true);
      setGoogleNote('');
      const r = await fetch(`${apiUrl}/api/google/auth-url`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.message || 'Failed to start Google connection.');
      window.open(d.url, '_blank', 'noopener,noreferrer,width=520,height=700');
      setGoogleNote('Google consent window opened. Finish login there.');
    } catch (e) { setGoogleNote(e.message || 'Unable to start Google connection.'); }
    finally { setGoogleBusy(false); }
  };

  const handleGoogleLinkAccount = async () => {
    const token = authInfo?.token || localStorage.getItem('token');
    if (!token || authInfo?.authType === 'guest') { setGoogleNote('Sign in to link Google.'); return; }
    try {
      setGoogleBusy(true);
      const r = await fetch(`${apiUrl}/api/auth/google/link-url`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.message || 'Failed to start Google link flow.');
      const popup = window.open(d.url, 'arc-ai-google-link', 'width=520,height=720');
      if (!popup) throw new Error('Popup blocked by the browser. Please allow popups and try again.');
    } catch (e) { setGoogleNote(e.message || 'Unable to start Google link flow.'); }
    finally { setGoogleBusy(false); }
  };

  const handleWhatsAppConnect = () => {
    if (!authInfo?.ready) return;
    if (showWhatsAppDebug) setShowWhatsAppModal(true);
    else setShowWhatsAppConnect(true);
    try { if (socket && socket.connected) socket.emit('whatsapp:connect'); } catch (e) { console.warn('whatsapp connect emit failed', e); }
  };

  const handleUseExample = (prompt) => {
    setSeedText({ text: prompt, nonce: Date.now() });
  };

  const isDesktop = isDesktopWide || isDesktopCompact;
  const activeConversation = (conversations || []).find(c => String(c._id) === String(activeConversationId));
  const headerTitle = activeConversation?.title || 'New conversation';

  return (
    <Page>
      <Sidebar
        isOpen={isDesktop ? true : sidebarDrawerOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => {
          if (isDesktopWide || isDesktopCompact) setSidebarCollapsed(p => !p);
          else setSidebarDrawerOpen(p => !p);
        }}
        onClose={() => setSidebarDrawerOpen(false)}
        onCommandPaletteClick={() => { setShowCommandPalette(true); setSidebarDrawerOpen(false); }}
        onOpenSettings={() => openSettings('account')}
        onOpenTools={() => setShowTools(true)}
        onOpenAccount={() => openSettings('account')}
        searchFocusToken={searchFocusToken}
      />

      <SidebarOverlay $open={sidebarDrawerOpen} onClick={() => setSidebarDrawerOpen(false)} />

      <MainContent>
        <ChatHeader>
          <HeaderLeft>
            <Hamburger onClick={() => setSidebarDrawerOpen(p => !p)} aria-label="Toggle sidebar">☰</Hamburger>
            <HeaderTitle>
              <HeaderName>{headerTitle}</HeaderName>
              <HeaderMeta>{activeWorkspace?.name || 'Default workspace'}</HeaderMeta>
            </HeaderTitle>
          </HeaderLeft>
          <HeaderRight>
            <PaletteButton onClick={() => setShowCommandPalette(true)} aria-label="Open command palette">
              ⌘ Commands
            </PaletteButton>
            <StatusPill $on={isConnected}>
              <StatusDot $on={isConnected} />
              {isConnected ? 'Online' : 'Offline'}
            </StatusPill>
            <AccountMenu
              authInfo={authInfo}
              googleConnected={googleConnected}
              whatsappConnected={whatsappConnected}
              onOpenSettings={openSettings}
              onSignOut={handleSignOut}
            />
          </HeaderRight>
        </ChatHeader>

        <ChatArea>
          <ChatInterface
            onOpenVoice={() => setShowVoiceOverlay(true)}
            onOpenVision={() => setShowVisionOverlay(true)}
            onOpenTools={() => setShowTools(true)}
            seedText={seedText}
          />
        </ChatArea>
      </MainContent>

      {activeExecution && (
        <ExecutionDrawer>
          <ExecutionPanel />
        </ExecutionDrawer>
      )}

      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onNewChat={handleNewChat}
        onSearchConversations={() => {
          setSidebarDrawerOpen(false);
          if (!isDesktopWide && !isDesktopCompact) setSidebarDrawerOpen(true);
          setSearchFocusToken(t => t + 1);
        }}
        onOpenTools={() => setShowTools(true)}
        onOpenMemory={() => setShowMemoryModal(true)}
        onToggleMemoryLearning={handleToggleMemoryLearning}
        onOpenVoice={() => setShowVoiceOverlay(true)}
        onOpenVision={() => setShowVisionOverlay(true)}
        onOpenSettings={openSettings}
        onOpenAccount={() => openSettings('account')}
        onOpenIntegrations={() => openSettings('integrations')}
        onLogout={handleSignOut}
        memoryLearningEnabled={memoryLearningEnabled}
      />

      <ToolsPanel
        isOpen={showTools}
        onClose={() => setShowTools(false)}
        onUseExample={handleUseExample}
        googleConnected={googleConnected}
        whatsappConnected={whatsappConnected}
      />

      <SettingsModal
        isOpen={settingsView !== null}
        onClose={() => setSettingsView(null)}
        initialSection={settingsView || 'account'}
        authInfo={authInfo}
        memoryLearningEnabled={memoryLearningEnabled}
        onToggleMemoryLearning={handleToggleMemoryLearning}
        onOpenMemory={() => setShowMemoryModal(true)}
        google={{
          connected: googleConnected,
          busy: googleBusy,
          note: googleNote,
          onConnectCalendar: handleGoogleConnectCalendar,
          onLinkAccount: handleGoogleLinkAccount,
        }}
        whatsapp={{ connected: whatsappConnected, onConnect: handleWhatsAppConnect }}
        onOpenVoice={() => setShowVoiceOverlay(true)}
        onSignOut={handleSignOut}
      />

      <VoiceOverlay isOpen={showVoiceOverlay} onClose={() => setShowVoiceOverlay(false)} />
      <VisionOverlay
        isOpen={showVisionOverlay}
        onClose={() => setShowVisionOverlay(false)}
        onCaptureReady={() => {}}
      />

      <TestUserAccessModal isOpen={showTestUserModal} onClose={() => setShowTestUserModal(false)} onProceed={handleProceedAsTestUser} />
      <WhatsAppModal isOpen={showWhatsAppModal} onClose={() => setShowWhatsAppModal(false)} />
      <WhatsAppConnectModal isOpen={showWhatsAppConnect} onClose={() => setShowWhatsAppConnect(false)} onConnected={() => setShowWhatsAppConnect(false)} />
      <WorkspaceMemoryModal isOpen={showMemoryModal} onClose={() => setShowMemoryModal(false)} />
    </Page>
  );
};

const DashboardPage = () => (
  <ConversationProvider>
    <DashboardPageContent />
  </ConversationProvider>
);

export default DashboardPage;
