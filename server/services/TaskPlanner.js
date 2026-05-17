const { v4: uuidv4 } = require('uuid');
const Execution = require('../models/Execution');
const TaskExecutor = require('./TaskExecutor');
const ToolRecoveryManager = require('./ToolRecoveryManager');

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
  async createPlan({ userId, title, prompt, steps = [] }) {
    // Steps is array of { tool, args }
    const prepared = steps.map((s) => ({
      id: uuidv4(),
      toolCallId: s.toolCallId || null,
      tool: s.tool,
      args: s.args || {},
      status: 'PENDING'
    }));
    const exec = new Execution({ userId, title: title || (prompt ? String(prompt).slice(0, 80) : 'Plan'), prompt, steps: prepared });
    await exec.save();
    return exec;
  }

  async executePlan(executionId, socket = null, options = {}) {
    const exec = await Execution.findById(executionId);
    if (!exec) throw new Error('Execution not found');
    if (exec.status === 'RUNNING') throw new Error('Execution already running');

    exec.status = 'RUNNING';
    await exec.save();

    const controller = options.controller || null;
    const signal = controller ? controller.signal : null;

    if (socket) {
      socket.emit('ai:plan:status', { executionId, status: 'RUNNING' });
      socket.emit('execution.started', { executionId, status: 'RUNNING' });
    }

    for (let i = 0; i < exec.steps.length; i++) {
      const step = exec.steps[i];
      if (signal && signal.aborted) {
        step.status = 'CANCELLED';
        await exec.save();
        exec.status = 'CANCELLED';
        await exec.save();
        if (socket) socket.emit('ai:plan:status', { executionId, status: 'CANCELLED' });
        return exec;
      }

      step.status = 'RUNNING';
      step.startedAt = new Date();
      await exec.save();
      if (socket) {
        socket.emit('ai:plan:step', { executionId, stepId: step.id, status: 'RUNNING', tool: step.tool });
        socket.emit('execution.step.started', { executionId, stepId: step.id, tool: step.tool });
      }

      try {
        const result = await TaskExecutor.executeTool(step.tool, step.args || {}, exec.userId, socket, { signal });
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
            retryCount: step.retryCount || 0
          });

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

        if (socket) {
          socket.emit('ai:plan:step', { executionId, stepId: step.id, status: step.status, result });
          socket.emit('execution.step.completed', { executionId, stepId: step.id, status: step.status, result: step.result });
        }
      } catch (err) {
        const recovery = await ToolRecoveryManager.recoverToolResult({
          toolName: step.tool,
          args: step.args || {},
          error: err,
          userId: exec.userId,
          socket,
          signal,
          retryCount: step.retryCount || 0
        });

        step.retryCount = recovery.retryCount || 0;
        step.failureReason = recovery.failureReason || String(err?.message || err);
        step.recovered = Boolean(recovery.recovered);
        step.recoveryStrategy = recovery.recoveryStrategy || null;
        step.result = recovery.recovered ? recovery.result : { success: false, error: String(err?.message || err) };
        step.status = recovery.recovered ? 'SUCCEEDED' : 'FAILED';
        step.finishedAt = new Date();
        await exec.save();

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

    const hasHardFailures = exec.steps.some((step) => step.status === 'FAILED' && !step.recovered);
    exec.status = hasHardFailures ? 'FAILED' : 'COMPLETED';
    await exec.save();
    if (socket) {
      socket.emit('ai:plan:status', { executionId, status: exec.status });
      socket.emit(hasHardFailures ? 'execution.failed' : 'execution.completed', { executionId, status: exec.status });
    }
    return exec;
  }

  async resumePlan(executionId, socket = null, options = {}) {
    const exec = await Execution.findById(executionId);
    if (!exec) throw new Error('Execution not found');
    if (exec.status !== 'PLANNED' && exec.status !== 'RUNNING') throw new Error('Execution cannot be resumed');

    // Find first non-terminal step
    const nextIndex = exec.steps.findIndex((s) => ['PENDING', 'RUNNING'].includes(s.status));
    if (nextIndex < 0) return exec;

    // Reuse executePlan which picks up from the document state
    return this.executePlan(executionId, socket, options);
  }
}

module.exports = new TaskPlanner();
