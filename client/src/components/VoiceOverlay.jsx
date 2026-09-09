import React, { useEffect, useRef } from 'react';
import styled, { css, keyframes } from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import { useAdvancedVoice } from '../hooks/useAdvancedVoice';
import { useChat } from '../contexts/ChatContext';
import { useConversation } from '../contexts/ConversationContext';

const pulse = keyframes`
  0% { transform: scale(1); opacity: 0.4; }
  50% { transform: scale(1.12); opacity: 0.18; }
  100% { transform: scale(1); opacity: 0.4; }
`;

const bounce = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
`;

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(2, 2, 10, 0.92);
  backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
`;

const CloseButton = styled.button`
  position: absolute;
  top: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  &:hover { background: rgba(255, 255, 255, 0.1); }
`;

const OrbShell = styled.div`
  position: relative;
  width: 160px;
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const OrbGlow = styled.div`
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: ${({ $color }) => $color};
  opacity: 0.35;
  box-shadow: ${({ $shadow }) => $shadow};
  transform: ${({ $scale }) => $scale};
  ${({ $animationCss }) => $animationCss}
`;

const OrbButton = styled.button`
  position: relative;
  z-index: 1;
  width: 110px;
  height: 110px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${({ $color }) => $color};
  box-shadow: ${({ $shadow }) => $shadow};
  transform: ${({ $scale }) => $scale};
  transition: all 0.2s ease;
  &:hover { filter: brightness(1.15); }
`;

const StopSquare = styled.div`
  width: 28px;
  height: 28px;
  background: #fff;
  border-radius: 5px;
`;

const StatusText = styled.h2`
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: #f1f5f9;
  letter-spacing: 0.02em;
  text-align: center;
`;

const TranscriptText = styled.p`
  margin: 0;
  font-size: 14px;
  color: rgba(0, 255, 255, 0.8);
  font-style: italic;
  text-align: center;
  max-width: 360px;
  min-height: 20px;
`;

const StateLabel = styled.div`
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
`;

const stateConfig = {
  off: { color: '#384055', shadow: 'none', scale: 'scale(1)', animationCss: css`animation: none;` },
  listening: { color: '#22d3ee', shadow: '0 0 50px rgba(34, 211, 238, 0.7)', scale: 'scale(1.15)', animationCss: css`animation: ${pulse} 1.8s cubic-bezier(0.2, 0, 0.2, 1) infinite;` },
  speaking: { color: '#a855f7', shadow: '0 0 40px rgba(168, 85, 247, 0.6)', scale: 'scale(1.08)', animationCss: css`animation: ${pulse} 1.3s ease-in-out infinite;` },
  processing: { color: '#facc15', shadow: '0 0 30px rgba(250, 204, 21, 0.45)', scale: 'scale(1.05)', animationCss: css`animation: ${bounce} 1.1s ease-in-out infinite;` },
};

const VoiceOverlay = ({ isOpen, onClose }) => {
  const { sendCommand, interruptStream } = useSocket();
  const { isProcessing, isSpeaking, agentStatus } = useChat();
  const captureFrameRef = useRef(() => null);
  const { activeConversationId, ensureConversationReady } = useConversation();

  const handleFinalCommand = (transcript) => {
    if (transcript.trim()) {
      const frame = captureFrameRef.current?.() || null;
      (async () => {
        try {
          const cid = await ensureConversationReady?.('New Conversation');
          sendCommand(transcript, frame, null, cid || activeConversationId);
        } catch {
          sendCommand(transcript, frame);
        }
      })();
    }
  };

  const handleInterrupt = () => {
    if (isSpeaking || isProcessing) interruptStream();
  };

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const {
    isVoiceModeActive, liveTranscript, voiceMode, voiceError,
    voiceInteractionState, toggleAdvancedVoice
  } = useAdvancedVoice(handleFinalCommand, handleInterrupt);

  let orbState = 'off';
  let statusText = 'Tap to start voice';
  let ariaLabel = 'Start voice mode';

  if (voiceError) {
    statusText = voiceError;
  } else if (isVoiceModeActive) {
    if (voiceInteractionState === 'speaking') {
      orbState = 'speaking';
      statusText = 'ARC-AI is speaking — tap to interrupt';
      ariaLabel = 'Interrupt and listen';
    } else if (voiceInteractionState === 'processing') {
      orbState = 'processing';
      statusText = agentStatus || 'Thinking...';
      ariaLabel = 'Cancel generation';
    } else {
      orbState = 'listening';
      statusText = voiceMode === 'server' ? 'Listening (server mode)' : 'Listening...';
      ariaLabel = 'Stop voice mode';
    }
  }

  const cfg = stateConfig[orbState] || stateConfig.off;

  if (!isOpen) return null;

  return (
    <Overlay role="dialog" aria-label="Voice mode">
      <CloseButton onClick={onClose} aria-label="Close voice overlay">×</CloseButton>

      <StateLabel>{isVoiceModeActive ? 'Voice Active' : 'Voice Mode'}</StateLabel>

      <OrbShell>
        {isVoiceModeActive && (
          <OrbGlow $color={cfg.color} $shadow={cfg.shadow} $scale={cfg.scale} $animationCss={cfg.animationCss} />
        )}
        <OrbButton
          onClick={toggleAdvancedVoice}
          $color={cfg.color}
          $shadow={cfg.shadow}
          $scale={cfg.scale}
          aria-label={ariaLabel}
        >
          {isVoiceModeActive ? (
            <StopSquare />
          ) : (
            <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#fff' }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          )}
        </OrbButton>
      </OrbShell>

      <StatusText>{statusText}</StatusText>
      <TranscriptText>{liveTranscript || (isVoiceModeActive && isVoiceModeActive ? '...' : '')}</TranscriptText>
    </Overlay>
  );
};

export default VoiceOverlay;
