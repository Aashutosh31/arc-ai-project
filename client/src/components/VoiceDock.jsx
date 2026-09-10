import React, { useEffect, useRef } from 'react';
import styled, { css, keyframes } from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import { useAdvancedVoice } from '../hooks/useAdvancedVoice';
import { useChat } from '../contexts/ChatContext';
import { useConversation } from '../contexts/ConversationContext';

/**
 * VoiceDock — voice as a contextual floating capability, not a fullscreen app.
 *
 * Owns exactly one useAdvancedVoice session (machine, turn ids, half-duplex
 * lifecycle untouched). Visual model:
 *   idle       → compact "Voice ready" pill
 *   listening  → expanded orb + transcript + mute
 *   muted      → compact "Mic muted" pill (session stays alive)
 *   processing → compact "Thinking…" pill
 *   speaking   → compact "ARC speaking — tap to stop" (one-tap barge-in)
 * The conversation stays visible in every state.
 */

const pulse = keyframes`
  0% { transform: scale(1); opacity: 0.4; }
  50% { transform: scale(1.1); opacity: 0.2; }
  100% { transform: scale(1); opacity: 0.4; }
`;

const thinkPulse = keyframes`
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
`;

const Dock = styled.div`
  position: fixed;
  right: 16px;
  bottom: 96px;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: min(280px, calc(100vw - 32px));

  @media (max-width: 640px) {
    right: 12px;
    bottom: 88px;
  }
`;

const Pill = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface-overlay);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow-md);
  font-size: 12.5px;
  color: var(--foreground-muted);
  max-width: 100%;
`;

const PillText = styled.span`
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
`;

const StatusDot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ $color }) => $color};
  box-shadow: 0 0 8px ${({ $color }) => $color};
  ${({ $pulse }) => $pulse && css`animation: ${thinkPulse} 1.2s ease-in-out infinite;`}
`;

const RoundButton = styled.button`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid ${({ $active }) => ($active ? 'rgba(var(--primary-rgb), 0.45)' : 'rgba(255, 255, 255, 0.12)')};
  background: ${({ $active }) => ($active ? 'rgba(var(--primary-rgb), 0.12)' : 'rgba(255, 255, 255, 0.04)')};
  color: ${({ $active }) => ($active ? 'var(--primary-hex)' : 'rgba(255, 255, 255, 0.6)')};
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
  &:hover { border-color: rgba(var(--primary-rgb), 0.4); color: var(--foreground); }
  &:disabled { opacity: 0.35; cursor: default; }
  &:disabled:hover { border-color: var(--border); color: var(--foreground-muted); }
`;

const CloseButton = styled.button`
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--foreground-subtle);
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &:hover { color: var(--foreground); background: rgba(255, 255, 255, 0.07); }
`;

const ExpandedCard = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 18px 14px;
  border-radius: 18px;
  border: 1px solid rgba(var(--primary-rgb), 0.16);
  background: var(--surface-overlay);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow-md), 0 0 24px rgba(var(--primary-rgb), 0.06);
  width: 240px;
  max-width: 100%;
`;

const OrbShell = styled.div`
  position: relative;
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const OrbGlow = styled.div`
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--primary-hex);
  opacity: 0.3;
  box-shadow: 0 0 30px rgba(var(--primary-rgb), 0.55);
  animation: ${pulse} 1.8s cubic-bezier(0.2, 0, 0.2, 1) infinite;
`;

const OrbButton = styled.button`
  position: relative;
  z-index: 1;
  width: 54px;
  height: 54px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-hex);
  box-shadow: 0 0 24px rgba(var(--primary-rgb), 0.5);
  color: var(--foreground);
  transition: filter 0.15s;
  &:hover { filter: brightness(1.12); }
`;

const StopSquare = styled.span`
  width: 16px;
  height: 16px;
  background: var(--foreground);
  border-radius: 3px;
`;

const Transcript = styled.p`
  margin: 0;
  font-size: 12px;
  font-style: italic;
  color: rgba(var(--accent-soft-rgb), 0.85);
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-height: 16px;
`;

const ExpandedRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const MuteButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid ${({ $muted }) => ($muted ? 'rgba(var(--warning-rgb), 0.4)' : 'rgba(255, 255, 255, 0.12)')};
  background: ${({ $muted }) => ($muted ? 'rgba(var(--warning-rgb), 0.08)' : 'rgba(255, 255, 255, 0.04)')};
  color: ${({ $muted }) => ($muted ? 'var(--warning)' : 'rgba(255, 255, 255, 0.6)')};
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  &:hover { border-color: var(--border); color: var(--foreground); }
  &:disabled { opacity: 0.35; cursor: default; }
`;

const MicIcon = () => (
  <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
  </svg>
);

const VoiceDock = ({ onClose, activateSignal }) => {
  const { sendCommand, interruptStream } = useSocket();
  const { isProcessing, isSpeaking, agentStatus, getLiveVisionFrame } = useChat();
  const { activeConversationId, ensureConversationReady } = useConversation();

  const handleFinalCommand = (transcript) => {
    if (transcript.trim()) {
      const frame = getLiveVisionFrame() || null;
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

  const {
    isVoiceModeActive, liveTranscript, voiceMode, voiceError,
    voiceInteractionState, toggleAdvancedVoice, micMuted, toggleMicMuted,
  } = useAdvancedVoice(handleFinalCommand, handleInterrupt);

  // External "start listening" requests (e.g. mic tap inside the vision card).
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!activateSignal || activateSignal === lastSignalRef.current) return;
    lastSignalRef.current = activateSignal;
    if (!isVoiceModeActive) {
      toggleAdvancedVoice();
    } else if (micMuted) {
      toggleMicMuted();
    }
    // Intentionally not in deps: signal edge only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateSignal]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const state = !isVoiceModeActive
    ? 'idle'
    : voiceError
      ? 'error'
      : voiceInteractionState === 'speaking'
        ? 'speaking'
        : voiceInteractionState === 'processing'
          ? 'processing'
          : micMuted
            ? 'muted'
            : 'listening';

  if (state === 'listening') {
    return (
      <Dock role="region" aria-label="Voice control">
        <ExpandedCard>
          <OrbShell>
            <OrbGlow />
            <OrbButton onClick={toggleAdvancedVoice} aria-label="Stop voice mode">
              <StopSquare />
            </OrbButton>
          </OrbShell>
          <Transcript>{liveTranscript || (voiceMode === 'server' ? 'Listening… speak now' : 'Listening…')}</Transcript>
          <ExpandedRow>
            <MuteButton type="button" $muted={false} onClick={toggleMicMuted} aria-label="Mute microphone">
              🎙 Mute
            </MuteButton>
            <CloseButton onClick={onClose} aria-label="Close voice">×</CloseButton>
          </ExpandedRow>
        </ExpandedCard>
      </Dock>
    );
  }

  const pill = (() => {
    // Status-dot colors are semantic tokens (behavior unchanged):
    // speaking -> violet accent, processing/muted -> warning,
    // error -> destructive, idle -> subtle foreground.
    switch (state) {
      case 'speaking':
        return { dot: 'var(--violet)', pulse: true, text: 'ARC speaking — tap to stop', action: toggleAdvancedVoice, label: 'Interrupt ARC and listen' };
      case 'processing':
        return { dot: 'var(--warning)', pulse: true, text: agentStatus || 'Thinking…', action: toggleAdvancedVoice, label: 'Cancel generation' };
      case 'muted':
        return { dot: 'var(--warning)', pulse: false, text: 'Mic muted', action: toggleMicMuted, label: 'Unmute microphone' };
      case 'error':
        return { dot: 'var(--destructive)', pulse: false, text: voiceError || 'Voice error', action: toggleAdvancedVoice, label: 'Retry voice mode' };
      default:
        return { dot: 'var(--foreground-subtle)', pulse: false, text: 'Voice ready — tap mic to talk', action: toggleAdvancedVoice, label: 'Start voice mode' };
    }
  })();

  const micDisabled = state === 'speaking' || state === 'processing';

  return (
    <Dock role="region" aria-label="Voice control">
      <Pill>
        <StatusDot $color={pill.dot} $pulse={pill.pulse} />
        <PillText>{pill.text}</PillText>
        {state !== 'idle' && state !== 'error' && state !== 'muted' ? (
          <RoundButton type="button" onClick={pill.action} aria-label={pill.label}>
            {state === 'speaking' ? '■' : '✕'}
          </RoundButton>
        ) : null}
        {(state === 'idle' || state === 'error') && (
          <RoundButton type="button" $active onClick={pill.action} aria-label={pill.label}>
            <MicIcon />
          </RoundButton>
        )}
        {state === 'muted' && (
          <PillText style={{ fontSize: 11, color: 'var(--foreground-subtle)' }}>
            Session active
          </PillText>
        )}
        <MuteButton
          type="button"
          $muted={micMuted}
          onClick={toggleMicMuted}
          disabled={micDisabled || !isVoiceModeActive}
          title={micDisabled ? 'Microphone stays off while ARC speaks' : micMuted ? 'Unmute microphone' : 'Mute microphone'}
          aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={micMuted}
        >
          {micMuted ? '🔇' : '🎙'}
        </MuteButton>
        <CloseButton onClick={onClose} aria-label="Close voice">×</CloseButton>
      </Pill>
    </Dock>
  );
};

export default VoiceDock;
