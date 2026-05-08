// client/src/pages/DashboardPage.jsx
import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import AdvancedVoiceButton from '../components/AdvancedVoiceButton.jsx';
import ChatInterface from '../components/ChatInterface.jsx';
import TestUserAccessModal from '../components/TestUserAccessModal';
import WhatsAppModal from '../components/WhatsAppModal.jsx';

const Page = styled.div`
  min-height: 100vh;
  background: radial-gradient(circle at top, #1a1a3a 0, #050511 55%, #020208 100%);
  color: #ffffff;
  display: flex;
  flex-direction: column;
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

  @media (max-width: 640px) {
    flex-direction: column;
    align-items: flex-start;
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
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px 12px 24px;
  display: flex;
  gap: 16px;
  /* Must NOT have overflow: hidden — lets sticky work */
  align-items: flex-start;

  @media (max-width: 1024px) {
    flex-direction: column;
    align-items: stretch;
  }

  @media (min-width: 1440px) {
    max-width: 1400px;
  }

  @media (max-width: 600px) {
    padding: 12px 10px 20px;
    gap: 12px;
  }
`;

const ChatBox = styled.section`
  flex: 1.7;
  background: rgba(11, 11, 35, 0.95);
  border-radius: 16px;
  padding: 12px;
  border: 1px solid rgba(70, 70, 130, 0.8);
  box-shadow:
    0 16px 32px rgba(0, 0, 0, 0.75),
    0 0 18px rgba(0, 255, 255, 0.08);
  min-height: 360px;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  @media (min-width: 768px) {
    padding: 16px;
  }

  @media (max-width: 600px) {
    min-height: 320px;
  }
`;

const SidePanel = styled.aside`
  flex: 1;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 14px;

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

  @media (max-width: 1024px) {
    max-width: 100%;
    flex-direction: row;
    flex-wrap: wrap;
  }

  @media (max-width: 768px) {
    flex-direction: column;
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

const CardText = styled.p`
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

const DashboardPage = () => {
  const { isConnected, authInfo, setAuthInfo, socket } = useSocket();
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleMessage, setGoogleMessage] = useState('');
  const [showTestUserModal, setShowTestUserModal] = useState(false);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const showWhatsAppDebug = import.meta.env.DEV && localStorage.getItem('arc_whatsapp_debug') === 'true';
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000';
  const apiOrigin = (() => {
    try {
      return new URL(apiUrl).origin;
    } catch {
      return 'http://localhost:5000';
    }
  })();

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
  }, [authInfo?.ready, authInfo?.token, authInfo?.authType, googleConnected]);

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

  return (
    <Page>
      <Header>
        <TitleWrapper>
          <Title>ARC-AI Dashboard</Title>
          <Subtitle>
            Control your AI assistant with real-time chat and voice commands,
            all in one place.
          </Subtitle>
        </TitleWrapper>

        <StatusBadge $connected={isConnected}>
          <Dot $connected={isConnected} />
          {isConnected ? 'ONLINE' : 'OFFLINE'}
        </StatusBadge>
      </Header>

      <Container>
        <ChatBox>
          <ChatInterface />
        </ChatBox>

        <SidePanel>
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

          <Card>
            <CardTitle>Features</CardTitle>
            <CardSubtitle>What you get out of the box</CardSubtitle>
            <List>
              <ListItem>AI-powered responses tailored to your queries</ListItem>
              <ListItem>Built-in voice recognition for hands-free usage</ListItem>
              <ListItem>Real-time chat with low-latency updates</ListItem>
              <ListItem>Secure socket connection status indicator</ListItem>
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
    </Page>
  );
};

export default DashboardPage;
