// client/src/contexts/SocketContext.jsx
import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

export const SocketContext = React.createContext();

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        // Get token from local storage (set during login in Phase 4)
        const token = localStorage.getItem('token');
        const userId = localStorage.getItem('userId');

        if (!token || !userId) {
            console.warn('Authentication token missing. Socket connection limited.');
            // You might choose to redirect to login here
        }

        // Connect to the backend server
        const newSocket = io(API_URL, {
            // Pass auth data for socketAuth middleware (Phase 4)
            auth: { token, userId },
            transports: ['websocket'], // Prefer WebSocket for real-time performance
        });

        newSocket.on('connect', () => {
            setIsConnected(true);
            console.log('✅ Socket connected for user:', userId);
        });

        newSocket.on('disconnect', () => {
            setIsConnected(false);
            console.log('❌ Socket disconnected.');
        });

        setSocket(newSocket);

        return () => newSocket.close();
    }, []); // Empty dependency array means this runs once on mount

    return (
        <SocketContext.Provider value={{ socket, isConnected }}>
            {children}
        </SocketContext.Provider>
    );
};