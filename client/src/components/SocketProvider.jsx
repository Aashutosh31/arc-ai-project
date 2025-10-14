// client/src/components/SocketProvider.jsx
import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SocketContext } from '../contexts/SocketContext'; // Import the Context

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        const token = localStorage.getItem('token');
        const userId = localStorage.getItem('userId');

        // --- ⚠️ Initial Warning Analysis ---
        if (!token || !userId) {
            // This warning is expected until the login form (Step 4.6) is used.
            console.warn('Authentication token missing. Socket connection limited. (Normal before login)');
        }
        // ------------------------------------

        const newSocket = io(API_URL, {
            auth: { token, userId },
            transports: ['websocket'],
        });

        newSocket.on('connect', () => {
            setIsConnected(true);
            console.log('✅ Socket connected for user:', userId || 'GUEST');
        });

        newSocket.on('disconnect', () => {
            setIsConnected(false);
            console.log('❌ Socket disconnected.');
        });

        setSocket(newSocket);

        return () => newSocket.close();
    }, []); 

    return (
        <SocketContext.Provider value={{ socket, isConnected }}>
            {children}
        </SocketContext.Provider>
    );
};

// NOTE: This file now ONLY exports the component (SocketProvider)