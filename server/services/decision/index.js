'use strict';

// Decision layer public facade.
//
//   decisionEngine.decide(...)  -> normalized ARC decision result
//   decisionPolicy              -> thresholds + skip-gate helpers
//
// Rest of ARC depends on this module, never on Jev directly.

const { DecisionEngine } = require('./DecisionEngine');
const { JevDecisionEngine } = require('./jevDecisionEngine');
const decisionPolicy = require('./decisionPolicy');
const decisionTypes = require('./decisionTypes');
const deterministic = require('./deterministicDecisionEngine');

const policy = decisionPolicy.loadPolicy();
const decisionEngine = new DecisionEngine({
  deterministic,
  jev: new JevDecisionEngine({ policy }),
  policy
});

try {
  // Startup config visibility. Explicit bools only — the API key itself is
  // NEVER logged (only whether it is configured). Fail-open stays safe.
  console.log('[Decision] boot', [
    `jevEnabled=${policy.jevEnabled}`,
    `jevModel=${policy.jevModel}`,
    `gatewayKeyConfigured=${policy.gatewayKeyConfigured}`,
    `failOpen=${policy.failOpen}`,
    `noToolThreshold=${policy.noToolThreshold}`,
    `toolThreshold=${policy.toolThreshold}`,
    `decisionTimeoutMs=${policy.decisionTimeoutMs}`
  ].join(' '));
} catch {
  // boot log must never break the facade
}

module.exports = {
  DecisionEngine,
  JevDecisionEngine,
  decisionEngine,
  decisionPolicy,
  decisionTypes,
  deterministic,
  loadPolicy: decisionPolicy.loadPolicy
};