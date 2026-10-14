// client/src/pages/AuthCallbackPage.jsx
//
// Landing page for the Google OAuth popup. The API host's /callback cannot
// set a session cookie the frontend host will send (cross-site / third-party
// cookie), so it REDIRECTS the popup here with a one-time ?ticket=. This page
// exchanges the ticket through the same-origin /api proxy — the Set-Cookie is
// then attributed to the frontend host (first-party, allowed in every
// browser) — and notifies the opener window that opened the popup.
//
// Notification is belt-and-braces because Google's pages send
// Cross-Origin-Opener-Policy, which SEVERS window.opener while the popup is
// on Google's origin — postMessage from here often cannot reach the opener.
// persistAuthSession writes localStorage, which is shared same-origin across
// windows and fires a `storage` event in the opener: that is the primary
// signal. postMessage remains a best-effort fast path.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { API_URL } from '../config';

const persistAuthSession = (user) => {
    if (!user?._id) return;
    localStorage.setItem('userId', user._id);
    localStorage.setItem('authType', user.authType || 'user');
    localStorage.setItem('authProvider', user.authProvider || 'google');
    localStorage.setItem('googleLinked', String(Boolean(user.googleLinked)));
    localStorage.setItem('creditsRemaining', String(user.creditsRemaining ?? 0));
    localStorage.setItem('username', user.username || 'User');
};

const AuthCallbackPage = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [error, setError] = useState('');
    const exchanged = useRef(false);

    useEffect(() => {
        if (exchanged.current) return;
        exchanged.current = true;

        (async () => {
            const ticket = new URLSearchParams(location.search).get('ticket');
            if (!ticket) {
                setError('Missing sign-in ticket. Please close this window and try again.');
                return;
            }

            try {
                const res = await fetch(`${API_URL}/api/auth/session`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticket })
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.message || `Sign-in exchange failed (HTTP ${res.status})`);
                }
                const data = await res.json();
                // Writes localStorage -> fires `storage` in the opener window
                // (survives COOP severing of window.opener).
                persistAuthSession(data.user);

                // Best-effort fast path when opener survived.
                if (window.opener && !window.opener.closed) {
                    try {
                        window.opener.postMessage(
                            { type: 'arc-ai-google-auth-success', payload: { kind: 'auth', user: data.user } },
                            window.location.origin
                        );
                    } catch { /* COOP-severed opener: storage event already fired */ }
                }

                // Give the opener a beat to process the storage event, then
                // close. If the browser refuses (COOP can disown script-close),
                // fall through to navigating this window to the dashboard so
                // the user is never stuck on a blank "please wait" screen.
                setTimeout(() => {
                    try { window.close(); } catch { /* ignore */ }
                    setTimeout(() => {
                        if (!window.closed) navigate('/dashboard', { replace: true });
                    }, 250);
                }, 300);
            } catch (err) {
                console.error('[auth-callback] exchange failed:', err);
                setError(err?.message || 'Sign-in failed. Please try again.');
            }
        })();
    }, [location.search, navigate]);

    return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b1020', color: '#e6f0ff', fontFamily: 'Arial, sans-serif', padding: 32, textAlign: 'center' }}>
            <div>
                <h1 style={{ fontSize: 22 }}>{error ? 'Sign-in failed' : 'Completing sign-in…'}</h1>
                <p style={{ opacity: 0.8 }}>{error || 'Please wait, this should only take a moment.'}</p>
            </div>
        </div>
    );
};

export default AuthCallbackPage;
