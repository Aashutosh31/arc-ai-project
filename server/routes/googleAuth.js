const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { buildAuthUrl, isGoogleConnected, handleGoogleOAuthCallback, isAllowedNativeRedirect } = require('../services/googleCalendarService');
const ticketStore = require('../lib/oneTimeTicketStore');

const router = express.Router();

const handleCallbackRequest = async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.status(400).send(`Google authorization failed: ${error}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing Google OAuth code or state.');
    }

    try {
        const result = await handleGoogleOAuthCallback({ code, state });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');

        if (result.kind === 'calendar') {
            return res.status(200).send(`
                <html>
                    <head><title>ARC-AI Google Calendar Connected</title></head>
                    <body style="font-family: Arial, sans-serif; padding: 32px; background: #0b1020; color: #e6f0ff;">
                        <h1>Google Calendar connected</h1>
                        <p>You can close this window and return to ARC-AI.</p>
                        <script>
                            window.close();
                        </script>
                    </body>
                </html>
            `);
        }

        if (result.kind === 'auth') {
            // Native clients (the ARC-AI app) ask for a deep-link redirect in
            // the signed OAuth state; bounce straight back to the app with a
            // one-time ticket so it can establish its own session. The target
            // was validated when the state was signed and is re-validated here.
            const nativeRedirect = typeof result.redirect === 'string' ? result.redirect : null;
            if (nativeRedirect && isAllowedNativeRedirect(nativeRedirect)) {
                const separator = nativeRedirect.includes('?') ? '&' : '?';
                if (result.mode === 'link') {
                    return res.redirect(302, `${nativeRedirect}${separator}linked=true`);
                }
                const { ticket } = ticketStore.issue('auth', { token: result.token, user: result.user });
                return res.redirect(302, `${nativeRedirect}${separator}ticket=${encodeURIComponent(ticket)}`);
            }

            // This callback runs on the API host. A cookie set here would be
            // third-party for the frontend host and is blocked by
            // Safari/Firefox (and phased out in Chrome) — the exact failure
            // that emptied dashboards in production. Instead: hand the popup
            // a one-time ticket and REDIRECT it to the frontend's
            // /auth/callback page, which exchanges the ticket through the
            // same-origin /api proxy so the session cookie is attributed to
            // the frontend host (first-party).
            const frontendUrls = (process.env.FRONTEND_URL || '').split(',').map((origin) => origin.trim()).filter(Boolean);
            if (frontendUrls.length === 0) {
                console.error('[Google OAuth] FRONTEND_URL not configured; cannot complete auth callback');
                return res.status(500).send('Server configuration error: FRONTEND_URL not set');
            }
            const { ticket } = ticketStore.issue('auth', { token: result.token, user: result.user });
            const callbackUrl = `${frontendUrls[0].replace(/\/$/, '')}/auth/callback?ticket=${encodeURIComponent(ticket)}`;
            return res.redirect(302, callbackUrl);
        }

        return res.status(500).send('Unknown Google OAuth callback result.');
    } catch (error) {
        console.error('[Google OAuth] Callback error:', error);
        return res.status(500).send(`Failed to connect Google Calendar: ${error.message}`);
    }
};

router.get('/auth-url', protect, async (req, res) => {
    try {
        if (req.authType === 'guest') {
            return res.status(403).json({ success: false, message: 'Google Calendar is available after sign in or sign up.' });
        }
        const url = buildAuthUrl(req.user._id);
        res.json({ success: true, url });
    } catch (error) {
        console.error('[Google OAuth] Failed to generate auth URL:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/status', protect, async (req, res) => {
    try {
        if (req.authType === 'guest') {
            return res.status(403).json({ success: false, connected: false, message: 'Google Calendar requires a signed-in account.' });
        }
        const connected = await isGoogleConnected(req.user._id);
        res.json({ success: true, connected });
    } catch (error) {
        console.error('[Google OAuth] Failed to read connection status:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/callback', handleCallbackRequest);
router.get('/auth/google/callback', handleCallbackRequest);

module.exports = router;