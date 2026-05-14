const express = require('express');
const router = express.Router();
const memoryController = require('../controllers/memoryController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', memoryController.getMemoryDashboard);
router.patch('/preferences', memoryController.updatePreferences);
router.patch('/facts/:memoryId', memoryController.updateFact);
router.delete('/facts/:memoryId', memoryController.deleteFact);
router.patch('/semantic/:memoryId', memoryController.updateSemanticMemory);
router.delete('/semantic/:memoryId', memoryController.deleteSemanticMemory);

module.exports = router;
