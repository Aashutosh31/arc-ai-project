// client/src/contexts/SocketContext.jsx
// NOTE: The live socket is owned by components/SocketProvider.jsx (ticket
// handshake). This file only exports the Context object; the provider below
// is legacy/dead code kept for import compatibility.
import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_URL } from '../config';

export const SocketContext = React.createContext();

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        const userId = localStorage.getItem('userId');
        const newSocket = io(SOCKET_URL, {
            auth: { userId },
            transports: ['websocket', 'polling'],
            withCredentials: true
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