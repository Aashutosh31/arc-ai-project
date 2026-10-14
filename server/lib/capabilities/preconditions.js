'use strict';

// Pure capability precondition metadata.
//
// WHAT THIS IS
// A declaration of which *execution-context facts* must hold before a
// capability can possibly succeed. It exists for one reason: a planner should
// not spend a research step dispatching a capability whose failure is
// predictable from context we already hold. A guest asking for deep research
// is refused by operatorPolicy GUEST_DENY_DEFAULTS (see operatorPolicy.js
// GUEST_DENY_DEFAULTS -> 'native:deepResearchSwarm'), and the credit ledger
// then refuses a non-persisted actor. Both outcomes are knowable up front.
//
// WHAT THIS IS NOT
// It is NOT an authorization layer and it gates nothing. It has no I/O, no
// policy, and no enforcement. TaskExecutor remains the only authority: it
// re-checks authorization, approval, credits and idempotency on every call.
// A planner that ignores this table is still correct, just wasteful.
//
// UNKNOWN IS NOT FALSE
// Facts arrive from the host and may be unknown (null). An unknown fact
// yields 'unverified', never a refusal, because refusing on ignorance would
// hide capabilities that would actually work. Execution still fails closed.
//
// DYNAMIC PRECONDITIONS ARE DELIBERATELY ABSENT
// A precondition that requires a database read to know (is Google Calendar
// connected? does this MCP server have credentials?) is not declared here.
// Pretending to know would be a lie; TaskExecutor surfaces the real error.

const FACT_AUTHENTICATED_ACTOR = 'authenticatedActor';
const FACT_CREDIT_BALANCE = 'creditBalance';

// Precondition kinds, with the host fact each one needs.
const KIND_AUTHENTICATED_ACTOR = 'authenticated_actor';
const KIND_CREDIT_BALANCE = 'credit_balance';

const PRECONDITION_FACT = Object.freeze({
  [KIND_AUTHENTICATED_ACTOR]: FACT_AUTHENTICATED_ACTOR,
  [KIND_CREDIT_BALANCE]: FACT_CREDIT_BALANCE,
});

// Declared preconditions for the real tool registry.
//
// `basis` quotes the check that makes the precondition real, so a reviewer can
// confirm the declaration against the implementation instead of trusting it.
//
//   deepResearchSwarm  - guest-denied by id (operatorPolicy.js), and it
//                        re-enters the substrate for nested credit-charged
//                        calls, so a guest/non-persisted actor cannot succeed.
//   checkCalendar      - googleCalendarService.js requires a real User with
//                        encryptedTokenData; a guest id has no such document.
//   scheduleMeeting    - same googleCalendarService.js path.
//   sendWhatsAppMessage- sendWhatsAppMessage.js throws 'Missing user context
//                        for WhatsApp send' with no authenticated user.
//   storeUserFact      - UserFact.userId is an ObjectId ref to a real user; a
//                        guest_ id cannot be cast.
const CAPABILITY_PRECONDITIONS = Object.freeze({
  deepResearchSwarm: Object.freeze([
    Object.freeze({
      kind: KIND_AUTHENTICATED_ACTOR,
      basis: "operatorPolicy.js GUEST_DENY_DEFAULTS includes 'native:deepResearchSwarm'; creditService.getActorRecord() requires a persisted User for a non-guest id",
    }),
    Object.freeze({
      kind: KIND_CREDIT_BALANCE,
      // Kept in step with TaskExecutor's TOOL_CREDIT_COSTS by
      // tests/capabilityPreconditions.test.js, which re-derives it from the live
      // table rather than trusting this number.
      minCredits: 8,
      basis: 'TaskExecutor TOOL_CREDIT_COSTS.deepResearchSwarm = 8',
    }),
  ]),
  checkCalendar: Object.freeze([
    Object.freeze({
      kind: KIND_AUTHENTICATED_ACTOR,
      basis: "googleCalendarService.js getAuthorizedOAuthClient() needs User.findById(userId) with googleCalendar.encryptedTokenData",
    }),
  ]),
  scheduleMeeting: Object.freeze([
    Object.freeze({
      kind: KIND_AUTHENTICATED_ACTOR,
      basis: "googleCalendarService.js getAuthorizedOAuthClient() needs User.findById(userId) with googleCalendar.encryptedTokenData",
    }),
  ]),
  sendWhatsAppMessage: Object.freeze([
    Object.freeze({
      kind: KIND_AUTHENTICATED_ACTOR,
      basis: "sendWhatsAppMessage.js throws 'Missing user context for WhatsApp send' when context.userId is absent",
    }),
  ]),
  storeUserFact: Object.freeze([
    Object.freeze({
      kind: KIND_AUTHENTICATED_ACTOR,
      basis: 'storeUserFact.js writes UserFact.userId as an ObjectId ref to a persisted User',
    }),
  ]),
});

const preconditionsFor = (name) => {
  if (!name || typeof name !== 'string') return [];
  const declared = CAPABILITY_PRECONDITIONS[name];
  return Array.isArray(declared) ? declared : [];
};

/**
 * Evaluate declared preconditions against host-supplied facts.
 *
 * Pure. Returns a status the planner can act on plus the individual verdicts,
 * so a refusal can be reported rather than swallowed.
 *
 *   { status: 'satisfied'|'unverified'|'unmet',
 *     unmet: [{ kind, fact, reason }],
 *     unverified: [{ kind, fact }] }
 *
 * `status` is 'unmet' when at least one precondition is definitively violated,
 * and 'unverified' when nothing is violated but at least one fact is unknown.
 * An unverified capability is NOT refused.
 */
const evaluateCapabilityPreconditions = (name, facts = {}) => {
  const declared = preconditionsFor(name);
  if (!declared.length) {
    return Object.freeze({ status: 'satisfied', unmet: Object.freeze([]), unverified: Object.freeze([]) });
  }

  const unmet = [];
  const unverified = [];

  for (const precondition of declared) {
    const factName = PRECONDITION_FACT[precondition.kind];
    const fact = facts ? facts[factName] : undefined;

    if (fact === undefined || fact === null) {
      unverified.push(Object.freeze({ kind: precondition.kind, fact: factName }));
      continue;
    }

    if (precondition.kind === KIND_AUTHENTICATED_ACTOR) {
      if (fact !== true) {
        unmet.push(Object.freeze({
          kind: precondition.kind,
          fact: factName,
          reason: 'requires_authenticated_actor',
        }));
      }
      continue;
    }

    if (precondition.kind === KIND_CREDIT_BALANCE) {
      const required = Number(precondition.minCredits || 0);
      if (!(Number(fact) >= required)) {
        unmet.push(Object.freeze({
          kind: precondition.kind,
          fact: factName,
          reason: 'insufficient_credit_balance',
          required,
        }));
      }
    }
  }

  const status = unmet.length ? 'unmet' : (unverified.length ? 'unverified' : 'satisfied');
  return Object.freeze({ status, unmet: Object.freeze(unmet), unverified: Object.freeze(unverified) });
};

/**
 * Project the precondition status onto a capability descriptor. Pure: the
 * returned object is a copy, and `preconditions` is the declared list.
 */
const withPreconditionStatus = (capability, facts = {}) => {
  if (!capability || typeof capability !== 'object') return capability;
  const declared = preconditionsFor(capability.name);
  const status = evaluateCapabilityPreconditions(capability.name, facts);
  return {
    ...capability,
    preconditions: declared.length ? declared.map((p) => ({ ...p })) : [],
    preconditionStatus: status,
  };
};

module.exports = {
  CAPABILITY_PRECONDITIONS,
  FACT_AUTHENTICATED_ACTOR,
  FACT_CREDIT_BALANCE,
  KIND_AUTHENTICATED_ACTOR,
  KIND_CREDIT_BALANCE,
  PRECONDITION_FACT,
  preconditionsFor,
  evaluateCapabilityPreconditions,
  withPreconditionStatus,
};
