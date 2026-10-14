// client/src/components/SocketProvider.jsx
import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SocketContext } from '../contexts/SocketContext'; // Import the Context
import { API_URL, SOCKET_URL } from '../config';

// Helper for authenticated fetch requests
const authFetch = async (url, options = {}) => {
  return fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
};

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
        // The /auth/callback route (Google OAuth popup landing) manages its
        // own session exchange and must not race a guest-session bootstrap —
        // a stray POST /api/auth/guest here would overwrite the freshly
        // exchanged httpOnly cookie and localStorage identity with a guest
        // session, logging the user back out. Skip bootstrap there.
        if (window.location.pathname === '/auth/callback') {
            return undefined;
        }

        let isCancelled = false;
        let activeSocket = null;

        const bootstrapSession = async () => {
            let userId = localStorage.getItem('userId');
            let authType = localStorage.getItem('authType') || 'user';
            let authProvider = localStorage.getItem('authProvider') || 'local';
            let username = localStorage.getItem('username') || '';
            let creditsRemaining = Number(localStorage.getItem('creditsRemaining') || 0);
            let googleLinked = localStorage.getItem('googleLinked') === 'true';

            // Validate existing session by calling /api/auth/me (uses httpOnly cookie)
            if (userId && authType === 'guest') {
                try {
                    const meResponse = await authFetch(`${API_URL}/api/auth/me`);
                    if (!meResponse.ok) throw new Error(`stale guest session (HTTP ${meResponse.status})`);
                    const meData = await meResponse.json();
                    userId = meData.id || meData._id || userId;
                    username = meData.username || username;
                    creditsRemaining = Number(meData.creditsRemaining ?? creditsRemaining);
                    googleLinked = Boolean(meData.googleLinked);
                } catch (validationError) {
                    console.warn('Cached guest session invalid, creating a fresh one:', validationError?.message || validationError);
                    for (const key of ['userId', 'authType', 'authProvider', 'username', 'creditsRemaining', 'googleLinked']) {
                        localStorage.removeItem(key);
                    }
                    userId = null;
                }
            }

            if (!userId) {
                const guestResponse = await authFetch(`${API_URL}/api/auth/guest`, {
                    method: 'POST'
                });

                if (!guestResponse.ok) {
                    throw new Error('Failed to create guest session');
                }

                const guestData = await guestResponse.json();
                userId = guestData._id;
                authType = guestData.authType || 'guest';
                authProvider = guestData.authProvider || 'guest';
                username = guestData.username || 'Guest';
                creditsRemaining = Number(guestData.creditsRemaining || 0);
                googleLinked = Boolean(guestData.googleLinked);

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
                token: null, // Token is in httpOnly cookie, not accessible from JS
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
        if (!authInfo.ready || !authInfo.userId) return;

        let isCancelled = false;
        let newSocket = null;

        // The realtime socket connects DIRECTLY to the API host (the
        // production hosting proxy cannot forward WebSocket upgrades). A
        // cookie on that cross-site handshake would be third-party — blocked
        // by Safari/Firefox and phased out in Chrome — so we fetch a ONE-TIME
        // ticket over the same-origin /api proxy (first-party cookie) and
        // present it in the handshake. The httpOnly cookie remains a fallback
        // for first-party/dev setups.
        const connect = async () => {
            let handshakeAuth = { userId: authInfo.userId };
            try {
                const ticketRes = await authFetch(`${API_URL}/api/auth/socket-ticket`);
                if (ticketRes.ok) {
                    const { ticket } = await ticketRes.json();
                    handshakeAuth = { ...handshakeAuth, ticket };
                } else {
                    console.warn('[socket] ticket fetch failed (HTTP ' + ticketRes.status + '); relying on cookie handshake');
                }
            } catch (ticketError) {
                console.warn('[socket] ticket fetch error; relying on cookie handshake:', ticketError?.message || ticketError);
            }

            if (isCancelled) return;

            newSocket = io(SOCKET_URL, {
                auth: handshakeAuth,
                transports: ['websocket', 'polling'],
                withCredentials: true
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
        };

        connect().catch((error) => {
            console.error('[socket] connection setup failed:', error);
        });

        return () => {
            isCancelled = true;
            if (newSocket) newSocket.close();
        };
    }, [authInfo.ready, authInfo.userId]);

    return (
        <SocketContext.Provider value={{ socket, isConnected, authInfo, setAuthInfo }}>
            {children}
        </SocketContext.Provider>
    );
};

// NOTE: This file now ONLY exports the component (SocketProvider)