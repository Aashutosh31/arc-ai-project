'use strict';

// JARVIS Action Substrate — slice 4B: operator-policy accessor consumed at
// the TaskExecutor authorization boundary.
//
// Deliberately NOT a store: no persistence, no events, no runtime refresh.
// It is a process-wide configuration knob (default = DEFAULT_POLICY, empty)
// that operators and tests set programmatically and TaskExecutor reads on
// every execution. A persistence-backed policy source is deferred to a
// later slice; per-request one-off policies can still be passed through
// executionOptions.authorizationPolicy (a request override never replaces
// the operator base — it is used as the base when present).
//
// The engine itself (authorizationPolicy.js) stays pure: this module only
// holds the operator-supplied base configuration.

const { DEFAULT_POLICY } = require('./authorizationPolicy');

let operator = DEFAULT_POLICY;

const setOperatorPolicy = (policy) => {
  operator = policy && typeof policy === 'object' ? policy : DEFAULT_POLICY;
};

const getOperatorPolicy = () => operator || DEFAULT_POLICY;

const resetOperatorPolicy = () => {
  operator = DEFAULT_POLICY;
};

module.exports = {
  setOperatorPolicy,
  getOperatorPolicy,
  resetOperatorPolicy,
  DEFAULT_POLICY,
};