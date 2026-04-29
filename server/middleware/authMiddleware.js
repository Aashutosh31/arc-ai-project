// server/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const GuestSession = require('../models/GuestSession');

const protect = async (req, res, next) => {
    let token;

    // Check for token in headers (standard Bearer format)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            // Get token from header
            token = req.headers.authorization.split(' ')[1];

            // Verify token and get user ID
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded.role === 'guest') {
                const guestSession = await GuestSession.findOne({ sessionId: decoded.id });

                if (!guestSession) {
                    return res.status(401).json({ message: 'Not authorized, guest session not found' });
                }

                req.user = guestSession;
                req.authType = 'guest';
                return next();
            }

            req.user = await User.findById(decoded.id).select('-password');

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }

            req.authType = 'user';

            next();
        } catch (error) {
            console.error(error);
            return res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }
};

module.exports = { protect };