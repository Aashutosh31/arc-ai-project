const crypto = require('crypto');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events'
];

const GOOGLE_APP_SCOPES = [
    'openid',
    'email',
    'profile'
];

const TOKEN_FIELD = 'googleCalendar.encryptedTokenData';

if (!process.env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
    console.error('❌ CRITICAL CONFIGURATION ERROR: GOOGLE_TOKEN_ENCRYPTION_KEY environment variable is not defined.');
    console.error('Please configure GOOGLE_TOKEN_ENCRYPTION_KEY in your .env file to enable secure token encryption.');
    process.exit(1);
}

const getEncryptionKey = () => {
    const key = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    return crypto.createHash('sha256').update(String(key)).digest();
};

const encryptJson = (value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
};

const decryptJson = (blob) => {
    if (!blob) return null;
    const buffer = Buffer.from(blob, 'base64');
    if (buffer.length < 29) return null;

    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
};

const getOAuthClient = () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        throw new Error('Google OAuth environment variables are not configured.');
    }

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

const getFrontendOrigin = () => {
    const configured = (process.env.FRONTEND_URL || '').split(',').map((origin) => origin.trim()).filter(Boolean)[0];
    return configured || '*';
};

const signState = (payload) => {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET must be configured to sign Google OAuth state.');
    }

    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: '15m'
    });
};

const verifyState = (state) => {
    if (!state) throw new Error('Missing OAuth state.');
    const decoded = jwt.verify(state, process.env.JWT_SECRET);

    if (!decoded || !decoded.purpose) {
        throw new Error('Invalid OAuth state.');
    }

    return decoded;
};

const buildAuthUrl = (userId) => {
    const oauth2Client = getOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: GOOGLE_SCOPES,
        include_granted_scopes: true,
        state: signState({ purpose: 'calendar', userId: String(userId) })
    });
};

const buildGoogleAppAuthUrl = ({ mode = 'login', userId = null } = {}) => {
    const oauth2Client = getOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent select_account',
        scope: GOOGLE_APP_SCOPES,
        include_granted_scopes: true,
        state: signState({
            purpose: 'app-auth',
            mode,
            userId: userId ? String(userId) : null
        })
    });
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const getGoogleProfile = async (oauth2Client) => {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data || {};
};

const buildGoogleUserPayload = (user, action = 'signed-in') => ({
    _id: String(user._id),
    username: user.username,
    email: user.email,
    authType: 'user',
    authProvider: user.authProvider || 'local',
    googleLinked: Boolean(user.googleIdentity?.googleId),
    creditsRemaining: Number(user.creditsRemaining || 0),
    action
});

const generateAppToken = (userId) => jwt.sign({ id: String(userId), role: 'user' }, process.env.JWT_SECRET, {
    expiresIn: '30d'
});

const linkGoogleIdentityToUser = async (user, profile) => {
    user.googleIdentity = {
        googleId: String(profile.id || ''),
        email: normalizeEmail(profile.email),
        verifiedEmail: Boolean(profile.verified_email),
        picture: profile.picture || '',
        linkedAt: new Date()
    };

    user.lastLoginAt = new Date();
    await user.save();
    return user;
};

const createGoogleUser = async (profile) => {
    const email = normalizeEmail(profile.email);
    const username = String(profile.name || profile.given_name || email.split('@')[0] || 'ARC User').trim().slice(0, 32);
    const randomPassword = crypto.randomBytes(48).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    const user = await User.create({
        username,
        email,
        password: hashedPassword,
        authProvider: 'google',
        creditsRemaining: 1000,
        googleIdentity: {
            googleId: String(profile.id || ''),
            email,
            verifiedEmail: Boolean(profile.verified_email),
            picture: profile.picture || '',
            linkedAt: new Date()
        }
    });
    return user;
};

const buildCalendarCallbackHtml = (message) => `
    <html>
        <head><title>ARC-AI Google Calendar Connected</title></head>
        <body style="font-family: Arial, sans-serif; padding: 32px; background: #0b1020; color: #e6f0ff;">
            <h1>Google Calendar connected</h1>
            <p>${message}</p>
            <script>
                window.close();
            </script>
        </body>
    </html>
`;

const buildAuthCallbackHtml = (payload) => {
    const frontendOrigin = getFrontendOrigin();
    const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
    const safeOrigin = JSON.stringify(frontendOrigin);

    return `
        <html>
            <head><title>ARC-AI Google Sign-In</title></head>
            <body style="font-family: Arial, sans-serif; padding: 32px; background: #0b1020; color: #e6f0ff;">
                <h1>Google sign-in complete</h1>
                <p>You can close this window and return to ARC-AI.</p>
                <script>
                    (function () {
                        const payload = ${safePayload};
                        const targetOrigin = ${safeOrigin};
                        if (window.opener) {
                            window.opener.postMessage({ type: 'arc-ai-google-auth-success', payload }, targetOrigin);
                        }
                        window.close();
                    })();
                </script>
            </body>
        </html>
    `;
};

const saveTokensForUser = async (userId, tokens) => {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found while saving Google tokens.');
    }

    let existingTokens = null;
    try {
        existingTokens = decryptJson(user.googleCalendar?.encryptedTokenData);
    } catch (error) {
        // Key rotation or corrupted blob: keep OAuth flow healthy by replacing with fresh tokens.
        console.warn('[Google OAuth] Existing encrypted token blob could not be decrypted. Replacing with fresh tokens.', {
            userId: String(userId),
            reason: error?.message || 'unknown'
        });
        existingTokens = null;
    }

    const mergedTokens = {
        ...(existingTokens || {}),
        ...tokens
    };

    user.googleCalendar = {
        connected: true,
        encryptedTokenData: encryptJson(mergedTokens),
        connectedAt: user.googleCalendar?.connectedAt || new Date(),
        updatedAt: new Date()
    };

    await user.save();
    return mergedTokens;
};

const loadTokensForUser = async (userId) => {
    const user = await User.findById(userId).select('googleCalendar');
    if (!user || !user.googleCalendar?.encryptedTokenData) {
        return null;
    }

    try {
        return decryptJson(user.googleCalendar.encryptedTokenData);
    } catch (error) {
        return null;
    }
};

const getAuthorizedOAuthClient = async (userId) => {
    const oauth2Client = getOAuthClient();
    const tokens = await loadTokensForUser(userId);

    if (!tokens) {
        throw new Error('Google Calendar is not connected for this user.');
    }

    oauth2Client.setCredentials(tokens);

    oauth2Client.on('tokens', async (newTokens) => {
        try {
            const current = await loadTokensForUser(userId);
            await saveTokensForUser(userId, {
                ...(current || {}),
                ...newTokens
            });
        } catch (error) {
            console.error('[Google OAuth] Failed to persist refreshed tokens:', error.message);
        }
    });

    return oauth2Client;
};

const exchangeCodeForTokens = async (code, state) => {
    const decoded = verifyState(state);
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    await saveTokensForUser(decoded.userId, tokens);

    return {
        userId: decoded.userId,
        tokens
    };
};

const handleGoogleOAuthCallback = async ({ code, state }) => {
    const decoded = verifyState(state);

    if (decoded.purpose === 'calendar') {
        const result = await exchangeCodeForTokens(code, state);
        return {
            kind: 'calendar',
            ...result
        };
    }

    if (decoded.purpose !== 'app-auth') {
        throw new Error('Unsupported Google OAuth purpose.');
    }

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const profile = await getGoogleProfile(oauth2Client);
    const email = normalizeEmail(profile.email);

    if (!email) {
        throw new Error('Google account did not return an email address.');
    }

    let user = null;

    if (decoded.mode === 'link') {
        if (!decoded.userId) {
            throw new Error('Missing user context for Google account linking.');
        }

        user = await User.findById(decoded.userId);
        if (!user) {
            throw new Error('The current account no longer exists.');
        }

        if (normalizeEmail(user.email) !== email) {
            throw new Error('The Google email must match your account email to link accounts.');
        }

        user = await linkGoogleIdentityToUser(user, profile);
    } else {
        user = await User.findOne({
            $or: [
                { 'googleIdentity.googleId': String(profile.id || '') },
                { email }
            ]
        });

        if (user) {
            if (!user.googleIdentity?.googleId || user.googleIdentity.googleId !== String(profile.id || '')) {
                user = await linkGoogleIdentityToUser(user, profile);
            } else {
                user.lastLoginAt = new Date();
                await user.save();
            }
        } else {
            user = await createGoogleUser(profile);
        }
    }

    return {
        kind: 'auth',
        token: generateAppToken(user._id),
        user: buildGoogleUserPayload(user, decoded.mode === 'link' ? 'linked' : 'signed-in')
    };
};

const isGoogleConnected = async (userId) => {
    const user = await User.findById(userId).select('googleCalendar.connected');
    return Boolean(user?.googleCalendar?.connected);
};

module.exports = {
    GOOGLE_SCOPES,
    GOOGLE_APP_SCOPES,
    buildAuthUrl,
    buildGoogleAppAuthUrl,
    exchangeCodeForTokens,
    handleGoogleOAuthCallback,
    getAuthorizedOAuthClient,
    isGoogleConnected,
    loadTokensForUser,
    saveTokensForUser,
    verifyState,
    decryptJson,
    encryptJson,
    TOKEN_FIELD
};