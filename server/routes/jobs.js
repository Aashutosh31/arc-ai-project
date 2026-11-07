const express = require('express');
const router = express.Router();
const jobService = require('../services/jobService');
const { protect } = require('../middleware/authMiddleware');
const { getActor, isGuestActor } = require('../lib/actor');

// JARVIS Phase 4 — proactive autonomy REST surface.
//
// Every route is owner-scoped from the authenticated actor (never a
// client-asserted userId) and strictly workspace-scoped: a missing workspace
// means the global workspace, never "all workspaces". Guests cannot create
// or inspect scheduled jobs; autonomy requires a durable real account.
router.use(protect);

const actorFor = (req) => getActor(req);
const rejectGuest = (req, res) => {
  const actor = actorFor(req);
  if (actor && isGuestActor(actor)) {
    res.status(403).json({
      error: 'Scheduled jobs require a signed-in account.',
      code: 'GUEST_NOT_ALLOWED'
    });
    return true;
  }
  return false;
};

const userIdFor = (req) => actorFor(req)?.id || null;
const workspaceFor = (req) => req.query?.workspaceId ?? req.body?.workspaceId ?? null;

const sendError = (res, error) => {
  const status = error?.code === 'JOB_NOT_FOUND' || error?.code === 'PLAN_NOT_FOUND'
    ? 404
    : error?.code === 'UNAUTHORIZED'
      ? 401
      : error?.code === 'INVALID_STATE' || error?.code === 'TRIGGER_EXPIRED'
        ? 409
        : 400;
  return res.status(status).json({
    error: error?.message || 'Scheduled job request failed.',
    code: error?.code || 'JOB_ERROR',
    detail: error?.detail || null
  });
};

router.get('/', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const [jobs, unreadCount] = await Promise.all([
      jobService.listJobs({
        userId: userIdFor(req),
        workspaceId: workspaceFor(req),
        status: req.query.status || null,
        limit: req.query.limit
      }),
      jobService.countUnreadRuns({
        userId: userIdFor(req),
        workspaceId: workspaceFor(req)
      })
    ]);
    res.json({ jobs, unreadCount });
  } catch (error) {
    console.error('[Jobs] list error:', error?.message || error);
    sendError(res, error);
  }
});

router.post('/notifications/read', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const updated = await jobService.markNotificationsRead({
      userId: userIdFor(req),
      workspaceId: workspaceFor(req)
    });
    res.json({ success: true, updated });
  } catch (error) {
    console.error('[Jobs] mark read error:', error?.message || error);
    sendError(res, error);
  }
});

router.post('/', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const body = req.body || {};
    const job = await jobService.createJob({
      userId: userIdFor(req),
      workspaceId: body.workspaceId,
      title: body.title,
      prompt: body.prompt,
      trigger: body.trigger,
      steps: body.steps,
      sourceExecutionId: body.sourceExecutionId || null,
      riskCeiling: body.riskCeiling,
      notifyOn: body.notifyOn
    });
    res.status(201).json({ job });
  } catch (error) {
    console.error('[Jobs] create error:', error?.message || error);
    sendError(res, error);
  }
});

router.get('/:jobId', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const job = await jobService.getJob(req.params.jobId, {
      userId: userIdFor(req),
      workspaceId: req.query.workspaceId || null
    });
    res.json({ job: jobService._private.serializeJob(job) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:jobId/pause', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const job = await jobService.setStatus(req.params.jobId, 'pause', {
      userId: userIdFor(req),
      workspaceId: req.body?.workspaceId || req.query.workspaceId || null
    });
    res.json({ job });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:jobId/resume', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const job = await jobService.setStatus(req.params.jobId, 'resume', {
      userId: userIdFor(req),
      workspaceId: req.body?.workspaceId || req.query.workspaceId || null
    });
    res.json({ job });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:jobId/cancel', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const job = await jobService.setStatus(req.params.jobId, 'cancel', {
      userId: userIdFor(req),
      workspaceId: req.body?.workspaceId || req.query.workspaceId || null
    });
    res.json({ job });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:jobId/run', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const result = await jobService.manualRun(req.params.jobId, {
      userId: userIdFor(req),
      workspaceId: req.body?.workspaceId || req.query.workspaceId || null
    });
    res.status(202).json({
      success: !result.blocked,
      run: result.run,
      blocked: Boolean(result.blocked),
      duplicate: Boolean(result.duplicate)
    });
  } catch (error) {
    console.error('[Jobs] manual run error:', error?.message || error);
    sendError(res, error);
  }
});

router.get('/:jobId/runs', async (req, res) => {
  if (rejectGuest(req, res)) return;
  try {
    const runs = await jobService.listRuns(req.params.jobId, {
      userId: userIdFor(req),
      workspaceId: req.query.workspaceId || null,
      limit: req.query.limit
    });
    res.json({ runs });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
