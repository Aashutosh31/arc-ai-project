const { v4: uuidv4 } = require('uuid');
const Execution = require('../models/Execution');
const TaskExecutor = require('./TaskExecutor');
const ToolRecoveryManager = require('./ToolRecoveryManager');
const WorkspaceLogger = require('../lib/WorkspaceLogger');

/**
 * TaskPlanner
 * Minimal, safe scaffolding for Phase 3 task planning and execution.
 * - Creates execution documents with ordered steps
 * - Executes steps sequentially via TaskExecutor
 * - Emits socket events to report progress (if socket provided)
 * - Respects an AbortSignal passed via options
 *
 * Design goals: non-invasive, uses existing TaskExecutor and tools, preserves streaming and socket behaviour.
 */
class TaskPlanner {
  constructor() {
    this.wsLog = new WorkspaceLogger('TaskPlanner');
    // Single-node in-process guard: the server runs on one Render instance,
    // so this prevents two concurrent resumes of the same plan from racing
    // the persisted RUNNING state. Persisted state remains the source of
    // truth after a restart.
    this.activeExecutions = new Set();
  }

  async createPlan({ userId, title, prompt, steps = [], workspaceId = null }) {
    // Steps is array of { tool, args }
    const prepared = steps.map((s) => ({
      id: uuidv4(),
      toolCallId: s.toolCallId || null,
      tool: s.tool,
      args: s.args || {},
      status: 'PENDING'
    }));
    const exec = new Execution({ userId, workspaceId: workspaceId || null, title: title || (prompt ? String(prompt).slice(0, 80) : 'Plan'), prompt, steps: prepared });
    await exec.save();
    this.wsLog.executionCreated(userId, exec._id.toString(), workspaceId, exec.title);
    return exec;
  }

  async executePlan(executionId, socket = null, options = {}) {
    const key = String(executionId || '');
    if (!key) throw new Error('Execution not found');
    if (this.activeExecutions.has(key)) throw new Error('Execution already running');
    this.activeExecutions.add(key);
    try {
      return await this.runPlan(executionId, socket, options);
    } finally {
      this.activeExecutions.delete(key);
    }
  }

  async runPlan(executionId, socket = null, options = {}) {
    const exec = await Execution.findById(executionId);
    if (!exec) throw new Error('Execution not found');
    
    // Verify execution belongs to the requesting user (workspace isolation)
    const requestWorkspaceId = options.workspaceId && String(options.workspaceId) !== 'global'
      ? options.workspaceId
      : null;
    if (requestWorkspaceId && String(exec.workspaceId || '') !== String(requestWorkspaceId)) {
      throw new Error('Execution not found in this workspace');
    }
    // Identity hardening (slice 4E): the execution must belong to the
    // authenticated requester. Ownership is never inferred from a
    // client-asserted workspaceId — it is bound to the socket identity.
    const requesterId = (options.userId || (socket && socket.userId)) || null;
    if (requesterId && String(exec.userId || '') !== String(requesterId)) {
      throw new Error('Execution not found');
    }

    const resume = Boolean(options.resume);
    const resumeFromStatus = exec.status;
    if (exec.status === 'RUNNING' && !resume) throw new Error('Execution already running');
    if (exec.status === 'COMPLETED' && !resume) return exec;

    if (resume) exec.resumeCount = (exec.resumeCount || 0) + 1;
    exec.status = 'RUNNING';
    exec.lastError = null;
    exec.completedAt = null;
    await exec.save();
    this.wsLog.executionStarted(exec.userId, executionId, exec.workspaceId, exec.steps.length);

    const controller = options.controller || null;
    const signal = controller ? controller.signal : null;
    const isCancelled = () => Boolean(signal?.aborted || socket?.isInterrupted);
    // A cancelled plan is resumed because the user explicitly asked for it,
    // so its cancelled steps are retryable by default. Failed/blocked steps
    // are likewise retried on resume; callers may opt out explicitly.
    const retryFailed = options.retryFailed !== false;
    const retryBlocked = options.retryBlocked !== false;
    const retryCancelled = options.retryCancelled !== undefined
      ? Boolean(options.retryCancelled)
      : resumeFromStatus === 'CANCELLED';

    if (socket) {
      socket.emit('ai:plan:status', { executionId, status: 'RUNNING' });
      socket.emit('execution.started', { executionId, status: 'RUNNING' });
      if (resume) {
        socket.emit('execution.resumed', {
          executionId,
          status: 'RUNNING',
          resumeCount: exec.resumeCount,
          workspaceId: exec.workspaceId ? String(exec.workspaceId) : null
        });
      }
    }

    // Persist terminal plan state atomically with the reason. Resume reads
    // this to decide what work remains, and the UI renders it after reload.
    const finishExecution = async (status, error = null) => {
      exec.status = status;
      exec.lastError = error || null;
      exec.completedAt = new Date();
      await exec.save();
    };

    for (let i = 0; i < exec.steps.length; i++) {
      const step = exec.steps[i];

      // Durable execution: a successful step is never run again. On resume we
      // re-run only non-terminal (crash-left RUNNING) or explicitly retryable
      // (FAILED/BLOCKED/CANCELLED) work.
      if (step.status === 'SUCCEEDED') continue;
      if (step.status !== 'PENDING') {
        const retryable =
          resume && (
            step.status === 'RUNNING' ||
            (step.status === 'FAILED' && retryFailed) ||
            (step.status === 'BLOCKED' && retryBlocked) ||
            (step.status === 'CANCELLED' && retryCancelled)
          );
        if (!retryable) continue;
      }

      if (isCancelled()) {
        step.status = 'CANCELLED';
        await exec.save();
        await finishExecution('CANCELLED');
        if (socket) socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
        return exec;
      }

      // Assign/reuse the logical action identity BEFORE the side effect. A
      // crash after this save keeps the same key, so the capability layer
      // replays the completed side effect instead of duplicating it. A
      // deliberate retry of a terminal failure gets a fresh identity so the
      // previous failure is not replayed.
      const deliberateRetry =
        resume && ['FAILED', 'BLOCKED', 'CANCELLED'].includes(step.status);
      if (!step.idempotencyKey || deliberateRetry) {
        step.idempotencyKey = deliberateRetry
          ? `${executionId}:${step.id}:retry:${uuidv4()}`
          : `${executionId}:${step.id}`;
      }
      step.status = 'RUNNING';
      step.attempts = (step.attempts || 0) + 1;
      step.lastAttemptAt = new Date();
      step.startedAt = new Date();
      step.finishedAt = null;
      step.failureReason = null;
      await exec.save();
      if (socket) {
        socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'RUNNING', tool: step.tool });
        socket.emit('execution.step.started', { executionId, stepId: step.id, tool: step.tool });
      }

      try {
        if (isCancelled()) {
          step.status = 'CANCELLED';
          step.failureReason = 'Execution cancelled by user.';
          step.recovered = false;
          step.recoveryStrategy = 'cancelled';
          step.finishedAt = new Date();
          await exec.save();
          this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
          if (socket) {
            socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'CANCELLED', error: step.failureReason });
            socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'CANCELLED', result: { cancelled: true } });
          }
          await finishExecution('CANCELLED');
          this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
          if (socket) {
            socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
            socket.emit('execution.completed', { executionId, status: 'CANCELLED' });
          }
          return exec;
        }

        const result = await TaskExecutor.executeTool(step.tool, step.args || {}, exec.userId, socket, {
          signal,
          workspaceId: exec.workspaceId,
          conversationId: options.conversationId || null,
          idempotencyKey: step.idempotencyKey
        });
        if (result?.cancelled || signal?.aborted) {
          step.status = 'CANCELLED';
          step.failureReason = result?.error || 'Execution cancelled by user.';
          step.recovered = false;
          step.recoveryStrategy = 'cancelled';
          step.result = { cancelled: true };
          step.finishedAt = new Date();
          await exec.save();
          this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
          if (socket) {
            socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'CANCELLED', error: step.failureReason });
            socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'CANCELLED', result: step.result });
            socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
            socket.emit('execution.completed', { executionId, status: 'CANCELLED' });
          }
          await finishExecution('CANCELLED');
          this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
          return exec;
        }
        if (result?.blocked || result?.status === 'BLOCKED') {
          const blockedReason = result?.error || result?.reason || 'insufficient credits';
          step.status = 'BLOCKED';
          step.failureReason = blockedReason;
          step.recovered = false;
          step.recoveryStrategy = 'blocked';
          step.result = {
            blocked: true,
            reason: result?.reason || 'insufficient_credits',
            error: blockedReason,
            creditsRemaining: result?.creditsRemaining ?? null
          };
          step.finishedAt = new Date();
          await exec.save();
          this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
          if (socket) {
            socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'BLOCKED', error: blockedReason });
            socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'BLOCKED', result: step.result });
            socket.emit('execution.blocked', { executionId, stepId: step.id, status: 'BLOCKED', reason: blockedReason, creditsRemaining: result?.creditsRemaining ?? null });
            socket.emit('ai:plan:status', { executionId, status: 'BLOCKED' });
          }
          await finishExecution('BLOCKED', blockedReason);
          this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
          if (socket) {
            socket.emit('execution.completed', { executionId, status: 'BLOCKED', reason: blockedReason });
          }
          return exec;
        }
        if (result && result.success) {
          step.result = result;
          step.status = 'SUCCEEDED';
          step.recovered = false;
          step.recoveryStrategy = null;
        } else {
          const recovery = await ToolRecoveryManager.recoverToolResult({
            toolName: step.tool,
            args: step.args || {},
            result,
            error: null,
            userId: exec.userId,
            socket,
            signal,
            retryCount: step.retryCount || 0,
            workspaceId: exec.workspaceId,
            conversationId: options.conversationId || null
          });

          if (recovery?.classification?.type === 'blocked' || recovery?.blocked) {
            const blockedReason = recovery?.failureReason || result?.error || 'insufficient credits';
            step.status = 'BLOCKED';
            step.failureReason = blockedReason;
            step.recovered = false;
            step.recoveryStrategy = 'blocked';
            step.result = {
              blocked: true,
              reason: recovery?.classification?.reason || 'insufficient_credits',
              error: blockedReason,
              creditsRemaining: result?.creditsRemaining ?? null
            };
            step.finishedAt = new Date();
            await exec.save();
            this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
            if (socket) {
              socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'BLOCKED', error: blockedReason });
              socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'BLOCKED', result: step.result });
              socket.emit('execution.blocked', { executionId, stepId: step.id, status: 'BLOCKED', reason: blockedReason, creditsRemaining: result?.creditsRemaining ?? null });
              socket.emit('ai:plan:status', { executionId, status: 'BLOCKED' });
              socket.emit('execution.completed', { executionId, status: 'BLOCKED', reason: blockedReason });
            }
            await finishExecution('BLOCKED', blockedReason);
            this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
            return exec;
          }

          if (isCancelled()) {
            step.status = 'CANCELLED';
            step.failureReason = 'Execution cancelled by user.';
            step.recovered = false;
            step.recoveryStrategy = 'cancelled';
            step.result = { cancelled: true };
            step.finishedAt = new Date();
            await exec.save();
            this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
            if (socket) {
              socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'CANCELLED', error: step.failureReason });
              socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'CANCELLED', result: step.result });
              socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
              socket.emit('execution.completed', { executionId, status: 'CANCELLED' });
            }
            await finishExecution('CANCELLED');
            this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
            return exec;
          }

          step.retryCount = recovery.retryCount || 0;
          step.failureReason = recovery.failureReason || null;
          step.recovered = Boolean(recovery.recovered);
          step.recoveryStrategy = recovery.recoveryStrategy || null;
          step.result = recovery.recovered ? recovery.result : result;
          step.status = recovery.recovered ? 'SUCCEEDED' : 'FAILED';

          if (!recovery.recovered && recovery.shouldReplan && socket) {
            socket.emit('execution.replan.suggested', {
              executionId,
              stepId: step.id,
              tool: step.tool,
              reason: recovery.failureReason || 'step failed'
            });
            socket.emit('ai:agent:status', {
              status: 'replanning',
              detail: `Adaptive recovery failed for ${step.tool}; continuing with remaining execution.`
            });
          }
        }

        step.finishedAt = new Date();
        await exec.save();
        this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);

        if (socket) {
          socket.emit('ai:plan:step', { executionId, stepId: step.id, status: step.status, result });
          socket.emit('execution.step.completed', { executionId, stepId: step.id, status: step.status, result: step.result });
        }
      } catch (err) {
        const errorText = String(err?.message || err || '').toLowerCase();
        const isAbortError =
          err?.name === 'AbortError' ||
          errorText.includes('aborted') ||
          errorText.includes('cancelled') ||
          errorText.includes('user_interrupted');

        if (isAbortError || signal?.aborted) {
          step.status = 'CANCELLED';
          step.failureReason = 'Execution cancelled by user.';
          step.recovered = false;
          step.recoveryStrategy = 'cancelled';
          step.result = { cancelled: true };
          step.finishedAt = new Date();
          await exec.save();
          this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
          if (socket) {
            socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'CANCELLED', error: step.failureReason });
            socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'CANCELLED', result: step.result });
            socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
            socket.emit('execution.completed', { executionId, status: 'CANCELLED' });
          }
          await finishExecution('CANCELLED');
          this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
          return exec;
        }

        const recovery = await ToolRecoveryManager.recoverToolResult({
          toolName: step.tool,
          args: step.args || {},
          error: err,
          userId: exec.userId,
          socket,
          signal,
          retryCount: step.retryCount || 0,
          workspaceId: exec.workspaceId,
          conversationId: options.conversationId || null
        });

        if (isCancelled()) {
          step.status = 'CANCELLED';
          step.failureReason = 'Execution cancelled by user.';
          step.recovered = false;
          step.recoveryStrategy = 'cancelled';
          step.result = { cancelled: true };
          step.finishedAt = new Date();
          await exec.save();
          this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);
          if (socket) {
            socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'CANCELLED', error: step.failureReason });
            socket.emit('execution.step.completed', { executionId, stepId: step.id, status: 'CANCELLED', result: step.result });
            socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
            socket.emit('execution.completed', { executionId, status: 'CANCELLED' });
          }
          await finishExecution('CANCELLED');
          this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
          return exec;
        }

        step.retryCount = recovery.retryCount || 0;
        step.failureReason = recovery.failureReason || String(err?.message || err);
        step.recovered = Boolean(recovery.recovered);
        step.recoveryStrategy = recovery.recoveryStrategy || null;
        step.result = recovery.recovered ? recovery.result : { success: false, error: String(err?.message || err) };
        step.status = recovery.recovered ? 'SUCCEEDED' : 'FAILED';
        step.finishedAt = new Date();
        await exec.save();
        this.wsLog.executionStepCompleted(exec.userId, executionId, exec.workspaceId, i, step.tool, step.status);

        if (!recovery.recovered && recovery.shouldReplan && socket) {
          socket.emit('execution.replan.suggested', {
            executionId,
            stepId: step.id,
            tool: step.tool,
            reason: step.failureReason
          });
          socket.emit('ai:agent:status', {
            status: 'replanning',
            detail: `Adaptive recovery failed for ${step.tool}; continuing with remaining execution.`
          });
        }

        if (socket) {
          socket.emit('ai:plan:step', { executionId, stepId: step.id, status: step.status, error: step.failureReason });
          socket.emit('execution.step.failed', { executionId, stepId: step.id, error: step.failureReason });
        }
        // Continue safely with the rest of the execution graph.
      }
    }

    if (isCancelled()) {
      await finishExecution('CANCELLED');
      this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
      if (socket) {
        socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
        socket.emit('execution.completed', { executionId, status: 'CANCELLED' });
      }
      return exec;
    }

    const blockedStep = exec.steps.find((step) => step.status === 'BLOCKED');
    if (blockedStep) {
      await finishExecution('BLOCKED', blockedStep.failureReason || 'Execution blocked');
      this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
      if (socket) {
        socket.emit('ai:plan:status', { executionId, status: 'BLOCKED' });
        socket.emit('execution.completed', { executionId, status: 'BLOCKED' });
      }
      return exec;
    }

    const failedStep = exec.steps.find((step) => step.status === 'FAILED' && !step.recovered);
    const hasHardFailures = Boolean(failedStep);
    await finishExecution(hasHardFailures ? 'FAILED' : 'COMPLETED', failedStep?.failureReason || null);
    this.wsLog.executionCompleted(exec.userId, executionId, exec.workspaceId, exec.status);
    if (socket) {
      socket.emit('ai:plan:status', { executionId, status: exec.status });
      socket.emit(hasHardFailures ? 'execution.failed' : 'execution.completed', { executionId, status: exec.status });
    }
    return exec;
  }

  async resumePlan(executionId, socket = null, options = {}) {
    const exec = await Execution.findById(executionId);
    if (!exec) throw new Error('Execution not found');

    // Ownership is bound to the authenticated requester, exactly like
    // executePlan. A client-asserted userId is never trusted on its own.
    const requesterId = (options.userId || (socket && socket.userId)) || null;
    if (requesterId && String(exec.userId || '') !== String(requesterId)) {
      throw new Error('Execution not found');
    }
    const requestWorkspaceId = options.workspaceId && String(options.workspaceId) !== 'global'
      ? options.workspaceId
      : null;
    if (requestWorkspaceId && String(exec.workspaceId || '') !== String(requestWorkspaceId)) {
      throw new Error('Execution not found in this workspace');
    }

    if (exec.status === 'COMPLETED') throw new Error('Execution already completed');
    if (!exec.steps.length) throw new Error('Execution has no steps to resume');

    // A plan left RUNNING (crash/restart) is resumable: completed steps are
    // skipped and the interrupted step reuses its persisted idempotency key.
    // Reuse executePlan so there is exactly one execution path.
    return this.executePlan(executionId, socket, { ...options, resume: true });
  }

  async getPlan(executionId, { userId = null, workspaceId = null } = {}) {
    const exec = await Execution.findById(executionId).lean();
    if (!exec) return null;
    if (userId && String(exec.userId || '') !== String(userId)) return null;
    if (workspaceId) {
      const expected = String(workspaceId);
      const actual = exec.workspaceId ? String(exec.workspaceId) : 'global';
      if (actual !== expected) return null;
    }
    return this.serializePlan(exec);
  }

  async listPlans({ userId, workspaceId = null, limit = 20, status = null } = {}) {
    if (!userId) return [];
    const query = { userId };
    if (workspaceId && String(workspaceId) !== 'global') {
      query.workspaceId = workspaceId;
    } else if (String(workspaceId) === 'global') {
      query.workspaceId = null;
    }
    if (status) query.status = status;
    const capped = Math.max(1, Math.min(Number(limit) || 20, 50));
    const docs = await Execution.find(query)
      .sort({ updatedAt: -1 })
      .limit(capped)
      .lean();
    return docs.map((doc) => this.serializePlan(doc, { summary: true }));
  }

  serializePlan(doc, { summary = false } = {}) {
    const steps = Array.isArray(doc.steps) ? doc.steps : [];
    const base = {
      executionId: String(doc._id || doc.id || ''),
      id: String(doc._id || doc.id || ''),
      title: doc.title || 'Autonomous plan',
      prompt: doc.prompt || '',
      status: doc.status || 'PLANNED',
      workspaceId: doc.workspaceId ? String(doc.workspaceId) : null,
      resumeCount: doc.resumeCount || 0,
      lastError: doc.lastError || null,
      createdAt: doc.createdAt || null,
      updatedAt: doc.updatedAt || null,
      completedAt: doc.completedAt || null,
      stepCount: steps.length,
      succeeded: steps.filter((s) => s.status === 'SUCCEEDED').length,
      failed: steps.filter((s) => s.status === 'FAILED').length,
      blocked: steps.filter((s) => s.status === 'BLOCKED').length,
      resumable: Boolean(doc.status && doc.status !== 'COMPLETED' && steps.length > 0)
    };
    if (summary) return base;
    return {
      ...base,
      steps: steps.map((step) => ({
        id: step.id,
        stepId: step.id,
        tool: step.tool,
        args: step.args || {},
        status: step.status || 'PENDING',
        attempts: step.attempts || 0,
        retryCount: step.retryCount || 0,
        failureReason: step.failureReason || null,
        recovered: Boolean(step.recovered),
        recoveryStrategy: step.recoveryStrategy || null,
        result: step.result,
        startedAt: step.startedAt || null,
        finishedAt: step.finishedAt || null,
        lastAttemptAt: step.lastAttemptAt || null
      }))
    };
  }
}

module.exports = new TaskPlanner();
