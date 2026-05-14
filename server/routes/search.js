const express = require('express');
const router = express.Router();
const searchController = require('../controllers/searchController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', searchController.searchWorkspace);
router.post('/', searchController.searchWorkspace);

module.exports = router;
