'use strict';

const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const Job = require('../models/Job');
const JobRun = require('../models/JobRun');
const Execution = require('../models/Execution');
const TaskPlanner = require('./TaskPlanner');
const { normalizeTrigger, computeNextRun, describeTrigger } = require('../lib/jobs/schedule');
const { evaluateJobScope, AUTONOMY_SCOPES } = require('../lib/jobs/policy');
const { resolveCapability } = require('../lib/capabilities/executionEnvelope');
const notifier = require('../lib/jobs/notifier');

const MAX_STEPS = 20;
const MAX_LIST = 50;
const MAX_LIVE_JOBS = 25;
const MAX_RUNS = 20;
const MAX_ERROR = 600;
const MAX_SUMMARY = 500;
const MAX_EVIDENCE = 8;
const AUTO_PAUSE_FAILURES = 3;
const LEASE_MS = 5 * 60 * 1000;
const ORPHAN_MS = 15 * 60 * 1000;

const fail = (code, message, extra = {}) => {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
};

const truncate = (value, max) => {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// Missing/blank/'global' all mean the global workspace (workspaceId null),
// exactly like Phase 3 memory. Never "all workspaces".
const normalizeWorkspaceId = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'global') return null;
  if (!mongoose.Types.ObjectId.isValid(text)) {
    throw fail('INVALID_WORKSPACE', 'Invalid workspace id.');
  }
  return text;
};

const sameWorkspace = (docWorkspaceId, expected) => {
  const actual = docWorkspaceId ? String(docWorkspaceId) : null;
  return actual === expected;
};

const normalizeSteps = (steps) => {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw fail('NO_STEPS', 'A job needs at least one plan step.');
  }
  if (steps.length > MAX_STEPS) {
    throw fail('TOO_MANY_STEPS', `A job may contain at most ${MAX_STEPS} steps.`);
  }
  return steps.map((step) => {
    const tool = String(step && step.tool ? step.tool : '').trim();
    if (!tool) throw fail('INVALID_STEP', 'Every step needs a tool name.');
    const args = step && typeof step.args === 'object' && step.args !== null && !Array.isArray(step.args)
      ? step.args
      : {};
    let encoded;
    try {
      encoded = JSON.stringify(args);
    } catch {
      throw fail('INVALID_STEP', `Arguments for ${tool} are not serializable.`);
    }
    if (encoded.length > 16 * 1024) {
      throw fail('INVALID_STEP', `Arguments for ${tool} are too large for a scheduled job.`);
    }
    return { tool, args };
  });
};

const serializeJob = (job) => {
  const trigger = job.trigger || {};
  const steps = Array.isArray(job.action && job.action.steps) ? job.action.steps : [];
  return {
    jobId: String(job._id || job.id || ''),
    id: String(job._id || job.id || ''),
    userId: String(job.userId || ''),
    workspaceId: job.workspaceId ? String(job.workspaceId) : null,
    title: job.title || 'Scheduled job',
    prompt: job.prompt || '',
    status: job.status || 'ACTIVE',
    trigger: {
      type: trigger.type || 'schedule',
      cron: trigger.cron || null,
      runAt: trigger.runAt || null,
      timezone: trigger.timezone || 'UTC',
      description: describeTrigger(trigger)
    },
    action: {
      type: (job.action && job.action.type) || 'plan',
      prompt: (job.action && job.action.prompt) || '',
      stepCount: steps.length,
      sourceExecutionId: job.action && job.action.sourceExecutionId
        ? String(job.action.sourceExecutionId)
        : null,
      steps: steps.map((step) => ({ tool: step.tool }))
    },
    riskCeiling: job.riskCeiling || 'reversible',
    notifyOn: {
      success: job.notifyOn ? job.notifyOn.success !== false : true,
      failure: job.notifyOn ? job.notifyOn.failure !== false : true
    },
    nextRunAt: job.nextRunAt || null,
    lastRunAt: job.lastRunAt || null,
    lastRunStatus: job.lastRunStatus || null,
    lastError: job.lastError || null,
    runCount: Number(job.runCount) || 0,
    consecutiveFailures: Number(job.consecutiveFailures) || 0,
    pausedAt: job.pausedAt || null,
    cancelledAt: job.cancelledAt || null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null
  };
};

const serializeRun = (run) => ({
  runId: String(run._id || run.id || ''),
  jobId: String(run.jobId || ''),
  status: run.status || 'RUNNING',
  trigger: run.trigger || 'schedule',
  scheduledFor: run.scheduledFor || null,
  startedAt: run.startedAt || null,
  finishedAt: run.finishedAt || null,
  executionId: run.executionId ? String(run.executionId) : null,
  summary: run.summary || '',
  error: run.error || null,
  evidence: Array.isArray(run.evidence) ? run.evidence : [],
  notificationRead: Boolean(run.notificationRead),
  createdAt: run.createdAt || null
});

const evidenceForExecution = (execution) => {
  const steps = Array.isArray(execution && execution.steps) ? execution.steps : [];
  return steps.slice(0, MAX_EVIDENCE).map((step) => {
    let detail = '';
    const result = step.result;
    if (typeof result === 'string') detail = result;
    else if (result && typeof result === 'object') {
      for (const key of ['message', 'summary', 'answer', 'text', 'output', 'content']) {
        if (typeof result[key] === 'string' && result[key].trim()) {
          detail = result[key];
          break;
        }
      }
      if (!detail) {
        try {
          detail = JSON.stringify(result);
        } catch {
          detail = '';
        }
      }
    }
    const suffix = detail ? ` — ${truncate(detail, 240)}` : '';
    return {
      label: step.tool || 'Step',
      value: `${String(step.status || 'PENDING').toLowerCase()}${suffix}`
    };
  });
};

const summaryForExecution = (execution) => {
  const steps = Array.isArray(execution && execution.steps) ? execution.steps : [];
  const succeeded = steps.filter((step) => step.status === 'SUCCEEDED').length;
  const failed = steps.filter((step) => step.status === 'FAILED').length;
  const blocked = steps.filter((step) => step.status === 'BLOCKED').length;
  const parts = [`${succeeded}/${steps.length} steps succeeded`];
  if (failed) parts.push(`${failed} failed`);
  if (blocked) parts.push(`${blocked} blocked`);
  const firstMessage = steps
    .map((step) => step.result)
    .map((result) => (result && typeof result === 'object'
      ? (result.message || result.summary || '')
      : ''))
    .find((text) => typeof text === 'string' && text.trim());
  if (firstMessage) parts.push(truncate(firstMessage, 180));
  return truncate(parts.join(' · '), MAX_SUMMARY);
};

const statusForExecution = (execution) => {
  switch (String(execution && execution.status || '').toUpperCase()) {
    case 'COMPLETED': return 'SUCCEEDED';
    case 'CANCELLED': return 'CANCELLED';
    case 'BLOCKED': return 'BLOCKED';
    case 'FAILED': return 'FAILED';
    default: return 'FAILED';
  }
};

const buildRunSocket = (io, userId) => {
  if (!io || !userId) return null;
  const room = `user:${userId}`;
  return {
    // No connection id: the executor can never bind an interactive approval
    // to a scheduled run. Autonomy policy rejects consequential work before
    // this point; this is defense in depth.
    id: null,
    userId: String(userId),
    isInterrupted: false,
    emit(event, payload) {
      try {
        io.to(room).emit(event, payload);
      } catch {
        // Notification failure must never fail a run.
      }
    }
  };
};

class JobService {
  constructor() {
    // In-flight run controllers. Cancel must reach the current run on this
    // single-node server; durable Job.status still stops every future run.
    this.activeControllers = new Map();
  }

  async createJob({
    userId,
    workspaceId = null,
    title,
    prompt = '',
    trigger,
    steps,
    sourceExecutionId = null,
    riskCeiling = 'reversible',
    notifyOn = {}
  } = {}) {
    if (!userId) throw fail('UNAUTHORIZED', 'A signed-in account is required.');

    const scopedWorkspaceId = normalizeWorkspaceId(workspaceId);
    let resolvedSteps;
    let sourceTitle = '';
    let resolvedPrompt = prompt;
    let sourceId = null;
    const notifyPrefs = notifyOn && typeof notifyOn === 'object' ? notifyOn : {};

    if (sourceExecutionId) {
      if (!mongoose.Types.ObjectId.isValid(String(sourceExecutionId))) {
        throw fail('PLAN_NOT_FOUND', 'Source plan not found.');
      }
      const execution = await Execution.findOne({ _id: sourceExecutionId, userId }).lean();
      if (!execution) throw fail('PLAN_NOT_FOUND', 'Source plan not found.');
      if (!sameWorkspace(execution.workspaceId, scopedWorkspaceId)) {
        throw fail('PLAN_NOT_FOUND', 'Source plan not found in this workspace.');
      }
      resolvedSteps = (execution.steps || []).map((step) => ({
        tool: step.tool,
        args: step.args || {}
      }));
      sourceTitle = execution.title || '';
      resolvedPrompt = resolvedPrompt || execution.prompt || '';
      sourceId = execution._id;
    } else {
      resolvedSteps = steps;
    }

    const normalizedSteps = normalizeSteps(resolvedSteps);
    const ceiling = AUTONOMY_SCOPES.includes(riskCeiling) ? riskCeiling : 'reversible';
    const scope = evaluateJobScope({ steps: normalizedSteps, riskCeiling: ceiling }, resolveCapability);
    if (!scope.ok) throw fail(scope.code, scope.error, { detail: scope });

    // Bounded autonomy: a runaway client cannot fill the scheduler with an
    // unbounded number of active/paused definitions.
    const liveJobs = await Job.countDocuments({
      userId,
      workspaceId: scopedWorkspaceId,
      status: { $in: ['ACTIVE', 'PAUSED'] }
    });
    if (liveJobs >= MAX_LIVE_JOBS) {
      throw fail('TOO_MANY_JOBS', `At most ${MAX_LIVE_JOBS} active or paused scheduled jobs are allowed per workspace.`);
    }

    const normalizedTrigger = normalizeTrigger(trigger, { now: new Date() });
    if (!normalizedTrigger.ok) {
      throw fail(normalizedTrigger.code, normalizedTrigger.error);
    }

    const nextRunAt = computeNextRun(normalizedTrigger.trigger, new Date());
    if (!nextRunAt) {
      throw fail('NO_FUTURE_RUN', 'This trigger has no future occurrence.');
    }

    const job = new Job({
      userId,
      workspaceId: scopedWorkspaceId,
      title: truncate(String(title || sourceTitle || 'Scheduled job').trim(), 140) || 'Scheduled job',
      prompt: truncate(resolvedPrompt || '', 2000),
      trigger: normalizedTrigger.trigger,
      action: {
        type: 'plan',
        prompt: truncate(resolvedPrompt || '', 2000),
        steps: normalizedSteps,
        sourceExecutionId: sourceId
      },
      status: 'ACTIVE',
      riskCeiling: ceiling,
      notifyOn: {
        success: notifyPrefs.success !== false,
        failure: notifyPrefs.failure !== false
      },
      nextRunAt
    });
    await job.save();

    const payload = serializeJob(job);
    notifier.jobUpdated(userId, payload);
    return payload;
  }

  async listJobs({ userId, workspaceId = null, limit = 30, status = null } = {}) {
    if (!userId) return [];
    const scoped = normalizeWorkspaceId(workspaceId);
    const query = { userId, workspaceId: scoped };
    if (status) query.status = status;
    const capped = Math.max(1, Math.min(Number(limit) || 30, MAX_LIST));
    const jobs = await Job.find(query).sort({ updatedAt: -1 }).limit(capped).lean();
    return jobs.map(serializeJob);
  }

  async getJob(jobId, { userId, workspaceId = null } = {}) {
    if (!userId) throw fail('UNAUTHORIZED', 'A signed-in account is required.');
    if (!mongoose.Types.ObjectId.isValid(String(jobId || ''))) {
      throw fail('JOB_NOT_FOUND', 'Scheduled job not found.');
    }
    const scoped = normalizeWorkspaceId(workspaceId);
    const job = await Job.findOne({ _id: jobId, userId });
    if (!job || !sameWorkspace(job.workspaceId, scoped)) {
      throw fail('JOB_NOT_FOUND', 'Scheduled job not found.');
    }
    return job;
  }

  async setStatus(jobId, action, { userId, workspaceId = null } = {}) {
    const job = await this.getJob(jobId, { userId, workspaceId });
    const now = new Date();

    if (action === 'pause') {
      if (job.status !== 'ACTIVE') {
        throw fail('INVALID_STATE', `Cannot pause a ${job.status.toLowerCase()} job.`);
      }
      job.status = 'PAUSED';
      job.pausedAt = now;
      job.nextRunAt = null;
    } else if (action === 'resume') {
      if (!['PAUSED', 'FAILED'].includes(job.status)) {
        throw fail('INVALID_STATE', `Cannot resume a ${job.status.toLowerCase()} job.`);
      }
      const nextRunAt = computeNextRun(job.trigger, now);
      if (!nextRunAt) throw fail('TRIGGER_EXPIRED', 'This trigger has no future occurrence.');
      job.status = 'ACTIVE';
      job.pausedAt = null;
      job.lastError = null;
      job.consecutiveFailures = 0;
      job.nextRunAt = nextRunAt;
    } else if (action === 'cancel') {
      if (['CANCELLED', 'COMPLETED'].includes(job.status)) {
        return serializeJob(job);
      }
      job.status = 'CANCELLED';
      job.cancelledAt = now;
      job.nextRunAt = null;
      job.lockedAt = null;
      job.lockedBy = null;
      // Stop the in-flight step loop for this job. The persisted status is
      // what prevents any future occurrence regardless of process lifecycle.
      this._cancelActiveRun(job._id);
    } else {
      throw fail('INVALID_ACTION', 'Unknown job action.');
    }

    job.updatedAt = now;
    await job.save();
    const payload = serializeJob(job);
    notifier.jobUpdated(userId, payload);
    return payload;
  }

  async listRuns(jobId, { userId, workspaceId = null, limit = 10 } = {}) {
    const job = await this.getJob(jobId, { userId, workspaceId });
    const capped = Math.max(1, Math.min(Number(limit) || 10, MAX_RUNS));
    const runs = await JobRun.find({ jobId: job._id })
      .sort({ createdAt: -1 })
      .limit(capped)
      .lean();
    return runs.map(serializeRun);
  }

  async countUnreadRuns({ userId, workspaceId = null } = {}) {
    if (!userId) return 0;
    const scoped = normalizeWorkspaceId(workspaceId);
    return JobRun.countDocuments({
      userId,
      workspaceId: scoped,
      notificationRead: false
    });
  }

  async markNotificationsRead({ userId, workspaceId = null } = {}) {
    if (!userId) return 0;
    const scoped = normalizeWorkspaceId(workspaceId);
    const result = await JobRun.updateMany(
      { userId, workspaceId: scoped, notificationRead: false },
      { $set: { notificationRead: true } }
    );
    return result.modifiedCount || 0;
  }

  // Creates the durable occurrence + Execution, then returns. Execution is
  // deliberately separate so the scheduler can advance nextRunAt BEFORE the
  // side effects start.
  async beginRun(job, { trigger = 'manual', scheduledFor = null } = {}) {
    if (job.status === 'CANCELLED') {
      throw fail('JOB_CANCELLED', 'This job is cancelled.');
    }

    const scope = evaluateJobScope(
      { steps: (job.action && job.action.steps) || [], riskCeiling: job.riskCeiling },
      resolveCapability
    );

    const occurrenceKey = trigger === 'schedule' && scheduledFor
      ? `schedule:${new Date(scheduledFor).toISOString()}`
      : `${trigger}:${new Date().toISOString()}:${randomUUID()}`;

    if (!scope.ok) {
      const run = await this._recordBlockedRun(job, {
        occurrenceKey,
        trigger,
        scheduledFor,
        error: `${scope.code}: ${scope.error}`
      });
      return { run, execution: null, blocked: true };
    }

    let run;
    try {
      run = await JobRun.create({
        jobId: job._id,
        userId: job.userId,
        workspaceId: job.workspaceId || null,
        occurrenceKey,
        scheduledFor: scheduledFor || null,
        trigger,
        status: 'RUNNING',
        startedAt: new Date()
      });
    } catch (error) {
      if (error && error.code === 11000) {
        const existing = await JobRun.findOne({ jobId: job._id, occurrenceKey }).lean();
        return { run: existing ? serializeRun(existing) : null, execution: null, duplicate: true };
      }
      throw error;
    }

    // The occurrence is now recorded. Any failure below still leaves honest
    // history instead of a silently lost scheduled event.
    let execution;
    try {
      execution = await TaskPlanner.createPlan({
        userId: job.userId,
        workspaceId: job.workspaceId || null,
        title: job.title,
        prompt: job.prompt || job.title,
        steps: (job.action && job.action.steps) || []
      });
    } catch (error) {
      await this._finalizeRun(job, run, {
        status: 'FAILED',
        error: truncate(error?.message || 'Could not create the plan.', MAX_ERROR)
      });
      throw error;
    }

    run.executionId = execution._id;
    await run.save();

    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          lastRunAt: new Date(),
          lastRunStatus: 'RUNNING',
          updatedAt: new Date()
        },
        $inc: { runCount: 1 }
      }
    );

    const io = notifier.getIo();
    if (io) {
      try {
        io.to(`user:${job.userId}`).emit('execution.created', {
          executionId: String(execution._id),
          title: job.title,
          workspaceId: job.workspaceId ? String(job.workspaceId) : null
        });
      } catch {
        // best-effort live UI only
      }
    }
    const freshJob = await Job.findById(job._id).lean();
    if (freshJob) notifier.jobUpdated(job.userId, serializeJob(freshJob));

    return { run: serializeRun(run), execution };
  }

  async executeRun(job, run, execution) {
    const io = notifier.getIo();
    const controller = new AbortController();
    const key = String(job._id);
    let controllers = this.activeControllers.get(key);
    if (!controllers) {
      controllers = new Set();
      this.activeControllers.set(key, controllers);
    }
    controllers.add(controller);
    let final;
    try {
      const started = await TaskPlanner.executePlan(execution._id, buildRunSocket(io, job.userId), {
        userId: job.userId,
        workspaceId: job.workspaceId || null,
        controller
      });
      const status = statusForExecution(started);
      final = await this._finalizeRun(job, run, {
        status,
        summary: summaryForExecution(started),
        error: status === 'SUCCEEDED'
          ? null
          : truncate(started.lastError || this._executionError(started), MAX_ERROR),
        evidence: evidenceForExecution(started),
        executionId: started._id
      });
    } catch (error) {
      final = await this._finalizeRun(job, run, {
        status: 'FAILED',
        error: truncate(error?.message || 'Scheduled run failed.', MAX_ERROR)
      });
    } finally {
      controllers.delete(controller);
      if (!controllers.size && this.activeControllers.get(key) === controllers) {
        this.activeControllers.delete(key);
      }
    }
    return final;
  }

  async runJob(job, options = {}) {
    try {
      const begun = await this.beginRun(job, options);
      if (begun.duplicate || begun.blocked || !begun.execution || !begun.run) {
        await this._releaseLease(job._id);
        return begun;
      }
      const run = await JobRun.findById(begun.run.runId);
      if (!run) {
        await this._releaseLease(job._id);
        return begun;
      }
      await this.executeRun(job, run, begun.execution);
      return begun;
    } catch (error) {
      await this._releaseLease(job._id);
      throw error;
    }
  }

  // Manual runs return immediately; progress arrives through the user room.
  async manualRun(jobId, { userId, workspaceId = null } = {}) {
    const job = await this.getJob(jobId, { userId, workspaceId });
    const begun = await this.beginRun(job, { trigger: 'manual' });
    if (begun.duplicate || begun.blocked || !begun.execution) return begun;

    const run = await JobRun.findById(begun.run.runId);
    if (run) {
      void this.executeRun(job, run, begun.execution).catch((error) => {
        console.error('[Jobs] manual run failed:', error?.message || error);
      });
    }
    return begun;
  }

  async _recordBlockedRun(job, { occurrenceKey, trigger, scheduledFor, error }) {
    let run;
    try {
      run = await JobRun.create({
        jobId: job._id,
        userId: job.userId,
        workspaceId: job.workspaceId || null,
        occurrenceKey,
        scheduledFor: scheduledFor || null,
        trigger,
        status: 'BLOCKED',
        startedAt: new Date(),
        finishedAt: new Date(),
        summary: 'Run blocked by the job permission scope.',
        error: truncate(error, MAX_ERROR),
        notificationRead: false
      });
    } catch (createError) {
      if (createError && createError.code === 11000) {
        const existing = await JobRun.findOne({ jobId: job._id, occurrenceKey }).lean();
        return serializeRun(existing || {});
      }
      throw createError;
    }

    await this._applyJobOutcome(job, 'BLOCKED', error);
    await this._releaseLease(job._id);
    this._notify(job, run, 'BLOCKED');
    return serializeRun(run);
  }

  async _finalizeRun(job, run, { status, summary = '', error = null, evidence = [], executionId = null }) {
    const finishedAt = new Date();
    const updated = await JobRun.findByIdAndUpdate(
      run._id,
      {
        $set: {
          status,
          summary: truncate(summary, MAX_SUMMARY),
          error: error ? truncate(error, MAX_ERROR) : null,
          evidence: Array.isArray(evidence) ? evidence.slice(0, MAX_EVIDENCE) : [],
          executionId: executionId || run.executionId || null,
          finishedAt
        }
      },
      { new: true }
    ).lean();

    await this._applyJobOutcome(job, status, error);
    await this._releaseLease(job._id);

    if (updated) this._notify(job, updated, status);
    return updated ? serializeRun(updated) : null;
  }

  async _applyJobOutcome(job, status, error) {
    const now = new Date();
    const fresh = await Job.findById(job._id);
    if (!fresh) return;

    // A user pause/cancel during the run always wins over the run outcome,
    // but the run's terminal status is still honest history.
    if (fresh.status === 'CANCELLED') {
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            lastRunAt: now,
            lastRunStatus: status,
            lockedAt: null,
            lockedBy: null,
            updatedAt: now
          }
        }
      );
      return;
    }

    const set = {
      lastRunAt: now,
      lastRunStatus: status,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now
    };

    if (status === 'SUCCEEDED') {
      set.lastError = null;
      set.consecutiveFailures = 0;
      if (fresh.trigger && fresh.trigger.type === 'once') {
        set.status = 'COMPLETED';
        set.nextRunAt = null;
      }
    } else if (status === 'CANCELLED') {
      set.lastError = error ? truncate(error, MAX_ERROR) : null;
      set.consecutiveFailures = fresh.consecutiveFailures || 0;
      if (fresh.trigger && fresh.trigger.type === 'once') {
        set.status = 'CANCELLED';
        set.nextRunAt = null;
      }
    } else {
      const consecutive = Number(fresh.consecutiveFailures || 0) + 1;
      set.lastError = error ? truncate(error, MAX_ERROR) : 'Scheduled run failed.';
      set.consecutiveFailures = consecutive;
      if (fresh.trigger && fresh.trigger.type === 'once') {
        set.status = 'FAILED';
        set.nextRunAt = null;
      } else if (consecutive >= AUTO_PAUSE_FAILURES) {
        set.status = 'PAUSED';
        set.pausedAt = now;
        set.nextRunAt = null;
        set.lastError = truncate(
          `Paused after ${AUTO_PAUSE_FAILURES} consecutive failures: ${set.lastError}`,
          MAX_ERROR
        );
      }
    }

    await Job.updateOne({ _id: job._id }, { $set: set });
  }

  async _releaseLease(jobId) {
    try {
      await Job.updateOne(
        { _id: jobId },
        { $set: { lockedAt: null, lockedBy: null } }
      );
    } catch (error) {
      console.error('[Jobs] lease release failed:', error?.message || error);
    }
  }

  _cancelActiveRun(jobId) {
    const key = String(jobId);
    const controllers = this.activeControllers.get(key);
    if (!controllers) return;
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch (error) {
        console.error('[Jobs] run abort failed:', error?.message || error);
      }
    }
    this.activeControllers.delete(key);
  }

  _notify(job, run, status) {
    const notifyOn = job.notifyOn || {};
    const isSuccess = status === 'SUCCEEDED';
    const isFailure = status === 'FAILED' || status === 'BLOCKED';

    // Job state always refreshes live, even when the user turned off success
    // or failure notifications. Only the toast-style notification is gated.
    void Job.findById(job._id).lean().then((fresh) => {
      if (fresh) notifier.jobUpdated(job.userId, serializeJob(fresh));
    }).catch(() => {});

    if (isSuccess && notifyOn.success === false) return;
    if (isFailure && notifyOn.failure === false) return;
    if (!isSuccess && !isFailure) return;

    const payload = {
      jobId: String(job._id),
      runId: String(run._id || ''),
      workspaceId: job.workspaceId ? String(job.workspaceId) : null,
      title: job.title,
      status,
      summary: run.summary || '',
      error: run.error || null,
      executionId: run.executionId ? String(run.executionId) : null,
      occurredAt: run.finishedAt || new Date(),
      unread: true
    };
    notifier.jobNotification(job.userId, payload);
  }

  _executionError(execution) {
    const steps = Array.isArray(execution && execution.steps) ? execution.steps : [];
    const failed = steps.find((step) => step.status === 'FAILED' || step.status === 'BLOCKED');
    return (failed && (failed.failureReason || failed.error)) || execution?.lastError || 'Scheduled run did not complete.';
  }

  async recoverOrphanedRuns() {
    // The scheduler is single-node, so at startup every RUNNING run belongs to
    // a previous process and is orphaned. Age filtering would leave a recent
    // crash wedged forever, so finalize all of them honestly here.
    const cutoff = new Date(Date.now() - ORPHAN_MS);
    const stale = await JobRun.find({ status: 'RUNNING' }).limit(100);
    for (const run of stale) {
      run.status = 'FAILED';
      run.error = 'Run interrupted before completion (server restart).';
      run.finishedAt = new Date();
      await run.save();

      const job = await Job.findById(run.jobId);
      if (job) {
        // The occurrence is never retried automatically: a partially executed
        // run must not replay side effects. Finalize the job honestly instead.
        await this._applyJobOutcome(job, 'FAILED', run.error);
        this._notify(job, run, 'FAILED');
      } else {
        notifier.jobNotification(run.userId, {
          jobId: String(run.jobId),
          runId: String(run._id),
          workspaceId: run.workspaceId ? String(run.workspaceId) : null,
          status: 'FAILED',
          title: 'Scheduled job interrupted',
          summary: '',
          error: run.error,
          executionId: run.executionId ? String(run.executionId) : null,
          occurredAt: run.finishedAt,
          unread: true
        });
      }
    }

    // A crash can land between claiming a one-shot job and writing its
    // JobRun. No side effect occurred in that window, so re-arm the job
    // instead of leaving it ACTIVE forever with no next run.
    const orphanOnce = await Job.find({
      status: 'ACTIVE',
      'trigger.type': 'once',
      nextRunAt: null,
      lastRunAt: null
    }).limit(25);
    for (const job of orphanOnce) {
      job.nextRunAt = new Date();
      await job.save();
      notifier.jobUpdated(job.userId, serializeJob(job));
    }

    await Job.updateMany(
      { lockedAt: { $lt: cutoff } },
      { $set: { lockedAt: null, lockedBy: null } }
    );
    return stale.length + orphanOnce.length;
  }

  async claimDueJobs(now = new Date(), instanceId = 'scheduler') {
    const due = await Job.find({
      status: 'ACTIVE',
      nextRunAt: { $ne: null, $lte: now }
    }).sort({ nextRunAt: 1 }).limit(3).lean();

    const claimed = [];
    for (const candidate of due) {
      const job = await Job.findOneAndUpdate(
        {
          _id: candidate._id,
          status: 'ACTIVE',
          nextRunAt: candidate.nextRunAt,
          $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - LEASE_MS) } }]
        },
        { $set: { lockedAt: now, lockedBy: instanceId } },
        { new: true }
      );
      if (!job) continue;

      // Advance the schedule BEFORE the side effect starts. A crash after this
      // point loses at most one occurrence; it can never double-run one.
      const scheduledFor = job.nextRunAt;
      const nextRunAt = job.trigger && job.trigger.type === 'schedule'
        ? computeNextRun(job.trigger, new Date(Math.max(now.getTime(), new Date(scheduledFor).getTime())))
        : null;
      await Job.updateOne(
        { _id: job._id },
        { $set: { nextRunAt, updatedAt: new Date() } }
      );
      claimed.push({ job, scheduledFor });
    }
    return claimed;
  }
}

module.exports = new JobService();
module.exports._private = {
  normalizeWorkspaceId,
  normalizeSteps,
  serializeJob,
  serializeRun,
  evidenceForExecution,
  summaryForExecution,
  statusForExecution,
  AUTO_PAUSE_FAILURES,
  LEASE_MS,
  MAX_STEPS
};
