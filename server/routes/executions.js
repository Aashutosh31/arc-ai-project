const express = require('express');
const router = express.Router();
const TaskPlanner = require('../services/TaskPlanner');
const { protect } = require('../middleware/authMiddleware');

// JARVIS Phase 2 — durable plan history.
// Read-only, owner-scoped views over persisted Execution documents. Resume
// itself runs through the authenticated Socket.IO path so progress events
// reach the initiating session; these routes never execute work.
router.use(protect);

const requesterId = (req) => req.user?._id || req.user?.id || req.user?.userId || null;

router.get('/', async (req, res) => {
  try {
    const plans = await TaskPlanner.listPlans({
      userId: requesterId(req),
      workspaceId: req.query.workspaceId || null,
      limit: req.query.limit,
      status: req.query.status || null,
    });
    res.json({ plans });
  } catch (err) {
    console.error('[Executions] list error:', err?.message || err);
    res.status(500).json({ error: 'Failed to list executions' });
  }
});

router.get('/:executionId', async (req, res) => {
  try {
    const plan = await TaskPlanner.getPlan(req.params.executionId, {
      userId: requesterId(req),
      workspaceId: req.query.workspaceId || null,
    });
    if (!plan) return res.status(404).json({ error: 'Execution not found' });
    res.json({ plan });
  } catch (err) {
    console.error('[Executions] get error:', err?.message || err);
    res.status(500).json({ error: 'Failed to load execution' });
  }
});

module.exports = router;
