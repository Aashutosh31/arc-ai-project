'use strict';

// ARC Brain — public facade.
//
// Everything outside server/lib/brain should import from HERE, never from the
// internal modules, mirroring server/lib/capabilities/index.js.
//
// The Brain is a decision, planning and verification layer. It sits between the
// user's message and the governed execution substrate:
//
//   USER -> BrainRuntime.think() -> { outcome, plan, research }
//        -> host dispatches through TaskExecutor.executeTool (governed)
//        -> results flow back into the Brain for observation
//
// The Brain CANNOT execute. It is handed an executor by its host and has no
// access to any tool module. That is the whole point: planning is separated
// from the authorization/approval/idempotency boundary, and nothing the Brain
// decides can widen what is allowed to run.

const interpretation = require('./interpretation');
const reasonerLlm = require('./reasonerLlm');
const conversationState = require('./conversationState');
const capabilityPlanner = require('./capabilityPlanner');
const research = require('./research');
const reasoner = require('./reasoner');
const brainRuntime = require('./brainRuntime');

module.exports = {
  // The orchestrator.
  BrainRuntime: brainRuntime.BrainRuntime,
  getBrainRuntime: brainRuntime.getBrainRuntime,
  newTurnId: brainRuntime.newTurnId,

  // Outcomes the host acts on (decisions, never prose).
  OUTCOME_ANSWER_FROM_MODEL: brainRuntime.OUTCOME_ANSWER_FROM_MODEL,
  OUTCOME_ANSWER_FROM_OBSERVATION: brainRuntime.OUTCOME_ANSWER_FROM_OBSERVATION,
  OUTCOME_CLARIFY: brainRuntime.OUTCOME_CLARIFY,
  OUTCOME_EXECUTE_ACTION: brainRuntime.OUTCOME_EXECUTE_ACTION,
  OUTCOME_TRUTHFUL_FAILURE: brainRuntime.OUTCOME_TRUTHFUL_FAILURE,
  OUTCOME_DEGRADED: brainRuntime.OUTCOME_DEGRADED,

  // The structured interpretation contract + its trust boundary.
  ...interpretation,

  // Conversational working memory (context, never command).
  BrainConversationState: conversationState.BrainConversationState,
  getConversationState: conversationState.getConversationState,
  isCorrection: conversationState.isCorrection,
  isFollowUp: conversationState.isFollowUp,
  carriesNewRequest: conversationState.carriesNewRequest,
  hasConcreteSubject: conversationState.hasConcreteSubject,

  // Semantic capability planning.
  planRoles: capabilityPlanner.planRoles,
  planCapabilities: capabilityPlanner.planCapabilities,
  needsResearchLoop: capabilityPlanner.needsResearchLoop,
  researchModeFor: capabilityPlanner.researchModeFor,
  ROLE_BINDINGS: capabilityPlanner.ROLE_BINDINGS,

  // Research loop: query ladder, observation evaluation, bounds.
  buildQueryLadder: research.buildQueryLadder,
  evaluateObservation: research.evaluateObservation,
  lexicalRelevance: research.lexicalRelevance,
  extractObservationText: research.extractObservationText,
  MAX_RESEARCH_STEPS: research.MAX_RESEARCH_STEPS,
  RELEVANCE_USELESS: research.RELEVANCE_USELESS,
  RELEVANCE_WEAK: research.RELEVANCE_WEAK,
  RELEVANCE_PARTIAL: research.RELEVANCE_PARTIAL,
  RELEVANCE_RELEVANT: research.RELEVANCE_RELEVANT,

  // Provider-independent reasoning seam.
  INTERPRETATION_CONTRACT: reasoner.INTERPRETATION_CONTRACT,
  buildDecisionSystemPrompt: reasoner.buildDecisionSystemPrompt,
  buildDecisionUserPrompt: reasoner.buildDecisionUserPrompt,
  createDeterministicReasoner: reasoner.createDeterministicReasoner,
  guardReasoner: reasoner.guardReasoner,
  // The host injects the provider CALL, not a provider. Nothing here imports a
  // vendor SDK, so the Brain stays provider-independent and offline-testable.
  createLlmReasoner: reasonerLlm.createLlmReasoner,
  createHybridReasoner: reasonerLlm.createHybridReasoner,
  extractJson: reasonerLlm.extractJson,
  MAX_DECISION_TOKENS: reasonerLlm.MAX_DECISION_TOKENS,
};
