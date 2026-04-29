// client/src/components/SocketProvider.jsx
import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SocketContext } from '../contexts/SocketContext'; // Import the Context

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [authInfo, setAuthInfo] = useState({
        ready: false,
        token: null,
        userId: null,
        authType: 'guest',
        authProvider: 'guest',
        username: 'Guest',
        creditsRemaining: 0,
        googleLinked: false
    });

    useEffect(() => {
        let isCancelled = false;
        let activeSocket = null;

        const bootstrapSession = async () => {
            let token = localStorage.getItem('token');
            let userId = localStorage.getItem('userId');
            let authType = localStorage.getItem('authType') || 'user';
            let authProvider = localStorage.getItem('authProvider') || 'local';
            let username = localStorage.getItem('username') || '';
            let creditsRemaining = Number(localStorage.getItem('creditsRemaining') || 0);
            let googleLinked = localStorage.getItem('googleLinked') === 'true';

            if (!token || !userId) {
                const guestResponse = await fetch(`${API_URL}/api/auth/guest`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (!guestResponse.ok) {
                    throw new Error('Failed to create guest session');
                }

                const guestData = await guestResponse.json();
                token = guestData.token;
                userId = guestData._id;
                authType = guestData.authType || 'guest';
                authProvider = guestData.authProvider || 'guest';
                username = guestData.username || 'Guest';
                creditsRemaining = Number(guestData.creditsRemaining || 0);
                googleLinked = Boolean(guestData.googleLinked);

                localStorage.setItem('token', token);
                localStorage.setItem('userId', userId);
                localStorage.setItem('authType', authType);
                localStorage.setItem('authProvider', authProvider);
                localStorage.setItem('username', username);
                localStorage.setItem('creditsRemaining', String(creditsRemaining));
                localStorage.setItem('googleLinked', String(googleLinked));
            }

            if (isCancelled) return;

            setAuthInfo({
                ready: true,
                token,
                userId,
                authType,
                authProvider,
                username: username || (authType === 'guest' ? 'Guest' : 'User'),
                creditsRemaining,
                googleLinked
            });
        };

        bootstrapSession().catch((error) => {
            console.error('Authentication bootstrap failed:', error);
        });

        return () => {
            isCancelled = true;
            if (activeSocket) activeSocket.close();
        };
    }, []); 

    useEffect(() => {
        if (!authInfo.ready || !authInfo.token || !authInfo.userId) return;

        const newSocket = io(API_URL, {
            auth: { token: authInfo.token, userId: authInfo.userId },
            transports: ['websocket'],
        });

        newSocket.on('connect', () => {
            setIsConnected(true);
            console.log('✅ Socket connected for user:', authInfo.userId || 'GUEST');
        });

        newSocket.on('disconnect', () => {
            setIsConnected(false);
            console.log('❌ Socket disconnected.');
        });

        setSocket(newSocket);

        return () => newSocket.close();
    }, [authInfo.ready, authInfo.token, authInfo.userId]);

    return (
        <SocketContext.Provider value={{ socket, isConnected, authInfo, setAuthInfo }}>
            {children}
        </SocketContext.Provider>
    );
};

// NOTE: This file now ONLY exports the component (SocketProvider)