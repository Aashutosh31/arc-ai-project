import React, { useCallback, useRef } from 'react';
import styled, { css, keyframes } from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import { useAdvancedVoice } from '../hooks/useAdvancedVoice';
import { useChat } from '../contexts/ChatContext';
import { useConversation } from '../contexts/ConversationContext';
import LiveVisionCamera from './LiveVisionCamera';

const pulse = keyframes`
  0% { transform: scale(1); opacity: 0.45; }
  50% { transform: scale(1.08); opacity: 0.25; }
  100% { transform: scale(1); opacity: 0.45; }
`;

const bounce = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
`;

const Wrapper = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 14px 8px 8px;
`;

const Heading = styled.h4`
  margin: 0;
  font-size: clamp(18px, 4.2vw, 24px);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #f2f4ff;
`;

const Subtitle = styled.p`
  margin: 0;
  text-align: center;
  font-size: 13px;
  line-height: 1.45;
  color: #d7daea;
  max-width: 340px;
`;

const OrbShell = styled.div`
  position: relative;
  width: clamp(88px, 20vw, 128px);
  height: clamp(88px, 20vw, 128px);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const stateStyles = {
  off: {
    bg: '#384055',
    shadow: 'none',
    transform: 'scale(1)',
    pulse: false,
    animation: 'none',
  },
  listening: {
    bg: '#22d3ee',
    shadow: '0 0 40px rgba(34, 211, 238, 0.78)',
    transform: 'scale(1.13)',
    pulse: true,
    animation: css`${pulse} 1.9s cubic-bezier(0.2, 0, 0.2, 1) infinite`,
  },
  speaking: {
    bg: '#a855f7',
    shadow: '0 0 30px rgba(168, 85, 247, 0.64)',
    transform: 'scale(1.08)',
    pulse: true,
    animation: css`${pulse} 1.4s ease-in-out infinite`,
  },
  processing: {
    bg: '#facc15',
    shadow: '0 0 24px rgba(250, 204, 21, 0.52)',
    transform: 'scale(1.05)',
    pulse: true,
    animation: css`${bounce} 1.2s ease-in-out infinite`,
  },
};

const Glow = styled.div`
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: ${({ $state }) => stateStyles[$state].bg};
  opacity: 0.36;
  box-shadow: ${({ $state }) => stateStyles[$state].shadow};
  transform: ${({ $state }) => stateStyles[$state].transform};
  animation: ${({ $state }) => stateStyles[$state].animation};
`;

const Button = styled.button`
  position: relative;
  z-index: 1;
  width: clamp(64px, 16vw, 84px);
  height: clamp(64px, 16vw, 84px);
  border-radius: 999px;
  border: none;
  outline: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${({ $state }) => stateStyles[$state].bg};
  box-shadow: ${({ $state }) => stateStyles[$state].shadow};
  transform: ${({ $state }) => stateStyles[$state].transform};
  transition: transform 180ms ease, box-shadow 180ms ease, background 180ms ease;

  &:hover {
    transform: ${({ $state }) =>
      $state === 'off' ? 'scale(1.04)' : stateStyles[$state].transform};
  }
`;

const StopIcon = styled.div`
  width: 24px;
  height: 24px;
  background: #fff;
  border-radius: 4px;
`;

const StatusArea = styled.div`
  text-align: center;
  min-height: 48px;
`;

const StatusText = styled.p`
  margin: 0;
  font-size: 15px;
  color: #d5d8ec;
  font-weight: 600;
  letter-spacing: 0.02em;
`;

const Transcript = styled.p`
  margin: 8px 0 0;
  font-size: 12px;
  font-style: italic;
  color: #65d9ff;
  width: 260px;
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const AdvancedVoiceButton = () => {
  const { sendCommand, interruptStream } = useSocket();
  const { isProcessing, isSpeaking, agentStatus, setLiveVisionCapture } = useChat();
  const captureFrameRef = useRef(() => null);
  const { activeConversationId, ensureConversationReady } = useConversation();

  const handleCaptureReady = useCallback((captureFn) => {
    const safeCapture = typeof captureFn === 'function' ? captureFn : () => null;
    captureFrameRef.current = safeCapture;
    setLiveVisionCapture(safeCapture);
  }, [setLiveVisionCapture]);

  // 1. Hook up the VAD Engine to our Socket controls!
  const handleFinalCommand = (transcript) => {
    if (transcript.trim()) {
      const currentFrame = captureFrameRef.current?.() || null;
      (async () => {
        try {
          const cid = await ensureConversationReady?.('New Conversation');
          sendCommand(transcript, currentFrame, null, cid || activeConversationId);
        } catch (err) {
          // fallback to sending without conversation id
          console.warn('Voice command failed to attach to conversation, sending without id', err?.message || err);
          sendCommand(transcript, currentFrame);
        }
      })();
    }
  };

  const handleInterrupt = () => {
    // If the AI is talking or processing, instantly cut it off!
    if (isSpeaking || isProcessing) {
      interruptStream();
    }
  };

  const { isVoiceModeActive, liveTranscript, voiceMode, voiceError, voiceInteractionState, toggleAdvancedVoice } = useAdvancedVoice(
    handleFinalCommand,
    handleInterrupt
  );

  let orbState = 'off';
  let statusText = "Click to Start Advanced Voice";
  let ariaLabel = 'Start advanced voice mode';

  if (voiceError) {
    statusText = voiceError;
  } else if (isVoiceModeActive) {
    // Explicit voice interaction state drives the UI so the button never
    // claims "Listening..." while the mic is off, nor "Speaking..." after
    // audio finished.
    if (voiceInteractionState === 'speaking') {
      orbState = 'speaking';
      statusText = "ARC-AI is speaking... (tap to interrupt)";
      ariaLabel = 'Interrupt ARC and start listening';
    } else if (voiceInteractionState === 'processing') {
      orbState = 'processing';
      statusText = agentStatus || "Thinking...";
      ariaLabel = 'Cancel generation and stop advanced voice mode';
    } else if (voiceInteractionState === 'interrupted') {
      orbState = 'listening';
      statusText = "Listening...";
      ariaLabel = 'Stop advanced voice mode';
    } else if (voiceInteractionState === 'error') {
      orbState = 'off';
      statusText = voiceError || "Voice error — tap to retry";
      ariaLabel = 'Stop advanced voice mode';
    } else {
      orbState = 'listening';
      statusText = voiceMode === 'server'
        ? "Listening... (server transcription)"
        : "Listening... (Just start talking)";
      ariaLabel = 'Stop advanced voice mode';
    }
  }

  return (
    <Wrapper>
      <Heading>Advanced Voice Mode</Heading>
      <Subtitle>
        Continuous conversation. Automatic silence detection. Instant barge-in.
      </Subtitle>

      <OrbShell>
        {isVoiceModeActive && (
          <Glow $state={orbState} />
        )}

        <Button
          onClick={toggleAdvancedVoice}
          $state={orbState}
          aria-label={ariaLabel}
        >
          {isVoiceModeActive ? (
            <StopIcon />
          ) : (
            <svg width="34" height="34" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#fff' }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
            </svg>
          )}
        </Button>
      </OrbShell>

      <StatusArea>
        <StatusText>{statusText}</StatusText>
        <Transcript>
          {liveTranscript || (isVoiceModeActive && "...")}
        </Transcript>
      </StatusArea>

      <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
        <LiveVisionCamera onCaptureReady={handleCaptureReady} />
      </div>
    </Wrapper>
  );
};

export default AdvancedVoiceButton;