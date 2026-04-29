const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { buildAuthUrl, isGoogleConnected, handleGoogleOAuthCallback } = require('../services/googleCalendarService');

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
            const payload = JSON.stringify(result).replace(/</g, '\\u003c');
            const frontendOrigin = JSON.stringify((process.env.FRONTEND_URL || '').split(',').map((origin) => origin.trim()).filter(Boolean)[0] || '*');

            return res.status(200).send(`
                <html>
                    <head><title>ARC-AI Google Sign-In Complete</title></head>
                    <body style="font-family: Arial, sans-serif; padding: 32px; background: #0b1020; color: #e6f0ff;">
                        <h1>Google sign-in complete</h1>
                        <p>You can close this window and return to ARC-AI.</p>
                        <script>
                            (function () {
                                const payload = ${payload};
                                const targetOrigin = ${frontendOrigin};
                                if (window.opener) {
                                    window.opener.postMessage({ type: 'arc-ai-google-auth-success', payload }, targetOrigin);
                                }
                                window.close();
                            })();
                        </script>
                    </body>
                </html>
            `);
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