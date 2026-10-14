// server/routes/auth.js
const express = require('express');
const { registerUser, loginUser, getMe, guestUser, getGoogleAuthUrl, getGoogleLinkUrl, logout, getSocketTicket, exchangeSession } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/guest', guestUser);
router.post('/logout', logout);
router.get('/google/url', getGoogleAuthUrl);
router.get('/google/link-url', protect, getGoogleLinkUrl);
router.get('/me', protect, getMe);
// One-time handshake ticket for the direct Socket.IO connection (see
// oneTimeTicketStore.js — no third-party cookies required).
router.get('/socket-ticket', protect, getSocketTicket);
// Exchange the Google OAuth popup ticket for the session cookie through the
// same-origin proxy (the popup itself runs on the API host).
router.post('/session', exchangeSession);

module.exports = router;