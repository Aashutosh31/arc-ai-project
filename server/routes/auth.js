// server/routes/auth.js
const express = require('express');
const { registerUser, loginUser, getMe, guestUser, getGoogleAuthUrl, getGoogleLinkUrl } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/guest', guestUser);
router.get('/google/url', getGoogleAuthUrl);
router.get('/google/link-url', protect, getGoogleLinkUrl);
router.get('/me', protect, getMe); 

module.exports = router;