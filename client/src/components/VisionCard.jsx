import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import { useChat } from '../contexts/ChatContext';
import { useConversation } from '../contexts/ConversationContext';
import LiveVisionCamera from './LiveVisionCamera';

/**
 * VisionCard — vision as a contextual floating card over the conversation.
 *
 * Reuses the proven LiveVisionCamera (devices, front/back, capture path) and
 * registers its capture function through the existing ChatContext live-vision
 * ref, so voice turns and text sends both attach the latest frame via the
 * established multimodal pipeline. Adds what the overlay lacked: an inline
 * question composer (text + voice) so users never leave the conversation.
 */

const Card = styled.div`
  position: fixed;
  left: 16px;
  bottom: 96px;
  z-index: 1500;
  width: 300px;
  max-width: calc(100vw - 32px);
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(8, 8, 22, 0.95);
  backdrop-filter: blur(12px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  overflow: hidden;

  @media (max-width: 640px) {
    left: 12px;
    right: 12px;
    width: auto;
    bottom: 88px;
  }
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 8px 9px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${({ $live }) => ($live ? '#4dffb0' : 'rgba(255, 255, 255, 0.45)')};
`;

const LiveDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${({ $live }) => ($live ? '#4dffb0' : 'rgba(255,255,255,0.25)')};
  box-shadow: ${({ $live }) => ($live ? '0 0 8px rgba(77,255,176,0.8)' : 'none')};
  flex-shrink: 0;
`;

const HeaderSpacer = styled.span` flex: 1; `;

const HeaderButton = styled.button`
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  &:hover { color: #fff; background: rgba(255, 255, 255, 0.07); }
`;

const Body = styled.div`
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(52vh, 420px);
  overflow-y: auto;
`;

const PreviewBox = styled.div`
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(110, 132, 177, 0.25);
  background: #0c1327;
  & video { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
`;

const CollapsedBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
`;

const QuestionForm = styled.form`
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 11px;
  padding: 5px 5px 5px 10px;
  transition: border-color 0.15s;
  &:focus-within { border-color: rgba(var(--primary-rgb), 0.3); }
`;

const QuestionInput = styled.input`
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: #eef2f9;
  font-size: 13px;
  font-family: inherit;
  &::placeholder { color: rgba(255, 255, 255, 0.28); }
`;

const SmallButton = styled.button`
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: ${({ $primary }) => ($primary ? 'var(--primary-hex)' : 'transparent')};
  color: ${({ $primary }) => ($primary ? '#050510' : 'rgba(255, 255, 255, 0.5)')};
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  &:hover { filter: brightness(1.1); background: ${({ $primary }) => ($primary ? 'var(--primary-hex)' : 'rgba(255, 255, 255, 0.06)')}; }
  &:disabled { opacity: 0.35; cursor: not-allowed; }
`;

const FrameHint = styled.div`
  font-size: 11px;
  color: ${({ $ready, $warn }) => ($warn ? '#ffcf70' : $ready ? 'rgba(77, 255, 176, 0.75)' : 'rgba(255, 255, 255, 0.35)')};
  text-align: center;
`;

const VisionCard = ({ onClose, onRequestVoice }) => {
  const { sendCommand, isConnected } = useSocket();
  const { isProcessing, isStreaming, isSpeaking, setLiveVisionCapture, getLiveVisionFrame } = useChat();
  const { activeConversationId, ensureConversationReady } = useConversation();
  const [collapsed, setCollapsed] = useState(false);
  const [cameraLive, setCameraLive] = useState(false);
  const [question, setQuestion] = useState('');
  const [frameNote, setFrameNote] = useState('');
  const captureRef = useRef(() => null);
  const noteTimerRef = useRef(null);

  const isBusy = isProcessing || isStreaming || isSpeaking || !isConnected;

  // Bridge the proven camera capture path into the shared live-vision ref so
  // text sends (here + main composer) and voice turns attach the same frame.
  const handleCaptureReady = useCallback((captureFn) => {
    const safe = typeof captureFn === 'function' ? captureFn : () => null;
    captureRef.current = safe;
    setLiveVisionCapture(safe);
  }, [setLiveVisionCapture]);

  useEffect(() => {
    return () => {
      setLiveVisionCapture(() => null);
      clearTimeout(noteTimerRef.current);
    };
  }, [setLiveVisionCapture]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const text = question.trim();
    if (!text || isBusy) return;
    const frame = getLiveVisionFrame() || captureRef.current?.() || null;
    setQuestion('');
    setCollapsed(true);
    // Transparency: if the camera should have provided a frame but didn't
    // (e.g. not warmed up yet), say so instead of silently sending text-only.
    if (!frame && cameraLive) {
      setFrameNote('Camera was not ready — sent without a frame');
      clearTimeout(noteTimerRef.current);
      noteTimerRef.current = setTimeout(() => setFrameNote(''), 6000);
    }
    try {
      const cid = await ensureConversationReady?.('New Conversation');
      sendCommand(text, frame, null, cid || activeConversationId);
    } catch {
      sendCommand(text, frame);
    }
  };

  return (
    <Card role="region" aria-label="Live vision">
      <Header $live={cameraLive}>
        <LiveDot $live={cameraLive} />
        {cameraLive ? 'Vision live' : 'Vision'}
        <HeaderSpacer />
        <HeaderButton type="button" onClick={() => setCollapsed(c => !c)} aria-label={collapsed ? 'Expand vision' : 'Collapse vision'}>
          {collapsed ? '▴' : '▾'}
        </HeaderButton>
        <HeaderButton type="button" onClick={onClose} aria-label="Close vision">×</HeaderButton>
      </Header>

      {collapsed ? (
        <CollapsedBar>
          <LiveDot $live={cameraLive} />
          {cameraLive ? 'Vision active' : 'Vision ready'}
        </CollapsedBar>
      ) : (
        <Body>
          <PreviewBox>
            <LiveVisionCamera
              onCaptureReady={handleCaptureReady}
              initialEnabled
              onStatusChange={setCameraLive}
            />
          </PreviewBox>

          <QuestionForm onSubmit={handleSubmit}>
            <QuestionInput
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder={cameraLive ? 'Ask ARC about what you see…' : 'Ask ARC anything…'}
              aria-label="Ask about the camera view"
              disabled={isBusy}
            />
            <SmallButton type="button" onClick={onRequestVoice} aria-label="Ask by voice" title="Ask by voice">
              🎤
            </SmallButton>
            <SmallButton type="submit" $primary disabled={!question.trim() || isBusy} aria-label="Send vision question">
              ↑
            </SmallButton>
          </QuestionForm>
          <FrameHint $ready={cameraLive && !frameNote} $warn={Boolean(frameNote)}>
            {frameNote || (cameraLive ? '✓ Current frame attaches to your question' : 'Starting camera…')}
          </FrameHint>
        </Body>
      )}
    </Card>
  );
};

export default VisionCard;
