// client/src/components/VoiceButton.jsx
import React from 'react';
import styled, { keyframes, css } from 'styled-components';
import { useVoiceInput } from '../hooks/useVoiceInput';

// Futuristic Pulsing Animation
const pulse = keyframes`
  0% { box-shadow: 0 0 0 0 rgba(0, 255, 255, 0.7); }
  70% { box-shadow: 0 0 0 25px rgba(0, 255, 255, 0); }
  100% { box-shadow: 0 0 0 0 rgba(0, 255, 255, 0); }
`;

const MicButton = styled.button`
    background: ${props => props.$listening ? 'linear-gradient(145deg, #00BFFF, #00FFFF)' : '#282c34'};
    border: 4px solid #00FFFF;
    border-radius: 50%;
    width: 80px;
    height: 80px;
    color: white;
    font-size: 24px;
    cursor: pointer;
    transition: all 0.3s ease-in-out;
    position: fixed;
    bottom: 50px;
    right: 50px;
    z-index: 1000;

    ${props => props.$listening && css`
        animation: ${pulse} 1.5s infinite;
        border-color: #FF00FF; /* Change border color when active */
        box-shadow: 0 0 30px rgba(255, 0, 255, 0.8);
    `}

    &:hover {
        transform: scale(1.1);
    }
`;

const VoiceButton = () => {
    const { isListening, transcript, startListening, stopListening } = useVoiceInput();

    const handleClick = () => {
        if (isListening) {
            stopListening();
        } else {
            startListening();
        }
    };

    // Note: For now, we display the transcript in the console/alert. 
    // In Phase 4, this transcript will populate the ChatInterface input field.

    return (
        <MicButton onClick={handleClick} $listening={isListening}>
            {isListening ? '🎧' : '🎙️'}
        </MicButton>
    );
};

export default VoiceButton;