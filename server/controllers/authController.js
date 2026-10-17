// server/controllers/authController.js
const User = require('../models/User');
const GuestSession = require('../models/GuestSession');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { buildGoogleAppAuthUrl } = require('../services/googleCalendarService');
const ticketStore = require('../lib/oneTimeTicketStore');

const isProduction = process.env.NODE_ENV === 'production';

// Helper to generate JWT token
const generateToken = (id, extraClaims = {}) => {
    return jwt.sign({ id, ...extraClaims }, process.env.JWT_SECRET, {
        expiresIn: '30d', // Token validity
    });
};

// Helper to set httpOnly cookie
const setTokenCookie = (res, token) => {
    res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: '/'
    });
};

const isStrongPassword = (password) => {
    if (typeof password !== 'string') return false;
    const hasLength = password.length >= 8;
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSymbol = /[^a-zA-Z0-9]/.test(password);
    return hasLength && hasLower && hasUpper && hasDigit && hasSymbol;
};

const createGuestSession = async () => {
    const sessionId = `guest_${crypto.randomUUID()}`;
    const guestSession = await GuestSession.create({ sessionId, displayName: 'Guest', creditsRemaining: 12 });
    const token = generateToken(sessionId, { role: 'guest' });

    return {
        _id: guestSession.sessionId,
        username: guestSession.displayName,
        email: null,
        token,
        authType: 'guest',
        authProvider: 'guest',
        googleLinked: false,
        creditsRemaining: guestSession.creditsRemaining
    };
};

// @desc    Register new user
// @route   POST /api/auth/register
const getMe = async (req, res) => {
    // req.user is set by the protect middleware
    const payload = req.user?.toObject ? req.user.toObject() : req.user;
    res.status(200).json({
        ...payload,
        authType: req.authType || 'user'
    });
};

const registerUser = async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ message: 'Please include all fields' });
    }

    try {
        if (!isStrongPassword(password)) {
            return res.status(400).json({
                message: 'Password must be at least 8 characters and include upper, lower, number, and symbol characters.'
            });
        }

        // Check if user exists
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create user
        const user = await User.create({
            username,
            email,
            password: hashedPassword,
            authProvider: 'local',
            creditsRemaining: 1000
        });

        if (user) {
            const token = generateToken(user._id, { role: 'user' });
            setTokenCookie(res, token);
            res.status(201).json({
                _id: user.id,
                username: user.username,
                email: user.email,
                authType: 'user',
                authProvider: user.authProvider || 'local',
                googleLinked: Boolean(user.googleIdentity?.googleId),
                creditsRemaining: user.creditsRemaining,
                // Additive: native clients (React Native) cannot rely on the
                // httpOnly cookie, so the token is also returned in the body.
                // Browser clients ignore this field and keep using the cookie.
                token,
                message: 'Registration successful. ARC-AI memory initialized.'
            });
        } else {
            res.status(400).json({ message: 'Invalid user data' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error during registration' });
    }
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
const loginUser = async (req, res) => {
    const { email, password } = req.body;

    //validate email and password
    if(
        typeof email !== 'string' || typeof password !== 'string' 
    ){
        return res.status(400).json({ message: 'Invalid email or password format' });
    }

    try {
        // Check for user email
        const user = await User.findOne({ email });

        if (user && (await bcrypt.compare(password, user.password))) {
            user.lastLoginAt = new Date();
            await user.save();

            const token = generateToken(user._id, { role: 'user' });
            setTokenCookie(res, token);
            res.json({
                _id: user.id,
                username: user.username,
                email: user.email,
                authType: 'user',
                authProvider: user.authProvider || 'local',
                googleLinked: Boolean(user.googleIdentity?.googleId),
                creditsRemaining: user.creditsRemaining,
                // Additive: see registerUser. Native clients read this token.
                token,
            });
        } else if (user && user.authProvider === 'google') {
            return res.status(400).json({
                message: 'This account uses Google sign-in. Please continue with Google.'
            });
        } else {
            res.status(400).json({ message: 'Invalid credentials' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error during login' });
    }
};

const guestUser = async (req, res) => {
    try {
        const guest = await createGuestSession();
        setTokenCookie(res, guest.token);
        // Additive: also return the token in the body so native clients can
        // authenticate without an httpOnly cookie. The cookie remains the
        // authoritative path for browser clients.
        res.status(201).json(guest);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to create guest session' });
    }
};

const getGoogleAuthUrl = async (req, res) => {
    try {
        const url = buildGoogleAppAuthUrl({ mode: 'login' });
        res.json({ success: true, url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message || 'Unable to start Google sign-in' });
    }
};

const getGoogleLinkUrl = async (req, res) => {
    try {
        const url = buildGoogleAppAuthUrl({ mode: 'link', userId: req.user._id });
        res.json({ success: true, url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message || 'Unable to start Google account linking' });
    }
};

const logout = async (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/'
    });
    res.json({ success: true, message: 'Logged out successfully' });
};

// @desc    Issue a one-time Socket.IO handshake ticket
// @route   GET /api/auth/socket-ticket
// The realtime socket connects DIRECTLY to this API host (the frontend's
// hosting proxy cannot forward WebSocket upgrades), so the browser would
// need a third-party cookie for the handshake — blocked by Safari/Firefox
// and phased out in Chrome. The client instead fetches this ticket over
// the same-origin /api proxy (first-party cookie) and presents it in
// `handshake.auth.ticket`.
const getSocketTicket = async (req, res) => {
    try {
        const userId = req.actor?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ message: 'Not authorized, no token' });
        }
        const { ticket, expiresInMs } = ticketStore.issue('socket', {
            userId: String(userId),
            authType: req.authType || 'user',
        });
        res.json({ ticket, expiresInMs });
    } catch (error) {
        console.error('[socket-ticket] issue failed:', error?.message || error);
        res.status(500).json({ message: 'Failed to issue socket ticket' });
    }
};

// @desc    Exchange an OAuth popup ticket for the session cookie
// @route   POST /api/auth/session
// The Google OAuth callback runs on the API host and cannot set a cookie
// the frontend host will send (cross-site). It hands the popup a one-time
// ticket; the frontend's /auth/callback page posts it HERE through the
// same-origin proxy, so the Set-Cookie is attributed to the frontend host.
const exchangeSession = async (req, res) => {
    const { ticket } = req.body || {};
    const data = ticketStore.consume('auth', ticket);
    if (!data || !data.token) {
        return res.status(401).json({ message: 'Invalid or expired sign-in ticket' });
    }
    setTokenCookie(res, data.token);
    // Additive: native clients cannot receive the redirect cookie, so the
    // token is also returned in the body for them.
    res.json({ success: true, user: data.user || null, token: data.token });
};

module.exports = {
    registerUser,
    loginUser,
    getMe,
    guestUser,
    getGoogleAuthUrl,
    getGoogleLinkUrl,
    logout,
    getSocketTicket,
    exchangeSession
};