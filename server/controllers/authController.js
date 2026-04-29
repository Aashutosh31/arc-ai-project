// server/controllers/authController.js
const User = require('../models/User');
const GuestSession = require('../models/GuestSession');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { buildGoogleAppAuthUrl } = require('../services/googleCalendarService');

// Helper to generate JWT token
const generateToken = (id, extraClaims = {}) => {
    return jwt.sign({ id, ...extraClaims }, process.env.JWT_SECRET, {
        expiresIn: '30d', // Token validity
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
            res.status(201).json({
                _id: user.id,
                username: user.username,
                email: user.email,
                token: generateToken(user._id, { role: 'user' }),
                authType: 'user',
                authProvider: user.authProvider || 'local',
                googleLinked: Boolean(user.googleIdentity?.googleId),
                creditsRemaining: user.creditsRemaining,
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

    try {
        // Check for user email
        const user = await User.findOne({ email });

        if (user && (await bcrypt.compare(password, user.password))) {
            user.lastLoginAt = new Date();
            await user.save();

            res.json({
                _id: user.id,
                username: user.username,
                email: user.email,
                token: generateToken(user._id, { role: 'user' }),
                authType: 'user',
                authProvider: user.authProvider || 'local',
                googleLinked: Boolean(user.googleIdentity?.googleId),
                creditsRemaining: user.creditsRemaining,
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

module.exports = {
    registerUser,
    loginUser,
    getMe,
    guestUser,
    getGoogleAuthUrl,
    getGoogleLinkUrl
};