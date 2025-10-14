// client/src/pages/DashboardPage.jsx
import React from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import VoiceButton from '../components/VoiceButton';
import ChatInterface from '../components/ChatInterface.jsx'; // <--- CHAT WINDOW IMPORTED HERE ---

const StatusText = styled.h1`
    color: ${props => props.$isConnected ? '#00FF00' : '#FF0000'};
    text-shadow: 0 0 10px ${props => props.$isConnected ? '#00FF00' : '#FF0000'};
`;

// ... DashboardPage component definition ...
const DashboardPage = () => {
    const { isConnected } = useSocket();

    return (
        <div style={{ padding: '20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '90%' }}>
            <StatusText $isConnected={isConnected}>
                ARC-AI Status: {isConnected ? 'ONLINE' : 'OFFLINE'}
            </StatusText>
            
            <ChatInterface /> {/* <--- CHAT WINDOW ADDED HERE --- */}
            
            <VoiceButton />
            {/* If TaskPanel was fully built, it would go here */}
        </div>
    );
};

export default DashboardPage;