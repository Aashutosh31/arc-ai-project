import React, { useEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useChat } from '../contexts/ChatContext';
import { useSocket } from '../hooks/useSocket';

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

  &::-webkit-scrollbar { width: 8px; }
  &::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
  &::-webkit-scrollbar-thumb { background: var(--primary-hex); border-radius: 4px; }
`;

const MessageBubble = styled.div`
  max-width: 80%;
  margin-bottom: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  line-height: 1.4;
  align-self: ${props => props.$role === 'user' ? 'flex-end' : 'flex-start'};
  background: ${props => props.$role === 'user' ? 'rgba(var(--primary-rgb), 0.15)' : 'rgba(var(--secondary-rgb), 0.15)'};
  border: 1px solid ${props => props.$role === 'user' ? 'rgba(var(--primary-rgb), 0.4)' : 'rgba(var(--secondary-rgb), 0.4)'};
  color: #fff;
  white-space: pre-wrap;
  word-wrap: break-word;
  transition: all 0.5s ease;
`;

const BubbleImage = styled.img`
  max-width: 100%;
  border-radius: 8px;
  margin-top: 8px;
  border: 1px solid rgba(255,255,255,0.2);
`;

// 🚀 NEW: Styled component for document attachments in the chat log
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
`;

const InputContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const PreviewRow = styled.div`
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
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
`;

const InputForm = styled.form`
  display: flex;
  gap: 10px;
  width: 100%;
  align-items: center;
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
  transition: all 0.3s;
  font-size: 16px;

  &:hover {
    background: rgba(var(--primary-rgb), 0.3);
    box-shadow: 0 0 10px rgba(var(--primary-rgb), 0.4);
  }
`;

const HiddenInput = styled.input`
  display: none;
`;

const TextInput = styled.input`
  flex: 1;
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

  &:hover {
    box-shadow: 0 0 15px rgba(var(--primary-rgb), 0.4);
    opacity: 0.9;
  }
  &:disabled {
    background: rgba(var(--primary-rgb), 0.2);
    color: rgba(255, 255, 255, 0.5);
    cursor: not-allowed;
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

const ChatInterface = () => {
  const { messages, isProcessing, isSpeaking, mediaData, setMediaData } = useChat();
  const { interruptStream, sendCommand } = useSocket(); 
  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState(null); 
  const [selectedDocument, setSelectedDocument] = useState(null); // 🚀 NEW: Document State
  const chatEndRef = useRef(null);

  const isBusy = isProcessing || isSpeaking;

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

  // 🚀 NEW: Document Upload Handler
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
        interruptStream();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBusy, interruptStream]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing, isSpeaking]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((!inputText.trim() && !selectedImage && !selectedDocument) || isBusy) return;
    
    // 🚀 Send text, image, AND document payload
    sendCommand(inputText.trim(), selectedImage?.base64, selectedDocument);
    
    setInputText('');
    setSelectedImage(null); 
    setSelectedDocument(null);
  };

  return (
    <ChatWrapper>
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

      <MessageContainer>
        {messages.map((msg, index) => (
          <MessageBubble key={index} $role={msg.sender === 'ai' ? 'assistant' : 'user'}>
            {msg.sender === 'ai' && <span style={{ fontWeight: 'bold' }}>ARC-AI: </span>}
            {msg.text}
            
            {msg.image && <><br/><BubbleImage src={msg.image} alt="User upload" /></>}
            
            {/* 🚀 Render Document name in chat log */}
            {msg.documentName && (
              <><br/><DocumentAttachment>📄 {msg.documentName}</DocumentAttachment></>
            )}

            {msg.sender === 'ai' && (msg.isStreaming || (isSpeaking && index === messages.length - 1)) && (
              <WaveformBars><div></div><div></div><div></div><div></div><div></div></WaveformBars>
            )}
          </MessageBubble>
        ))}

        {isProcessing && (messages.length === 0 || messages[messages.length - 1].sender !== 'ai') && (
          <MessageBubble $role="assistant">
            <TypingIndicator><span></span><span></span><span></span></TypingIndicator>
          </MessageBubble>
        )}

        {isBusy && (
          <StopButton onClick={interruptStream}>
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
          
          {/* 🚀 Document Preview Bubble */}
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

          {/* 🚀 NEW: Document Upload */}
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