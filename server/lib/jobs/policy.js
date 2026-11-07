'use strict';

// JARVIS Phase 4 — autonomy permission scope.
//
// A scheduled job has no human sitting in front of the approval banner. The
// Phase 1 substrate can therefore only auto-execute capabilities that are
// safe to run unattended. This module is the single policy used by BOTH job
// creation and every run preflight:
//
//   read          -> allowed (observe only)
//   reversible    -> allowed (in-session/local, readily undone)
//   consequential -> rejected; must stay an interactive request
//   unclassified  -> rejected (conservative: never guess for autonomy)
//
// Re-checking at run time matters because an MCP server can be reconfigured
// (or a native mapping can change) after the job was created.

const RISK_SCOPES = Object.freeze(['read', 'reversible', 'consequential']);
const AUTONOMY_SCOPES = Object.freeze(['read', 'reversible']);

const SCOPE_RANK = Object.freeze({
  read: 1,
  reversible: 2,
  consequential: 3
});

const resolveStepScope = (tool, resolveCapability) => {
  let capability = null;
  try {
    capability = resolveCapability(tool);
  } catch {
    capability = null;
  }
  const scope = capability && RISK_SCOPES.includes(capability.scope) ? capability.scope : null;
  return {
    tool,
    scope,
    risk: capability ? capability.risk || null : null,
    known: Boolean(capability)
  };
};

// Returns { ok, code, error, steps, ceiling } — never throws.
const evaluateJobScope = ({ steps = [], riskCeiling = 'reversible' }, resolveCapability) => {
  const ceiling = AUTONOMY_SCOPES.includes(riskCeiling) ? riskCeiling : 'reversible';
  const ceilingRank = SCOPE_RANK[ceiling];

  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, code: 'NO_STEPS', error: 'A job needs at least one step.', ceiling };
  }

  const classified = [];
  for (const step of steps) {
    const tool = String(step && step.tool ? step.tool : '').trim();
    if (!tool) {
      return { ok: false, code: 'INVALID_STEP', error: 'Every step needs a tool name.', ceiling };
    }
    const classification = resolveStepScope(tool, resolveCapability);
    if (!classification.known || !classification.scope) {
      return {
        ok: false,
        code: 'UNCLASSIFIED_CAPABILITY',
        error: `Tool "${tool}" is not classified for unattended execution.`,
        tool,
        ceiling
      };
    }
    if (SCOPE_RANK[classification.scope] > ceilingRank) {
      return {
        ok: false,
        code: classification.scope === 'consequential'
          ? 'CONSEQUENTIAL_REQUIRES_INTERACTION'
          : 'SCOPE_EXCEEDED',
        error: classification.scope === 'consequential'
          ? `Tool "${tool}" is consequential and must be approved interactively.`
          : `Tool "${tool}" exceeds this job's ${ceiling} permission scope.`,
        tool,
        scope: classification.scope,
        ceiling
      };
    }
    classified.push(classification);
  }

  return { ok: true, steps: classified, ceiling };
};

module.exports = {
  RISK_SCOPES,
  AUTONOMY_SCOPES,
  SCOPE_RANK,
  resolveStepScope,
  evaluateJobScope
};
