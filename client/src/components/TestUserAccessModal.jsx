import styled from 'styled-components';

const ModalOverlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
`;

const ModalContainer = styled.div`
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface-elevated) 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 40px;
  max-width: 480px;
  width: 90%;
  box-shadow: var(--shadow-lg);
`;

const Title = styled.h2`
  color: var(--foreground);
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 16px 0;
  letter-spacing: -0.3px;
`;

const Message = styled.p`
  color: var(--foreground-muted);
  font-size: 14px;
  line-height: 1.6;
  margin: 0 0 24px 0;
  font-weight: 400;
`;

const InfoBox = styled.div`
  background: rgba(100, 200, 255, 0.08);
  border-left: 3px solid var(--accent-soft);
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  margin-bottom: 24px;
`;

const InfoLabel = styled.p`
  color: var(--foreground-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  margin: 0 0 4px 0;
  letter-spacing: 0.5px;
`;

const InfoText = styled.p`
  color: var(--accent-soft);
  font-size: 13px;
  margin: 0;
  word-break: break-all;
  font-family: 'Monaco', 'Courier New', monospace;
`;

const ButtonGroup = styled.div`
  display: flex;
  gap: 12px;
  flex-direction: column;
`;

const Button = styled.button`
  padding: 12px 24px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
  display: inline-block;
  text-align: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

  &:hover {
    transform: translateY(-2px);
  }

  &:active {
    transform: translateY(0);
  }
`;

// Fixed sky-blue CTA: deliberate button composition, not app theme.
const PrimaryButton = styled(Button)`
  background: linear-gradient(135deg, #64c8ff 0%, #4ba3d9 100%);
  color: #0f1729;
  font-weight: 600;

  &:hover {
    background: linear-gradient(135deg, #7ed5ff 0%, #5bb0e8 100%);
    box-shadow: 0 8px 20px rgba(100, 200, 255, 0.3);
  }
`;

const SecondaryButton = styled(Button)`
  background: rgba(100, 200, 255, 0.1);
  color: var(--accent-soft);
  border: 1px solid rgba(100, 200, 255, 0.3);

  &:hover {
    background: rgba(100, 200, 255, 0.15);
    border-color: rgba(100, 200, 255, 0.5);
  }
`;

const TertiaryButton = styled(Button)`
  background: transparent;
  color: var(--foreground-muted);
  border: 1px solid rgba(100, 200, 255, 0.2);

  &:hover {
    background: rgba(100, 200, 255, 0.05);
    color: var(--foreground);
  }
`;

const TestUserAccessModal = ({ isOpen, onClose, onProceed }) => {
  if (!isOpen) return null;

  const handleRequestAccess = () => {
    window.location.href = 'mailto:arc.ai.assistant05@gmail.com?subject=Test%20User%20Request&body=Hello%2C%0A%0AI%20would%20like%20to%20request%20access%20to%20the%20Google%20Calendar%20integration%20in%20ARC-AI.%0A%0APlease%20include%20the%20following%20information%3A%0A-%20Full%20Name%3A%0A-%20Google%20Email%20Address%3A%0A-%20Use%20case%20for%20ARC-AI%20Calendar%20Assistant%20%28optional%29%3A';
  };

  return (
    <ModalOverlay onClick={onClose}>
      <ModalContainer onClick={(e) => e.stopPropagation()}>
        <Title>Google Calendar Integration</Title>
        
        <Message>
          Google Calendar integration is currently in private testing. At this time, only approved test users can connect their Google account.
        </Message>

        <InfoBox>
          <InfoLabel>Request Access To</InfoLabel>
          <InfoText>arc.ai.assistant05@gmail.com</InfoText>
          <InfoLabel style={{ marginTop: '12px' }}>In Your Email, Include</InfoLabel>
          <ul style={{ color: 'var(--foreground-muted)', fontSize: '13px', margin: '4px 0 0 0', paddingLeft: '20px', lineHeight: '1.6' }}>
            <li>Your full name</li>
            <li>Google email address to approve</li>
            <li>Optional: your use case</li>
          </ul>
        </InfoBox>

        <ButtonGroup>
          <PrimaryButton onClick={handleRequestAccess}>
            Request Access
          </PrimaryButton>
          <SecondaryButton onClick={onProceed}>
            I am Already a Test User
          </SecondaryButton>
          <TertiaryButton onClick={onClose}>
            Cancel
          </TertiaryButton>
        </ButtonGroup>
      </ModalContainer>
    </ModalOverlay>
  );
};

export default TestUserAccessModal;
