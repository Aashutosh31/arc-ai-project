import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useChat, sanitizeForDisplay } from '../contexts/ChatContext';
import { useSocket } from '../hooks/useSocket';
import { useConversation } from '../contexts/ConversationContext';
import { useExecution } from '../contexts/ExecutionContext';

const Waveform = keyframes`
  0%, 100% { height: 10px; transform: translateY(0); }
  50% { height: 20px; transform: translateY(-5px); }
`;

const typing = keyframes`
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-5px); opacity: 1; }
`;

const ChatWrapper = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  height: 100%;
  gap: 12px;
  position: relative;
  min-width: 0;
  min-height: 0;

  @media (max-width: 480px) {
    gap: 8px;
  }
`;

const MessageContainer = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  background: var(--chat-bg);
  backdrop-filter: blur(8px);
  border: 2px solid var(--primary-hex);
  border-radius: 14px;
  overflow-y: auto;
  padding: 14px 14px 10px;
  box-shadow: 0 0 22px rgba(var(--primary-rgb), 0.25);
  min-height: 260px;
  transition: all 0.5s ease;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
  overscroll-behavior-y: contain;
  touch-action: pan-y;
  min-width: 0;
  min-height: 0;
  justify-content: ${({ $isEmpty }) => ($isEmpty ? 'center' : 'flex-start')};
  align-items: ${({ $isEmpty }) => ($isEmpty ? 'center' : 'stretch')};
  gap: ${({ $isEmpty }) => ($isEmpty ? '0' : '0')};

  @media (max-width: 768px) {
    overscroll-behavior: auto;
    overscroll-behavior-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  &::-webkit-scrollbar { width: 8px; }
  &::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
  &::-webkit-scrollbar-thumb { background: var(--primary-hex); border-radius: 4px; }

  @media (max-width: 480px) {
    padding: 10px 10px 8px;
    border-radius: 10px;
    min-height: 200px;
    overscroll-behavior: auto;
    overscroll-behavior-y: auto;
    -webkit-overflow-scrolling: touch;

    &::-webkit-scrollbar { width: 4px; }
  }
`;

const MessageBubble = styled.div`
  max-width: 80%;
  margin-bottom: 12px;
  padding: 14px 18px;
  border-radius: 12px;
  line-height: 1.7;
  letter-spacing: 0.3px;
  word-spacing: 0.1em;
  align-self: ${props => props.$role === 'user' ? 'flex-end' : 'flex-start'};
  background: ${props => props.$role === 'user' ? 'rgba(var(--primary-rgb), 0.15)' : 'rgba(var(--secondary-rgb), 0.15)'};
  border: 1px solid ${props => props.$role === 'user' ? 'rgba(var(--primary-rgb), 0.4)' : 'rgba(var(--secondary-rgb), 0.4)'};
  color: #fff;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  hyphens: auto;
  transition: all 0.5s ease;

  @media (max-width: 480px) {
    max-width: 92%;
    padding: 11px 14px;
    font-size: 14px;
    margin-bottom: 8px;
    border-radius: 10px;
    line-height: 1.6;
    letter-spacing: 0.2px;
    word-spacing: 0.05em;
  }
`;

const BubbleImage = styled.img`
  max-width: 100%;
  border-radius: 8px;
  margin-top: 8px;
  border: 1px solid rgba(255,255,255,0.2);
`;

const DocumentAttachment = styled.div`
  display: inline-flex;
  align-items: center;
  background: rgba(255,255,255,0.1);
  padding: 8px 12px;
  border-radius: 8px;
  margin-top: 8px;
  font-size: 14px;
  border: 1px solid rgba(255,255,255,0.3);
  gap: 8px;

  @media (max-width: 480px) {
    font-size: 12px;
    padding: 6px 10px;
  }
`;

const WaveformBars = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 10px;
  height: 20px;

  div {
    width: 3px;
    background: var(--primary-hex);
    border-radius: 2px;
    animation: ${Waveform} 1s ease-in-out infinite;
  }
  div:nth-child(2) { animation-delay: 0.1s; }
  div:nth-child(3) { animation-delay: 0.2s; }
  div:nth-child(4) { animation-delay: 0.3s; }
  div:nth-child(5) { animation-delay: 0.4s; }
`;

const TypingIndicator = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;

  span {
    width: 6px;
    height: 6px;
    background: var(--secondary-hex);
    border-radius: 50%;
    animation: ${typing} 1.4s infinite ease-in-out both;
  }
  span:nth-child(1) { animation-delay: -0.32s; }
  span:nth-child(2) { animation-delay: -0.16s; }
`;

const StopButton = styled.button`
  align-self: center;
  background: rgba(255, 0, 0, 0.15);
  border: 1px solid rgba(255, 0, 0, 0.4);
  color: #ff4d4d;
  padding: 8px 16px;
  border-radius: 20px;
  cursor: pointer;
  margin-top: 10px;
  font-size: 14px;
  display: inline-block;
  transition: all 0.2s;

  &:hover { background: rgba(255, 0, 0, 0.3); color: #fff; }

  @media (max-width: 480px) {
    font-size: 12px;
    padding: 6px 12px;
    margin-top: 6px;
  }
`;

const InputContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;

  @media (max-width: 480px) {
    gap: 6px;
  }
`;

const PreviewRow = styled.div`
  display: flex;
  gap: 10px;
  flex-wrap: wrap;

  @media (max-width: 480px) {
    gap: 8px;
  }
`;

const ImagePreviewContainer = styled.div`
  position: relative;
  display: inline-block;
  width: max-content;
`;

const ImagePreview = styled.img`
  max-height: 60px;
  border-radius: 8px;
  border: 2px solid var(--primary-hex);

  @media (max-width: 480px) {
    max-height: 48px;
  }
`;

const RemoveAttachmentButton = styled.button`
  position: absolute;
  top: -8px;
  right: -8px;
  background: red;
  color: white;
  border: none;
  border-radius: 50%;
  width: 22px;
  height: 22px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.5);

  @media (max-width: 480px) {
    width: 18px;
    height: 18px;
    font-size: 10px;
    top: -6px;
    right: -6px;
  }
`;

const InputForm = styled.form`
  display: flex;
  gap: 10px;
  width: 100%;
  align-items: center;
  min-width: 0;

  @media (max-width: 480px) {
    gap: 6px;
    flex-wrap: wrap;
  }
`;

const UploadLabel = styled.label`
  background: rgba(var(--primary-rgb), 0.15);
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  color: var(--primary-hex);
  padding: 10px 14px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  transition: all 0.3s;
  font-size: 16px;
  flex-shrink: 0;

  &:hover {
    background: rgba(var(--primary-rgb), 0.3);
    box-shadow: 0 0 10px rgba(var(--primary-rgb), 0.4);
  }

  @media (max-width: 480px) {
    padding: 8px 10px;
    font-size: 14px;
  }
`;

const HiddenInput = styled.input`
  display: none;
`;

const TextInput = styled.input`
  flex: 1;
  min-width: 0;
  background: var(--chat-bg);
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  color: #fff;
  padding: 12px 18px;
  border-radius: 24px;
  font-size: 15px;
  outline: none;
  transition: all 0.5s ease;

  &:focus {
    border-color: var(--primary-hex);
    box-shadow: 0 0 10px rgba(var(--primary-rgb), 0.2);
  }
  &::placeholder { color: rgba(255, 255, 255, 0.4); }

  @media (max-width: 480px) {
    padding: 10px 14px;
    font-size: 14px;
    border-radius: 20px;
    width: 100%;
  }
`;

const SendButton = styled.button`
  background: var(--primary-hex);
  color: #020314;
  border: none;
  padding: 0 24px;
  border-radius: 24px;
  height: 45px;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.5s ease;
  flex-shrink: 0;
  white-space: nowrap;
  min-width: 88px;

  &:hover {
    box-shadow: 0 0 15px rgba(var(--primary-rgb), 0.4);
    opacity: 0.9;
  }
  &:disabled {
    background: rgba(var(--primary-rgb), 0.2);
    color: rgba(255, 255, 255, 0.5);
    cursor: not-allowed;
  }

  @media (max-width: 480px) {
    padding: 0 16px;
    height: 40px;
    font-size: 14px;
    border-radius: 20px;
    width: 100%;
  }
`;

const FloatingPlayerContainer = styled.div`
  position: absolute;
  top: 15px;
  right: 15px;
  width: 320px;
  height: 180px;
  background: #000;
  border: 2px solid var(--primary-hex);
  border-radius: 12px;
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.8);
  z-index: 1000;
  overflow: hidden;
  animation: slideIn 0.3s ease-out forwards;

  @media (max-width: 480px) {
    position: relative;
    width: calc(100% - 30px);
    height: 180px;
    top: 0;
    right: 0;
    left: 0;
    margin: 0 auto;
  }
`;

const ClosePlayerButton = styled.button`
  position: absolute;
  top: -10px;
  right: -10px;
  width: 25px;
  height: 25px;
  background: red;
  color: white;
  border: none;
  border-radius: 50%;
  font-weight: bold;
  cursor: pointer;
  z-index: 1001;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  box-shadow: 0 2px 5px rgba(0,0,0,0.5);
  &:hover { background: darkred; }
`;

const HistoryButton = styled.button`
  align-self: center;
  border: 1px solid rgba(var(--primary-rgb), 0.28);
  background: rgba(0, 0, 0, 0.18);
  color: #c8fbff;
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s ease, transform 0.2s ease;

  &:hover {
    background: rgba(var(--primary-rgb), 0.12);
    transform: translateY(-1px);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    transform: none;
  }
`;

const PresenceStrip = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 999px;
  border: 1px solid rgba(var(--primary-rgb), 0.28);
  background: rgba(0, 0, 0, 0.18);
  color: #d7faff;
  font-size: 12px;
  letter-spacing: 0.04em;
  width: fit-content;
  max-width: 100%;
  margin: 0 0 10px 0;
  box-shadow: 0 0 14px rgba(var(--primary-rgb), 0.12);
`;

const PresenceDot = styled.span`
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: ${({ $status }) => ($status === 'Completed' ? '#4dffb0' : $status === 'Failed' ? '#ff7070' : $status === 'Cancelled' ? '#ffb347' : '#00ffff')};
  box-shadow: 0 0 12px rgba(var(--primary-rgb), 0.35);
`;

const MessageContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
`;

const MessageText = styled.div`
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  hyphens: auto;
  min-width: 0;
  max-height: ${props => (props.$collapsed ? '9.5rem' : 'none')};
  overflow: ${props => (props.$collapsed ? 'hidden' : 'visible')};
`;

const MessageToggleButton = styled.button`
  align-self: flex-start;
  border: none;
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--primary-hex);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s ease, transform 0.2s ease;

  &:hover {
    background: rgba(var(--primary-rgb), 0.2);
    transform: translateY(-1px);
  }
`;

const EmptyStatePanel = styled.div`
  width: min(100%, ${({ $layoutMode, $sidebarCollapsed }) => {
    if ($layoutMode === 'desktop-wide' && !$sidebarCollapsed) return '640px';
    if ($layoutMode === 'desktop-compact') return '720px';
    if ($layoutMode === 'tablet') return '100%';
    return '100%';
  }});
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: ${({ $layoutMode }) => ($layoutMode === 'mobile' ? '14px 8px' : '18px 20px')};
  gap: 14px;
  color: #dbe4ff;
`;

const EmptyBadge = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid rgba(var(--primary-rgb), 0.24);
  background: rgba(var(--primary-rgb), 0.08);
  color: #7df7ff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

const EmptyTitle = styled.h2`
  margin: 0;
  font-size: clamp(24px, 3vw, 38px);
  line-height: 1.08;
  letter-spacing: -0.03em;
  color: #f7f9ff;
`;

const EmptyCopy = styled.p`
  margin: 0;
  max-width: 56ch;
  font-size: 14px;
  line-height: 1.6;
  color: rgba(219, 228, 255, 0.72);
`;

const EmptyPills = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
`;

const EmptyPill = styled.span`
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(238, 242, 255, 0.82);
  font-size: 12px;
  white-space: nowrap;
`;

const LONG_MESSAGE_PREVIEW_CHARS = 640;
const INITIAL_VISIBLE_MESSAGES = 60;
const LOAD_MORE_MESSAGES = 40;

const ChatMessage = memo(({ msg, isSpeaking, isLast }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const text = String(msg.text || '');
  const shouldCollapse = text.length > LONG_MESSAGE_PREVIEW_CHARS;
  const displayedText = shouldCollapse && !isExpanded ? `${text.slice(0, LONG_MESSAGE_PREVIEW_CHARS).trimEnd()}…` : text;
  const isSchedulingConfirmation = text.includes('successfully scheduled') || text.includes('Meeting');

  return (
    <MessageBubble $role={msg.sender === 'ai' ? 'assistant' : 'user'}>
      <MessageContent>
        {isSchedulingConfirmation && msg.sender === 'ai' && (
          <div style={{
            marginBottom: '8px',
            padding: '8px 12px',
            background: 'rgba(0, 255, 120, 0.1)',
            border: '1px solid rgba(0, 255, 120, 0.4)',
            borderRadius: '8px',
            color: '#4dffb0',
            fontSize: '13px',
            fontWeight: '600'
          }}>
            ✓ {text}
          </div>
        )}
        {msg.sender === 'ai' && !isSchedulingConfirmation && <span style={{ fontWeight: 'bold' }}>ARC-AI: </span>}
        {!isSchedulingConfirmation && <MessageText $collapsed={shouldCollapse && !isExpanded}>{displayedText}</MessageText>}

        {shouldCollapse && (
          <MessageToggleButton
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? 'Show less' : 'Show more'}
          </MessageToggleButton>
        )}

        {msg.image && <BubbleImage src={msg.image} alt="User upload" />}

        {msg.documentName && <DocumentAttachment>📄 {msg.documentName}</DocumentAttachment>}

        {msg.sender === 'ai' && (msg.isStreaming || (isSpeaking && isLast)) && (
          <WaveformBars><div></div><div></div><div></div><div></div><div></div></WaveformBars>
        )}
      </MessageContent>
    </MessageBubble>
  );
});

ChatMessage.displayName = 'ChatMessage';

const ChatInterface = ({ workspaceMode = 'desktop-wide', sidebarCollapsed = false }) => {
  const { messages, replaceMessages, clearMessages, isProcessing, isStreaming, isSpeaking, mediaData, setMediaData, getLiveVisionFrame } = useChat();
  const { interruptStream, sendCommand, socket } = useSocket();
  const { activeExecution, presence, cancelActiveExecution } = useExecution();
  const { activeConversationId, activeConversationRevision, switchConversation, fetchConversations, fetchConversationMessages, updateConversationTitle, ensureConversationReady } = useConversation();
  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState(null); 
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const chatEndRef = useRef(null);
  const messageContainerRef = useRef(null);
  const historyScrollRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);

  const isBusy = isProcessing || isStreaming || isSpeaking;

  const handleCancelWork = () => {
    cancelActiveExecution?.();
    interruptStream();
  };

  // Listen for new conversation creation from socket
  useEffect(() => {
    if (!socket) return;
    const handleConversationCreated = (data) => {
      if (data?.conversationId) {
        switchConversation(data.conversationId);
        fetchConversations().catch(() => {});
      }
    };
    socket.on('ai:conversation:created', handleConversationCreated);
    return () => socket.off('ai:conversation:created', handleConversationCreated);
  }, [socket, switchConversation, fetchConversations]);

  useEffect(() => {
    if (!socket) return;

    const handleConversationTitle = (data) => {
      if (!data?.conversationId || !data?.title) return;
      updateConversationTitle(data.conversationId, data.title);
    };

    socket.on('ai:conversation:title', handleConversationTitle);
    return () => socket.off('ai:conversation:title', handleConversationTitle);
  }, [socket, updateConversationTitle]);

  useEffect(() => {
    let isCancelled = false;

    const loadConversationMessages = async () => {
      if (!activeConversationId) {
        console.log('[ChatInterface] loadConversationMessages:clear');
        clearMessages();
        return;
      }

      console.log('[ChatInterface] loadConversationMessages:start', {
        activeConversationId,
        activeConversationRevision
      });

      try {
        const dbMessages = await fetchConversationMessages(activeConversationId, { limit: 500, skip: 0 });
        if (isCancelled) return;

        console.log('[ChatInterface] loadConversationMessages:fetched', {
          activeConversationId,
          count: Array.isArray(dbMessages) ? dbMessages.length : 0,
          messages: Array.isArray(dbMessages)
            ? dbMessages.map((message) => ({
                role: message?.role,
                interrupted: Boolean(message?.metadata?.interrupted),
                streaming: Boolean(message?.metadata?.streaming),
                partial: Boolean(message?.metadata?.partial),
                state: message?.metadata?.state || null,
                contentLength: String(message?.content || '').length
              }))
            : []
        });

        const mappedMessages = dbMessages.map((message) => ({
          sender: message.role === 'user' ? 'user' : 'ai',
          text: sanitizeForDisplay(String(message.content || '')),
          isStreaming: false
        }));

        console.log('[ChatInterface] loadConversationMessages:replace', {
          activeConversationId,
          mappedCount: mappedMessages.length,
          hasInterruptedDraft: mappedMessages.some((message, index) => {
            const original = dbMessages[index];
            return message.sender === 'ai' && Boolean(original?.metadata?.interrupted);
          })
        });

        replaceMessages(mappedMessages);
      } catch (error) {
        console.error('Failed loading conversation messages:', error);
      }
    };

    loadConversationMessages();

    return () => {
      isCancelled = true;
    };
  }, [activeConversationId, activeConversationRevision, fetchConversationMessages, replaceMessages, clearMessages]);

  useEffect(() => {
    setVisibleMessageCount((currentCount) => {
      const nextCount = Math.min(Math.max(currentCount, INITIAL_VISIBLE_MESSAGES), messages.length);
      return nextCount;
    });
  }, [messages.length]);

  const visibleMessages = messages.slice(Math.max(0, messages.length - visibleMessageCount));

  const handleLoadMoreMessages = () => {
    const container = messageContainerRef.current;
    if (!container) {
      setVisibleMessageCount((currentCount) => Math.min(messages.length, currentCount + LOAD_MORE_MESSAGES));
      return;
    }

    historyScrollRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight
    };

    setVisibleMessageCount((currentCount) => Math.min(messages.length, currentCount + LOAD_MORE_MESSAGES));
  };

  const isNearBottom = (container) => {
    if (!container) return true;
    const threshold = 96;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= threshold;
  };

  const handleMessageScroll = () => {
    const container = messageContainerRef.current;
    if (!container) return;
    shouldAutoScrollRef.current = isNearBottom(container);
  };

  useLayoutEffect(() => {
    const container = messageContainerRef.current;
    const snapshot = historyScrollRef.current;

    if (!container || !snapshot) return;

    const heightDelta = container.scrollHeight - snapshot.scrollHeight;
    container.scrollTop = snapshot.scrollTop + heightDelta;
    historyScrollRef.current = null;
  }, [visibleMessageCount]);

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 800;
          const MAX_HEIGHT = 800;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
          } else {
            if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
          }
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.7);
          const base64String = compressedDataUrl.split(',')[1];
          setSelectedImage({ file: URL.createObjectURL(file), base64: base64String });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }
    e.target.value = null; 
  };

  const handleDocumentUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result.split(',')[1];
        setSelectedDocument({ name: file.name, type: file.type, base64: base64String });
      };
      reader.readAsDataURL(file);
    }
    e.target.value = null;
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
      if (event.code === 'Space' && isBusy) {
        event.preventDefault();
        event.stopPropagation();
        handleCancelWork();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isBusy, interruptStream]);

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const container = messageContainerRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: isBusy ? 'auto' : 'smooth'
    });
  }, [messages, isProcessing, isSpeaking, isBusy]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if ((!inputText.trim() && !selectedImage && !selectedDocument) || isBusy) return;

    const uploadedImage = selectedImage?.base64 || null;
    const liveVisionFrame = uploadedImage ? null : getLiveVisionFrame();
    const conversationId = await ensureConversationReady?.('New Conversation');
    sendCommand(inputText.trim(), uploadedImage || liveVisionFrame, selectedDocument, conversationId || activeConversationId);
    
    setInputText('');
    setSelectedImage(null); 
    setSelectedDocument(null);
  };

  const isEmptyConversation = visibleMessages.length === 0;
  const emptyHints = [
    'Ask a question',
    'Start with voice',
    'Attach a file or image'
  ];

  return (
    <ChatWrapper>
      {activeExecution ? (
        <PresenceStrip aria-live="polite">
          <PresenceDot $status={presence} />
          <strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em' }}>{presence}</strong>
          <span style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeExecution.title || 'Autonomous execution'}</span>
        </PresenceStrip>
      ) : null}

      {mediaData && (
        <FloatingPlayerContainer>
          <ClosePlayerButton onClick={() => setMediaData(null)}>X</ClosePlayerButton>
          <iframe 
            width="100%" height="100%" 
            src={`https://www.youtube.com/embed/${mediaData.videoId}?autoplay=1`} 
            title="ARC-AI Media Player" frameBorder="0" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
            allowFullScreen
          ></iframe>
        </FloatingPlayerContainer>
      )}

      <MessageContainer ref={messageContainerRef} onScroll={handleMessageScroll} $isEmpty={isEmptyConversation}>
        {messages.length > visibleMessages.length ? (
          <HistoryButton type="button" onClick={handleLoadMoreMessages} disabled={visibleMessageCount >= messages.length}>
            Load earlier messages ({messages.length - visibleMessages.length} hidden)
          </HistoryButton>
        ) : null}

        {isEmptyConversation ? (
          <EmptyStatePanel $layoutMode={workspaceMode} $sidebarCollapsed={sidebarCollapsed}>
            <EmptyBadge>Ready to assist</EmptyBadge>
            <EmptyTitle>What would you like ARC-AI to do?</EmptyTitle>
            <EmptyCopy>
              Start a conversation, attach a document, or use voice. The workspace now adapts its width based on the current shell mode instead of assuming a fixed desktop sidebar.
            </EmptyCopy>
            <EmptyPills>
              {emptyHints.map((hint) => (
                <EmptyPill key={hint}>{hint}</EmptyPill>
              ))}
            </EmptyPills>
          </EmptyStatePanel>
        ) : (
          visibleMessages.map((msg, index) => (
            <ChatMessage
              key={`${messages.length - visibleMessages.length + index}`}
              msg={msg}
              isSpeaking={isSpeaking}
              isLast={index === visibleMessages.length - 1}
            />
          ))
        )}

        {isProcessing && (visibleMessages.length === 0 || visibleMessages[visibleMessages.length - 1].sender !== 'ai') && (
          <MessageBubble $role="assistant">
            <TypingIndicator><span></span><span></span><span></span></TypingIndicator>
          </MessageBubble>
        )}

        {isBusy && (
          <StopButton onClick={handleCancelWork}>
            ⏹ {isSpeaking ? "Stop Speaking" : "Stop Generating"} (Press Space)
          </StopButton>
        )}
        <div ref={chatEndRef} />
      </MessageContainer>

      <InputContainer>
        <PreviewRow>
          {selectedImage && (
            <ImagePreviewContainer>
              <RemoveAttachmentButton onClick={() => setSelectedImage(null)}>X</RemoveAttachmentButton>
              <ImagePreview src={selectedImage.file} alt="Preview" />
            </ImagePreviewContainer>
          )}
          
          {selectedDocument && (
            <ImagePreviewContainer>
              <RemoveAttachmentButton onClick={() => setSelectedDocument(null)}>X</RemoveAttachmentButton>
              <DocumentAttachment style={{ margin: 0 }}>📄 {selectedDocument.name}</DocumentAttachment>
            </ImagePreviewContainer>
          )}
        </PreviewRow>

        <InputForm onSubmit={handleSubmit}>
          {/* Image Upload */}
          <UploadLabel title="Upload Image">
            📷
            <HiddenInput type="file" accept="image/png, image/jpeg, image/webp" onChange={handleImageUpload} disabled={isBusy} />
          </UploadLabel>

          {/* Document Upload */}
          <UploadLabel title="Upload Document">
            📄
            <HiddenInput type="file" accept=".txt,.csv,.md,.json,.pdf" onChange={handleDocumentUpload} disabled={isBusy} />
          </UploadLabel>

          <TextInput 
            type="text" placeholder="Message, describe an image, or ask about a file..." 
            value={inputText} onChange={(e) => setInputText(e.target.value)}
            disabled={isBusy} autoComplete="off"
          />
          <SendButton type="submit" disabled={(!inputText.trim() && !selectedImage && !selectedDocument) || isBusy}>Send</SendButton>
        </InputForm>
      </InputContainer>
    </ChatWrapper>
  );
};

export default ChatInterface;
