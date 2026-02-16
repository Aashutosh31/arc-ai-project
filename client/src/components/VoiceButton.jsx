// client/src/components/VoiceButton.jsx
import React from 'react';
import styled, { keyframes, css } from 'styled-components';
import { useVoiceInput } from '../hooks/useVoiceInput';

const pulse = keyframes`
  0% { box-shadow: 0 0 0 0 rgba(0, 255, 255, 0.7); }
  70% { box-shadow: 0 0 0 25px rgba(0, 255, 255, 0); }
  100% { box-shadow: 0 0 0 0 rgba(0, 255, 255, 0); }
`;

const MicButton = styled.button`
  background: ${props =>
    props.$listening ? 'linear-gradient(145deg, #00bfff, #00ffff)' : '#282c34'};
  border: 4px solid #00ffff;
  border-radius: 50%;
  width: 80px;
  height: 80px;
  color: white;
  font-size: 26px;
  cursor: pointer;
  transition: all 0.25s ease-in-out;
  position: relative;
  z-index: 1;

  ${props =>
    props.$listening &&
    css`
      animation: ${pulse} 1.5s infinite;
      border-color: #ff00ff;
      box-shadow: 0 0 30px rgba(255, 0, 255, 0.8);
    `}

  &:hover {
    transform: scale(1.06);
  }

  @media (max-width: 768px) {
    width: 64px;
    height: 64px;
    font-size: 22px;
    border-width: 3px;
  }

  @media (max-width: 480px) {
    width: 56px;
    height: 56px;
    font-size: 20px;
  }
`;

const VoiceButton = () => {
  const { isListening, startListening, stopListening } = useVoiceInput();

  const handleClick = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  return (
    <MicButton onClick={handleClick} $listening={isListening}>
      {isListening ? '🎧' : '🎙️'}
    </MicButton>
  );
};

export default VoiceButton;
