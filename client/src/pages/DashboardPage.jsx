// client/src/pages/DashboardPage.jsx
import React from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import VoiceButton from '../components/VoiceButton';
import ChatInterface from '../components/ChatInterface.jsx';

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

  @media (max-width: 1024px) {
    flex-direction: column;
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
  flex: 1;

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
  const { isConnected } = useSocket();

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
              <VoiceButton />
              <Hint>Tip: Use a clear, steady voice for best accuracy.</Hint>
            </VoiceWrapper>
          </Card>

          <Card>
            <CardTitle>Features</CardTitle>
            <CardSubtitle>What you get out of the box</CardSubtitle>
            <List>
              <ListItem>AI-powered responses tailored to your queries</ListItem>
              <ListItem>Built-in voice recognition for hands-free usage</ListItem>
              <ListItem>Real-time chat with low-latency updates</ListItem>
              <ListItem>Secure socket connection status indicator</ListItem>
            </List>
          </Card>
        </SidePanel>
      </Container>
    </Page>
  );
};

export default DashboardPage;
