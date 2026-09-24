'use strict';

// JARVIS Action Substrate — slice 4B: operator-policy accessor consumed at
// the TaskExecutor authorization boundary.
//
// Process-wide configuration knob — deliberate no-I/O module. The pure
// engine's frozen DEFAULT_POLICY is the empty/unconfigured base; SEEDED_BASE
// adds the guest hard-deny defaults (slice 4E). Operators and tests set the
// knob programmatically via setOperatorPolicy, and TaskExecutor reads it on
// every execution (never a per-request DB round trip).
//
// The AUTHORITATIVE persisted policy is owned by the Mongo-backed
// operatorPolicySource.js (slice 4E item 2), which hydrates this knob via
// setOperatorPolicy and keeps it fresh on a bounded interval. Per-request
// one-off policies can still pass through executionOptions.authorizationPolicy
// (a request override never replaces the operator base — it is used as the
// base when present).
//
// The engine itself (authorizationPolicy.js) stays pure: this module only
// holds the operator-supplied base configuration.

const { DEFAULT_POLICY } = require('./authorizationPolicy');

// Guest hard-deny seeded defaults (slice 4E). Guests are ephemeral and
// cannot own workspaces; the process-wide base denies them external /
// consequential / heavy-external natives BY DEFAULT so an unconfigured
// deployment is conservative. Ids verified against the live native registry
// (server/lib/capabilities/discover.js: "native:<schema function name>").
// The frozen DEFAULT_POLICY is untouched — this base is separate.
const GUEST_DENY_DEFAULTS = Object.freeze([
  'native:webSearch',
  'native:scrapeWebsite',
  'native:deepResearchSwarm',
  'native:sendEmail',
  'native:memorize',
  'native:storeUserFact',
  'native:executeCode',
  'native:scheduleMeeting',
]);

const SEEDED_BASE = Object.freeze({
  ...DEFAULT_POLICY,
  guestDenied: GUEST_DENY_DEFAULTS,
});

// Process-wide operator base. Operators/tests may override via
// setOperatorPolicy; unset state resolves to the seeded guest-deny base.
let operator = SEEDED_BASE;

const setOperatorPolicy = (policy) => {
  operator = policy && typeof policy === 'object' ? policy : SEEDED_BASE;
};

const getOperatorPolicy = () => operator || SEEDED_BASE;

const resetOperatorPolicy = () => {
  operator = SEEDED_BASE;
};

module.exports = {
  setOperatorPolicy,
  getOperatorPolicy,
  resetOperatorPolicy,
  DEFAULT_POLICY,
  SEEDED_BASE,
  GUEST_DENY_DEFAULTS,
};