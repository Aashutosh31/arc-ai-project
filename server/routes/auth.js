// server/routes/auth.js
const express = require('express');
const { registerUser, loginUser, getMe } = require('../controllers/authController');
const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
// router.get('/me', protect, getMe); // 'protect' middleware will be added later

module.exports = router;