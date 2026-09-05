// server/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const GuestSession = require('../models/GuestSession');

// Authentication boundary: every supported identity (local, guest, Google
// OAuth, future providers) resolves to req.actor = { type, id }.
// See server/lib/actor.js for the canonical model.
const setActor = (req, type, id) => {
    req.actor = { type, id: String(id) };
};

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
                    return res.status(401).json({ message: 'Not authorized, guest session not found', code: 'GUEST_SESSION_EXPIRED' });
                }

                // Expose the canonical guest actor id (sessionId, e.g. "guest_<uuid>").
                // This matches the JWT `id` claim, the Socket.IO userId, and credit
                // accounting. The raw Mongoose `.id` virtual would otherwise leak the
                // internal ObjectId and split guest data across two identities.
                req.user = {
                    ...guestSession.toObject(),
                    id: guestSession.sessionId,
                    userId: guestSession.sessionId
                };
                req.authType = 'guest';
                setActor(req, 'guest', guestSession.sessionId);
                return next();
            }

            req.user = await User.findById(decoded.id).select('-password');

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }

            req.authType = 'user';
            // Canonical user actor id: the stable User ObjectId hex string,
            // regardless of which provider issued the JWT.
            setActor(req, 'user', req.user._id);

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