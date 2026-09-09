import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useChat, sanitizeForDisplay } from '../contexts/ChatContext';
import { useSocket } from '../hooks/useSocket';
import { useConversation } from '../contexts/ConversationContext';
import { useExecution } from '../contexts/ExecutionContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import MarkdownRenderer from './MarkdownRenderer';

/* Fluid readable column: full width on small screens, capped prose width
   on desktop. Code/tables break out wider via MarkdownBody rules. */
const CONTENT_MAX = 'min(980px, 100%)';

const Waveform = keyframes`
  0%, 100% { height: 8px; }
  50% { height: 16px; }
`;

const typing = keyframes`
  0%, 100% { transform: translateY(0); opacity: 0.4; }
  50% { transform: translateY(-4px); opacity: 1; }
`;

const ChatWrapper = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
`;

const MessageArea = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 16px 8px;
  display: flex;
  flex-direction: column;
  justify-content: ${({ $empty }) => ($empty ? 'center' : 'flex-start')};
  align-items: ${({ $empty }) => ($empty ? 'center' : 'stretch')};
  scroll-behavior: smooth;
  /* 'contain' only where this area is itself the scroller (desktop).
     Below the shell breakpoint the page scrolls instead, and 'contain'
     on this content-sized box traps wheel/touch so the page never scrolls. */
  overscroll-behavior: auto;
  @media (min-width: 1000px) {
    overscroll-behavior: contain;
  }
  &::-webkit-scrollbar { width: 5px; }
  &::-webkit-scrollbar-track { background: transparent; }
  &::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.08); border-radius: 4px; }
  &::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.15); }

  @media (max-width: 640px) {
    padding: 14px 12px 6px;
  }
`;

const MessageRow = styled.div`
  display: flex;
  flex-direction: column;
  max-width: ${CONTENT_MAX};
  width: 100%;
  margin: 0 auto;
  padding: ${({ $role }) => ($role === 'user' ? '6px 0 6px 48px' : '14px 0')};
  align-items: ${({ $role }) => ($role === 'user' ? 'flex-end' : 'stretch')};

  @media (max-width: 640px) {
    padding: ${({ $role }) => ($role === 'user' ? '5px 0 5px 24px' : '10px 0')};
  }
`;

/* Compact bubble reserved for user messages only. */
const UserBubble = styled.div`
  padding: 9px 15px;
  border-radius: 18px 18px 5px 18px;
  background: rgba(0, 255, 255, 0.09);
  border: 1px solid rgba(0, 255, 255, 0.16);
  width: fit-content;
  max-width: min(720px, 100%);
  overflow-wrap: anywhere;
  word-break: break-word;
`;

const UserText = styled.div`
  font-size: 14.5px;
  line-height: 1.6;
  color: #e8eef7;
  white-space: pre-wrap;
`;

/* Assistant content reads like a document, not a bubble. */
const AssistantDoc = styled.div`
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
`;

const AssistantLabel = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(125, 247, 255, 0.55);
`;

const AssistantAvatar = styled.span`
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0;
  color: #050510;
  background: linear-gradient(135deg, #00ffff, #b887ff);
`;

const BubbleImage = styled.img`
  display: block;
  max-width: 100%;
  max-height: 220px;
  width: auto;
  border-radius: 8px;
  margin-top: 8px;
`;

const DocumentChip = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 8px;
`;

const WaveformBars = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  height: 16px;
  div {
    width: 2px;
    background: var(--primary-hex);
    border-radius: 2px;
    animation: ${Waveform} 1s ease-in-out infinite;
  }
  div:nth-child(2) { animation-delay: 0.1s; }
  div:nth-child(3) { animation-delay: 0.2s; }
  div:nth-child(4) { animation-delay: 0.3s; }
`;

const TypingIndicator = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 8px 0;
  span {
    width: 5px;
    height: 5px;
    background: rgba(0, 255, 255, 0.5);
    border-radius: 50%;
    animation: ${typing} 1.4s infinite ease-in-out both;
  }
  span:nth-child(1) { animation-delay: -0.32s; }
  span:nth-child(2) { animation-delay: -0.16s; }
`;

const StopButton = styled.button`
  align-self: center;
  background: rgba(255, 60, 60, 0.08);
  border: 1px solid rgba(255, 60, 60, 0.25);
  color: #ff7070;
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  margin-top: 8px;
  transition: all 0.2s;
  &:hover { background: rgba(255, 60, 60, 0.15); color: #ff9f9f; }
`;

const HistoryButton = styled.button`
  align-self: center;
  border: 1px solid rgba(0, 255, 255, 0.12);
  background: transparent;
  color: rgba(0, 255, 255, 0.6);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 8px;
  transition: all 0.2s;
  &:hover { background: rgba(0, 255, 255, 0.06); color: #00ffff; }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;

const Composer = styled.div`
  flex-shrink: 0;
  padding: 8px 16px 16px;
  max-width: ${CONTENT_MAX};
  width: 100%;
  margin: 0 auto;
`;

const ComposerInner = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 16px;
  padding: 8px;
  transition: border-color 0.2s, box-shadow 0.2s;
  &:focus-within {
    border-color: rgba(0, 255, 255, 0.28);
    box-shadow: 0 0 0 3px rgba(0, 255, 255, 0.05);
  }
`;

const IconButton = styled.button`
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font-size: 17px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
  position: relative;
  &:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
`;

const AttachMenu = styled.div`
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  background: rgba(12, 12, 28, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.6);
  min-width: 200px;
  z-index: 10;
`;

const AttachOption = styled.button`
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: #e2e8f0;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: background 0.15s;
  &:hover { background: rgba(255, 255, 255, 0.05); }
`;

const AttachOptionHint = styled.span`
  margin-left: auto;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
`;

const AttachMenuDivider = styled.div`
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 5px 8px;
`;

const TextInput = styled.textarea`
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: #eef2f9;
  font-size: 14.5px;
  line-height: 1.55;
  resize: none;
  outline: none;
  min-height: 24px;
  max-height: 140px;
  padding: 5px 2px;
  font-family: inherit;
  &::placeholder { color: rgba(255, 255, 255, 0.28); }
`;

const SendButton = styled.button`
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: none;
  background: ${({ $disabled }) => ($disabled ? 'rgba(0, 255, 255, 0.1)' : '#00e5e5')};
  color: ${({ $disabled }) => ($disabled ? 'rgba(0, 255, 255, 0.35)' : '#050510')};
  cursor: ${({ $disabled }) => ($disabled ? 'not-allowed' : 'pointer')};
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
  &:hover { filter: ${({ $disabled }) => ($disabled ? 'none' : 'brightness(1.12)')}; }
`;

const PreviewRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 4px 8px;
`;

const PreviewItem = styled.div`
  position: relative;
  display: inline-flex;
`;

const PreviewImg = styled.img`
  max-height: 48px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
`;

const RemovePreview = styled.button`
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 60, 60, 0.85);
  color: #fff;
  font-size: 9px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
  padding: 20px;
  max-width: 560px;
`;

const EmptyTitle = styled.h2`
  margin: 0;
  font-size: clamp(24px, 3.2vw, 34px);
  color: #f1f5f9;
  font-weight: 700;
  letter-spacing: -0.025em;
`;

const EmptySub = styled.p`
  margin: 0;
  font-size: 14.5px;
  color: rgba(255, 255, 255, 0.45);
  max-width: 440px;
  line-height: 1.65;
`;

const SuggestionGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
  max-width: 520px;
`;

const SuggestionChip = styled.button`
  padding: 9px 15px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.65);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  &:hover {
    border-color: rgba(0, 255, 255, 0.3);
    background: rgba(0, 255, 255, 0.06);
    color: #d9fbff;
  }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;

const PresenceBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  margin: 0 auto 8px;
  max-width: ${CONTENT_MAX};
  width: 100%;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
`;

const PresenceDot = styled.span`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${({ $status }) => ($status === 'Completed' ? '#4dffb0' : $status === 'Failed' ? '#ff7070' : '#00ffff')};
`;

const INITIAL_MESSAGES = 60;
const LOAD_MORE = 40;

const SUGGESTIONS = [
  { icon: '💡', label: 'Explain a concept', prompt: 'Explain a fascinating science concept in simple terms' },
  { icon: '💻', label: 'Help me code', prompt: 'Help me write clean, well explained code for a common task' },
  { icon: '🔍', label: 'Search the web', prompt: 'Search the web for the latest developments in artificial intelligence' },
  { icon: '📅', label: 'Check my calendar', prompt: 'What is on my calendar coming up?' },
  { icon: '🖼️', label: 'Analyze an image', prompt: 'I want to share an image for you to analyze' },
];

const ChatMessage = memo(({ msg, isSpeaking, isLast }) => {
  const text = String(msg.text || '');

  if (msg.sender === 'user') {
    return (
      <MessageRow $role="user">
        <UserBubble>
          <UserText>{text}</UserText>
          {msg.image && <BubbleImage src={msg.image} alt="Upload" />}
          {msg.documentName && <DocumentChip>📄 {msg.documentName}</DocumentChip>}
        </UserBubble>
      </MessageRow>
    );
  }

  return (
    <MessageRow $role="assistant">
      <AssistantDoc>
        <AssistantLabel>
          <AssistantAvatar>A</AssistantAvatar>
          ARC-AI
        </AssistantLabel>
        <MarkdownRenderer content={text} isStreaming={Boolean(msg.isStreaming)} />
        {(msg.isStreaming || (isSpeaking && isLast)) && (
          <WaveformBars><div /><div /><div /><div /></WaveformBars>
        )}
      </AssistantDoc>
    </MessageRow>
  );
});

ChatMessage.displayName = 'ChatMessage';

const ChatInterface = ({ onOpenVoice, onOpenVision, onOpenTools, seedText }) => {
  const { messages, replaceMessages, clearMessages, isProcessing, isStreaming, isSpeaking, getLiveVisionFrame } = useChat();
  const { interruptStream, sendCommand, socket, isConnected } = useSocket();
  const { activeExecution, presence, cancelActiveExecution } = useExecution();
  const { activeConversationId, activeConversationRevision, switchConversation, fetchConversations, fetchConversationMessages, updateConversationTitle, ensureConversationReady, isFirstMessageSendingRef } = useConversation();
  const { activeWorkspaceId } = useWorkspace();

  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_MESSAGES);

  const messageEndRef = useRef(null);
  const messageAreaRef = useRef(null);
  const historyScrollRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const loadedWorkspaceCountRef = useRef(0);
  const messageLoadSeqRef = useRef(0);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const docInputRef = useRef(null);

  const isBusy = isProcessing || isStreaming || isSpeaking || !isConnected;

  const handleCancel = () => { cancelActiveExecution?.(); interruptStream(); };

  useEffect(() => {
    if (!socket) return;
    const onCreated = (data) => {
      if (data?.conversationId) {
        if (data?.workspaceId && activeWorkspaceId && String(data.workspaceId) !== String(activeWorkspaceId)) return;
        switchConversation(data.conversationId);
        fetchConversations().catch(() => {});
      }
    };
    socket.on('ai:conversation:created', onCreated);
    return () => socket.off('ai:conversation:created', onCreated);
  }, [socket, switchConversation, fetchConversations, activeWorkspaceId]);

  useEffect(() => {
    if (!socket) return;
    const onTitle = (data) => {
      if (!data?.conversationId || !data?.title) return;
      if (data?.workspaceId && activeWorkspaceId && String(data.workspaceId) !== String(activeWorkspaceId)) return;
      updateConversationTitle(data.conversationId, data.title, data.workspaceId || null);
    };
    socket.on('ai:conversation:title', onTitle);
    return () => socket.off('ai:conversation:title', onTitle);
  }, [socket, updateConversationTitle, activeWorkspaceId]);

  useEffect(() => {
    const seq = messageLoadSeqRef.current + 1;
    messageLoadSeqRef.current = seq;
    let cancelled = false;
    const isStale = () => cancelled || seq !== messageLoadSeqRef.current;

    const load = async () => {
      if (!activeConversationId) {
        if (activeWorkspaceId) loadedWorkspaceCountRef.current += 1;
        if (loadedWorkspaceCountRef.current > 1) clearMessages();
        return;
      }
      if (isFirstMessageSendingRef?.current) { isFirstMessageSendingRef.current = false; return; }
      try {
        const db = await fetchConversationMessages(activeConversationId, { limit: 500, skip: 0 });
        if (isStale()) return;
        const mapped = db.map(m => ({ sender: m.role === 'user' ? 'user' : 'ai', text: sanitizeForDisplay(String(m.content || '')), isStreaming: false }));
        replaceMessages(mapped);
      } catch (e) { if (!isStale()) console.error('Failed loading messages:', e); }
    };
    load();
    return () => { cancelled = true; };
  }, [activeConversationId, activeConversationRevision, fetchConversationMessages, replaceMessages, clearMessages]);

  useEffect(() => {
    setVisibleCount(c => Math.min(Math.max(c, INITIAL_MESSAGES), messages.length));
  }, [messages.length]);

  const visibleMessages = messages.slice(Math.max(0, messages.length - visibleCount));

  const isNearBottom = (el) => {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  };

  const handleScroll = () => {
    shouldAutoScrollRef.current = isNearBottom(messageAreaRef.current);
  };

  useLayoutEffect(() => {
    const el = messageAreaRef.current;
    const snap = historyScrollRef.current;
    if (el && snap) {
      el.scrollTop = snap.scrollTop + (el.scrollHeight - snap.scrollHeight);
      historyScrollRef.current = null;
    }
  }, [visibleCount]);

  const handleLoadMore = () => {
    const el = messageAreaRef.current;
    if (el) historyScrollRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    setVisibleCount(c => Math.min(messages.length, c + LOAD_MORE));
  };

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    messageAreaRef.current?.scrollTo({ top: messageAreaRef.current.scrollHeight, behavior: isBusy ? 'auto' : 'smooth' });
  }, [messages, isProcessing, isSpeaking, isBusy]);

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.code === 'Space' && isBusy) { e.preventDefault(); e.stopPropagation(); handleCancel(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isBusy, interruptStream]);

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > 800) { h *= 800 / w; w = 800; }
        if (h > 800) { w *= 800 / h; h = 800; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        setSelectedImage({ file: URL.createObjectURL(file), base64: canvas.toDataURL('image/jpeg', 0.7).split(',')[1] });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = null;
    setShowAttachMenu(false);
  };

  const handleDocUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setSelectedDocument({ name: file.name, type: file.type, base64: reader.result.split(',')[1] });
    };
    reader.readAsDataURL(file);
    e.target.value = null;
    setShowAttachMenu(false);
  };

  const sendText = async (rawText) => {
    const text = String(rawText || '').trim();
    if ((!text && !selectedImage && !selectedDocument) || isBusy) return;
    const img = selectedImage?.base64 || null;
    const frame = img ? null : getLiveVisionFrame();
    const cid = await ensureConversationReady?.('New Conversation');
    sendCommand(text, img || frame, selectedDocument, cid || activeConversationId);
    setInputText('');
    setSelectedImage(null);
    setSelectedDocument(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleSubmit = (e) => {
    e?.preventDefault();
    sendText(inputText);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextareaInput = (e) => {
    setInputText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
  };

  const isEmpty = visibleMessages.length === 0;
  const canSend = (!inputText.trim() && !selectedImage && !selectedDocument) || isBusy;

  // External seed (e.g. ToolsPanel "Try it"): fill composer, focus, don't auto-send.
  const lastSeedNonce = useRef(0);
  useEffect(() => {
    if (!seedText || seedText.nonce === lastSeedNonce.current) return;
    lastSeedNonce.current = seedText.nonce;
    if (typeof seedText.text === 'string') {
      setInputText(seedText.text);
      const ta = textareaRef.current;
      if (ta) {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
        ta.focus();
      }
    }
  }, [seedText]);

  return (
    <ChatWrapper>
      <MessageArea ref={messageAreaRef} onScroll={handleScroll} $empty={isEmpty}>
        {messages.length > visibleMessages.length && (
          <HistoryButton onClick={handleLoadMore} disabled={visibleCount >= messages.length}>
            Load earlier ({messages.length - visibleMessages.length} hidden)
          </HistoryButton>
        )}

        {activeExecution && (
          <PresenceBar>
            <PresenceDot $status={presence} />
            <span>{presence}</span>
            <span style={{ opacity: 0.6 }}>· {activeExecution.title || 'Execution'}</span>
          </PresenceBar>
        )}

        {isEmpty ? (
          <EmptyState>
            <EmptyTitle>What can I help with?</EmptyTitle>
            <EmptySub>Ask ARC anything — explain, code, search, schedule, or analyze.</EmptySub>
            <SuggestionGrid>
              {SUGGESTIONS.map(s => (
                <SuggestionChip
                  key={s.label}
                  type="button"
                  disabled={isBusy}
                  onClick={() => sendText(s.prompt)}
                >
                  <span>{s.icon}</span>
                  {s.label}
                </SuggestionChip>
              ))}
            </SuggestionGrid>
          </EmptyState>
        ) : (
          visibleMessages.map((msg, i) => (
            <ChatMessage
              key={`${messages.length - visibleMessages.length + i}`}
              msg={msg}
              isSpeaking={isSpeaking}
              isLast={i === visibleMessages.length - 1}
            />
          ))
        )}

        {isProcessing && (visibleMessages.length === 0 || visibleMessages[visibleMessages.length - 1].sender !== 'ai') && (
          <MessageRow $role="assistant">
            <AssistantDoc>
              <AssistantLabel>
                <AssistantAvatar>A</AssistantAvatar>
                ARC-AI
              </AssistantLabel>
              <TypingIndicator><span /><span /><span /></TypingIndicator>
            </AssistantDoc>
          </MessageRow>
        )}

        {isBusy && (
          <StopButton onClick={handleCancel}>
            {isSpeaking ? 'Stop Speaking' : 'Stop'} (Space)
          </StopButton>
        )}
        <div ref={messageEndRef} />
      </MessageArea>

      <Composer>
        {(selectedImage || selectedDocument) && (
          <PreviewRow>
            {selectedImage && (
              <PreviewItem>
                <RemovePreview onClick={() => setSelectedImage(null)}>×</RemovePreview>
                <PreviewImg src={selectedImage.file} alt="Preview" />
              </PreviewItem>
            )}
            {selectedDocument && (
              <PreviewItem>
                <RemovePreview onClick={() => setSelectedDocument(null)}>×</RemovePreview>
                <DocumentChip style={{ margin: 0 }}>📄 {selectedDocument.name}</DocumentChip>
              </PreviewItem>
            )}
          </PreviewRow>
        )}

        <ComposerInner as="form" onSubmit={handleSubmit}>
          <IconButton type="button" onClick={() => setShowAttachMenu(p => !p)} aria-label="Attachments and tools">
            +
            {showAttachMenu && (
              <AttachMenu onClick={e => e.stopPropagation()}>
                <AttachOption type="button" onClick={() => { imageInputRef.current?.click(); }}>
                  <span>🖼️</span> Upload image
                </AttachOption>
                <AttachOption type="button" onClick={() => { docInputRef.current?.click(); }}>
                  <span>📄</span> Upload document
                </AttachOption>
                <AttachMenuDivider />
                <AttachOption type="button" onClick={() => { setShowAttachMenu(false); onOpenVision?.(); }}>
                  <span>📷</span> Camera / Vision
                  <AttachOptionHint>live</AttachOptionHint>
                </AttachOption>
                <AttachOption type="button" onClick={() => { setShowAttachMenu(false); onOpenVoice?.(); }}>
                  <span>🎤</span> Voice mode
                </AttachOption>
                <AttachOption type="button" onClick={() => { setShowAttachMenu(false); onOpenTools?.(); }}>
                  <span>🛠️</span> Browse tools
                </AttachOption>
              </AttachMenu>
            )}
          </IconButton>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} style={{ display: 'none' }} />
          <input ref={docInputRef} type="file" accept=".txt,.csv,.md,.json,.pdf" onChange={handleDocUpload} style={{ display: 'none' }} />

          <TextInput
            ref={textareaRef}
            rows={1}
            placeholder={
              !isConnected ? 'Connecting...' :
              isSpeaking ? 'Listening...' :
              'Ask ARC anything...'
            }
            value={inputText}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            disabled={isBusy}
            aria-label="Message input"
          />

          <IconButton type="button" onClick={() => onOpenVoice?.()} aria-label="Voice mode" title="Voice mode">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </IconButton>

          <SendButton
            type="submit"
            $disabled={canSend}
            disabled={canSend}
            aria-label="Send message"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </SendButton>
        </ComposerInner>
      </Composer>
    </ChatWrapper>
  );
};

export default ChatInterface;
