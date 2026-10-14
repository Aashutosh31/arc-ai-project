'use strict';

// ARC Brain — capability planning.
//
// Turns a structured interpretation into a SMALL, RELEVANT capability set, so
// the reasoning model is not handed the whole registry every turn.
//
// WHY NOT JUST LET THE MODEL PICK
// The production failure was partly a selection failure: the exposed tool list
// was chosen by regex groups (server/lib/llm/toolSelection.js), and getTopNews
// was reachable for queries that had nothing to do with news. Then
// buildToolFailureText (AIService.js:734) produced a hardcoded
// "I couldn't retrieve current news right now" for that tool name, so ARC
// confidently reported a news framing it had chosen itself.
//
// So the Brain now decides the capability FAMILY first, from the
// interpretation, and only then does the model choose within that family.
//
// GOVERNANCE
// This module resolves capability NAMES from the live registry. It never
// executes anything, never requires a tool module, and cannot widen
// authorization. A name it returns is still subject to TaskExecutor's full
// envelope: authorization, approval, idempotency, credits. Planning here
// changes only WHICH capabilities are offered, never WHETHER they are allowed.

const {
  TASK_CONVERSATION, TASK_KNOWLEDGE, TASK_CURRENT_NEWS, TASK_WEB_RESEARCH,
  TASK_TOPIC_RESEARCH, TASK_CODING_HELP, TASK_ACTION_REQUEST, TASK_CLARIFICATION,
  RESEARCH_NONE, RESEARCH_CURRENT_NEWS, RESEARCH_GENERAL_WEB, RESEARCH_TARGETED,
  RESEARCH_MEMORY, RESEARCH_NATIVE_CAPABILITY, RESEARCH_MCP_CAPABILITY,
  FRESHNESS_HIGH, FRESHNESS_MODERATE,
} = require('./interpretation');

const { nativeRiskFor } = require('../capabilities/risk');

// Capability roles. A role is a semantic need ("current headlines"); a name is
// a concrete capability ("getTopNews"). The Brain plans in roles, then binds
// roles to the live registry.
const ROLE_NEWS_HEADLINES = 'news_headlines';
const ROLE_WEB_LOOKUP = 'web_lookup';
const ROLE_DEEP_RESEARCH = 'deep_research';
const ROLE_PAGE_FETCH = 'page_fetch';
const ROLE_MEMORY_RECALL = 'memory_recall';
const ROLE_LOCAL_TIME = 'local_time';
const ROLE_WEATHER = 'weather';
const ROLE_ACTION = 'action';

/**
 * Role -> candidate capability names, in preference order.
 *
 * `preferNative` first: TaskExecutor already resolves native-before-MCP by
 * name miss, but choosing the native name here avoids exposing an equivalent
 * MCP tool at all, which is what test case 17 requires.
 */
const ROLE_BINDINGS = Object.freeze({
  [ROLE_NEWS_HEADLINES]: Object.freeze(['getTopNews']),
  [ROLE_WEB_LOOKUP]: Object.freeze(['webSearch']),
  [ROLE_DEEP_RESEARCH]: Object.freeze(['deepResearchSwarm', 'webSearch']),
  [ROLE_PAGE_FETCH]: Object.freeze(['scrapeWebsite']),
  [ROLE_MEMORY_RECALL]: Object.freeze(['recallMemory']),
  [ROLE_LOCAL_TIME]: Object.freeze(['getTime']),
  [ROLE_WEATHER]: Object.freeze(['getWeather']),
  [ROLE_ACTION]: Object.freeze([]), // filled from the reasoner's candidateActions
});

/**
 * Decide which capability ROLES the interpretation calls for.
 * Pure function of the interpretation — no keywords, no registry access.
 */
const planRoles = (interpretation) => {
  const roles = [];
  if (!interpretation) return roles;
  const mode = interpretation.preferredResearchMode;

  switch (mode) {
    case RESEARCH_CURRENT_NEWS:
      roles.push(ROLE_NEWS_HEADLINES);
      break;
    case RESEARCH_GENERAL_WEB:
      roles.push(ROLE_WEB_LOOKUP);
      // A deep-research ask wants more than one lookup.
      if (
        interpretation.taskType === TASK_TOPIC_RESEARCH ||
        interpretation.freshnessRequirement === FRESHNESS_HIGH
      ) {
        roles.push(ROLE_DEEP_RESEARCH);
      }
      break;
    case RESEARCH_TARGETED:
      roles.push(ROLE_DEEP_RESEARCH, ROLE_WEB_LOOKUP);
      break;
    case RESEARCH_MEMORY:
      roles.push(ROLE_MEMORY_RECALL);
      break;
    default:
      break;
  }

  // News tasks always get the news role even if the mode was defaulted.
  if (interpretation.taskType === TASK_CURRENT_NEWS && !roles.includes(ROLE_NEWS_HEADLINES)) {
    roles.unshift(ROLE_NEWS_HEADLINES);
  }

  // Explicit capabilities the reasoner named, mapped onto roles.
  for (const action of interpretation.candidateActions || []) {
    if (action.intent && ROLE_BINDINGS[action.intent] !== undefined && !roles.includes(action.intent)) {
      roles.push(action.intent);
    }
  }

  // A user who asked to be sent/reminded/scheduled/etc. needs an action, and
  // it MUST go through the governed substrate.
  if (interpretation.taskType === TASK_ACTION_REQUEST && !roles.includes(ROLE_ACTION)) {
    roles.push(ROLE_ACTION);
  }

  return roles;
};

/**
 * Bind roles to concrete capability names using the live registry.
 *
 * A capability whose declared execution-context preconditions are known to be
 * unmet is REFUSED here, not selected. The refusal is reported in `refused`
 * (with the reason) so it is never silently swallowed, and it does not consume
 * a research step: the capability is simply absent from the plan, so the
 * research loop never dispatches it.
 *
 * An `unverified` precondition (the host did not supply the fact) is NOT a
 * refusal. Refusing on ignorance would hide capabilities that do work, and
 * TaskExecutor re-checks everything authoritatively anyway.
 *
 * @param {object[]} capabilities normalized capability array (see
 *   server/lib/capabilities/discover.js — { source, names, scope, risk, ... })
 * @param {object} interpretation
 * @param {object} [options]
 * @param {number} [options.maxCapabilities]
 * @returns {{roles: string[], capabilities: object[], dropped: string[],
 *   refused: Array<{capability: string, reason: string, preconditions: object[]}>}}
 */
const planCapabilities = (interpretation, capabilities = [], options = {}) => {
  const max = Number.isFinite(options.maxCapabilities) ? options.maxCapabilities : 4;
  const roles = planRoles(interpretation);
  const byName = new Map();
  for (const cap of capabilities || []) {
    if (!cap) continue;
    // The live registry emits a single `name`; the planner's internal shape uses
    // `names`. Accept both so the plan is built from the real inventory rather
    // than a hand-maintained list that can drift from what is actually exposed.
    const names = Array.isArray(cap.names) && cap.names.length ? cap.names : (cap.name ? [cap.name] : []);
    for (const n of names) {
      if (n) byName.set(n, { ...cap, names: [n] });
    }
  }

  const selected = [];
  const seen = new Set();
  const dropped = [];
  const refused = [];

  const add = (name, role) => {
    if (!name || seen.has(name)) return;
    const cap = byName.get(name);
    // Never propose a capability the live registry does not expose. An
    // unresolvable name would be DENIED at the boundary anyway; filtering it
    // here keeps the offered set honest.
    if (!cap) {
      dropped.push(name);
      return;
    }
    // Refuse a capability whose preconditions the execution context already
    // violates. Reporting it keeps the error visible: the plan carries why the
    // capability was not attempted.
    const status = cap.preconditionStatus;
    if (status && status.status === 'unmet') {
      seen.add(name);
      refused.push({
        capability: name,
        role,
        reason: (status.unmet && status.unmet[0] && status.unmet[0].reason) || 'precondition_unmet',
        preconditions: (status.unmet || []).map((p) => ({ ...p })),
      });
      return;
    }
    seen.add(name);
    selected.push({ ...cap, role, native: cap.source === 'native' });
  };

  for (const role of roles) {
    if (role === ROLE_ACTION) {
      // Action roles come from the reasoner, not from a fixed table: the model
      // named a capability, and governance decides whether it may run.
      for (const action of interpretation.candidateActions || []) {
        if (action.capability) add(action.capability, ROLE_ACTION);
      }
      continue;
    }
    for (const name of ROLE_BINDINGS[role] || []) add(name, role);
  }

  // A user-named capability is never dropped just because no role matched.
  for (const action of interpretation.candidateActions || []) {
    if (action.capability) add(action.capability, action.intent || ROLE_ACTION);
  }

  return {
    roles,
    capabilities: selected.slice(0, max),
    dropped: dropped.slice(0, 8),
    refused: refused.slice(0, 8),
  };
};

/**
 * True when the interpretation needs a retrieval loop at all.
 * "hello" and "what is recursion" must not launch one.
 */
const needsResearchLoop = (interpretation) => {
  if (!interpretation) return false;
  if (!interpretation.externalKnowledgeNeeded) return false;
  const mode = interpretation.preferredResearchMode;
  return (
    mode === RESEARCH_CURRENT_NEWS ||
    mode === RESEARCH_GENERAL_WEB ||
    mode === RESEARCH_TARGETED
  );
};

/** Research mode for a replan step, given the primary interpretation. */
const researchModeFor = (interpretation) => {
  if (!needsResearchLoop(interpretation)) return RESEARCH_NONE;
  if (interpretation.preferredResearchMode === RESEARCH_CURRENT_NEWS) return RESEARCH_CURRENT_NEWS;
  if (interpretation.preferredResearchMode === RESEARCH_TARGETED) return RESEARCH_TARGETED;
  if (
    interpretation.freshnessRequirement === FRESHNESS_MODERATE ||
    interpretation.freshnessRequirement === FRESHNESS_HIGH
  ) {
    return RESEARCH_TARGETED;
  }
  return RESEARCH_GENERAL_WEB;
};

/**
 * Informational capabilities are `read` scope. Used by the observation
 * evaluator to decide whether a non-answer is a research problem (retry with a
 * better strategy) or an execution problem (surface it). Not a security gate —
 * authorization remains the only gate.
 */
const isInformational = (name) => {
  const meta = nativeRiskFor(name);
  return Boolean(meta && meta.scope === 'read');
};

module.exports = {
  ROLE_NEWS_HEADLINES,
  ROLE_WEB_LOOKUP,
  ROLE_DEEP_RESEARCH,
  ROLE_PAGE_FETCH,
  ROLE_MEMORY_RECALL,
  ROLE_LOCAL_TIME,
  ROLE_WEATHER,
  ROLE_ACTION,
  ROLE_BINDINGS,
  planRoles,
  planCapabilities,
  needsResearchLoop,
  researchModeFor,
  isInformational,
  // Re-exported so callers can branch on task types without a second import.
  TASK_CONVERSATION,
  TASK_KNOWLEDGE,
  TASK_CURRENT_NEWS,
  TASK_WEB_RESEARCH,
  TASK_TOPIC_RESEARCH,
  TASK_CODING_HELP,
  TASK_ACTION_REQUEST,
  TASK_CLARIFICATION,
};
