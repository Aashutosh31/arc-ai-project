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

module.exports = {
  DecisionEngine,
  JevDecisionEngine,
  decisionEngine,
  decisionPolicy,
  decisionTypes,
  deterministic,
  loadPolicy: decisionPolicy.loadPolicy
};