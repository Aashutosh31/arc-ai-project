// client/src/pages/DashboardPage.jsx
import React from 'react';
import styled from 'styled-components';
import { useSocket } from '../hooks/useSocket';
import VoiceButton from '../components/VoiceButton';

const StatusText = styled.h1`
    color: ${props => props.$isConnected ? '#00FF00' : '#FF0000'};
    text-shadow: 0 0 10px ${props => props.$isConnected ? '#00FF00' : '#FF0000'};
`;

const DashboardPage = () => {
    const { isConnected } = useSocket();

    return (
        <div style={{ padding: '50px', textAlign: 'center' }}>
            <StatusText $isConnected={isConnected}>
                ARC-AI Status: {isConnected ? 'ONLINE' : 'OFFLINE'}
            </StatusText>
            <p style={{ color: '#00FFFF', marginTop: '10px' }}>
                System Core Activated. Click the mic button to speak your command.
            </p>
            <VoiceButton />
            {/* TODO: In Phase 5, this will be replaced by the full ChatInterface and Widgets
            */}
        </div>
    );
};

export default DashboardPage;