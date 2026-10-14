'use strict';

// ARC Brain — the runtime.
//
//   UNDERSTAND -> DECIDE -> PLAN -> ACT -> OBSERVE -> VERIFY -> REPLAN -> ANSWER
//
// This is the first-class subsystem that replaces the brittle intent switch.
// It owns the DECISION (what does the user want), the PLAN (which capabilities,
// bounded), the VERIFICATION (did the result actually answer the goal), and the
// REPLAN (bounded recovery when it did not).
//
// IT DOES NOT EXECUTE.
// The Brain is handed an `execute` function by its host. That function is
// always the governed substrate (TaskExecutor.executeTool). The Brain has no
// access to any tool module and never requires one. If a host passes an
// executor, every action still passes authorization, approval, idempotency and
// credits. The Brain can only ever decide WHAT to run, never WHETHER it runs.
//
// BOUNDED BY CONSTRUCTION
// research.js exposes a query ladder of at most MAX_QUERY_VARIANTS rungs and
// the loop below caps total attempts. There is no unbounded autonomous tool
// loop: the worst case is a bounded number of attempts followed by an explicit,
// truthful termination.

const crypto = require('crypto');

const {
  normalizeInterpretation, emptyInterpretation,
  TASK_CONVERSATION, TASK_CLARIFICATION, TASK_CURRENT_NEWS,
  RESEARCH_NONE, RESEARCH_CURRENT_NEWS, RESEARCH_TARGETED,
  RELATION_CORRECTION, RELATION_NEW_TASK,
  cleanText, hasExplicitNewsDemand, hasPopularityCue,
} = require('./interpretation');

const { getConversationState, BrainConversationState } = require('./conversationState');
const { planCapabilities, planRoles, needsResearchLoop, researchModeFor } = require('./capabilityPlanner');
const {
  buildQueryLadder, evaluateObservation, MAX_RESEARCH_STEPS, MAX_QUERY_VARIANTS,
  RELEVANCE_USELESS, RELEVANCE_WEAK, THRESHOLDS,
} = require('./research');
const {
  createDeterministicReasoner, guardReasoner,
  buildDecisionSystemPrompt, buildDecisionUserPrompt, INTERPRETATION_CONTRACT,
} = require('./reasoner');

const newTurnId = () => `brain_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;

// Outcomes the host can act on. These are DECISIONS, not prose: the host owns
// how to speak, and the synthesis path owns whether to answer at all.
const OUTCOME_ANSWER_FROM_MODEL = 'answer_from_model';
const OUTCOME_ANSWER_FROM_OBSERVATION = 'answer_from_observation';
const OUTCOME_CLARIFY = 'clarify';
const OUTCOME_EXECUTE_ACTION = 'execute_action';
const OUTCOME_TRUTHFUL_FAILURE = 'truthful_failure';
const OUTCOME_DEGRADED = 'degraded';
// A cancelled turn is neither an answer nor a failure of the capability. It is
// its own outcome so a truthfulness audit can tell "we could not find it" apart
// from "the user went away mid-loop".
const OUTCOME_CANCELLED = 'cancelled';

class BrainRuntime {
  /**
   * @param {object} [options]
   * @param {object} [options.reasoner] provider-independent interpreter
   * @param {object} [options.conversationState] per-actor conversational memory
   * @param {number} [options.maxResearchSteps] hard loop bound
   * @param {object} [options.logger] safe structured logger
   */
  constructor(options = {}) {
    const inner = options.reasoner || createDeterministicReasoner();
    // Every reasoner is wrapped: a provider that throws, returns prose, or
    // invents fields must never break a turn or reach a capability.
    this.reasoner = guardReasoner(inner);
    this.conversationState = options.conversationState || getConversationState();
    this.maxResearchSteps = Number.isFinite(options.maxResearchSteps)
      ? Math.max(0, Math.min(options.maxResearchSteps, MAX_RESEARCH_STEPS))
      : MAX_RESEARCH_STEPS;
    this.logger = options.logger || console;
  }

  /**
   * Swap in a different reasoner AFTER construction (e.g. a provider-backed one
   * injected by the host). The guard is re-applied, so an injected reasoner
   * gets exactly the same protection as the built-in one -- assigning
   * `reasoner` directly would silently drop the guard.
   */
  setReasoner(reasoner) {
    if (reasoner && typeof reasoner.interpret === 'function') {
      this.reasoner = guardReasoner(reasoner);
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // Stage 1: UNDERSTAND
  //
  // Relate the turn to the previous one FIRST, so a correction is recognized
  // before any prior scope can influence the interpretation.
  // -------------------------------------------------------------------------
  async understand({ userText, actorKey, hasCapabilities, options = {} } = {}) {
    const brainTurnId = newTurnId();
    const text = String(userText || '').trim();
    const prior = this.conversationState.get(actorKey);

    const relation = this.conversationState.relate(text, { actorKey });
    const priorScopeDiscarded = relation.discardActiveScope;
    // Only a follow-up may inherit a subject. A new task or a correction
    // starts from the user's own words alone. This is the contamination fix.
    const subjectForPrompt =
      relation.relation === 'refinement' || relation.relation === 'continuation'
        ? relation.inheritedTopic || null
        : null;

    let raw;
    try {
      raw = await this.reasoner.interpret({
        userText: text,
        relation: relation.relation,
        priorTopic: subjectForPrompt,
        priorTaskType: subjectForPrompt ? prior.taskType : null,
        pendingClarification: prior.pendingClarification,
        contract: INTERPRETATION_CONTRACT,
        options,
      });
    } catch (error) {
      raw = { ok: false, candidate: null, problems: [`interpret_threw:${String(error?.message || error).slice(0, 60)}`] };
    }

    let interpretation = raw && raw.candidate ? raw.candidate : null;
    let problems = Array.isArray(raw?.problems) ? raw.problems.slice() : [];

    // A failed or untrusted reasoner must never yield an executable plan. Fall
    // back to the safe default: understand, do not act, do not research.
    if (!interpretation) {
      interpretation = emptyInterpretation(text);
      interpretation.confidence = 0;
      interpretation.ambiguity = 1;
      interpretation.requiresClarification = true;
      problems.push('reasoner_unavailable_using_safe_default');
    }

    // A correction MUST be re-derived from the user's own words. The subject is
    // kept only if it is actually EVIDENCED in this message; a reasoner that
    // simply echoes the previous topic is cleared, because that is the trapped
    // state. A user who restates the same subject ("i just asked about paperclip
    // project") is evidence of that subject and keeps it.
    if (relation.relation === RELATION_CORRECTION && interpretation.topic && !subjectAppearsInText(interpretation.topic, text)) {
      interpretation.topic = null;
      problems.push('correction_subject_not_evidenced_in_message');
    }

    // A bare scope qualifier ("in India", "what about the US?") asks for nothing
    // new, so it must not re-decide the task. Without this the task type decays
    // turn by turn — "in India" reads as a fresh question, the next qualifier
    // sees a non-news prior, and a scoping conversation falls apart. The news
    // task may only be inherited from a turn the guard rails actually granted.
    if (
      relation.reason === 'bare_scope_qualifier' &&
      relation.priorNewsGranted &&
      interpretation.taskType !== RELATION_CORRECTION
    ) {
      interpretation.taskType = TASK_CURRENT_NEWS;
      interpretation.preferredResearchMode = RESEARCH_CURRENT_NEWS;
      interpretation.externalKnowledgeNeeded = true;
      interpretation.conversationRelation = relation.relation;
      problems.push('news_task_inherited_from_granted_turn');
    }

    // Merge an inherited subject only for genuine follow-ups.
    if (!interpretation.topic && subjectForPrompt) {
      interpretation.topic = subjectForPrompt;
      problems.push('topic_inherited_from_follow_up');
    }

    // Record the resolved relation on the interpretation so downstream code and
    // observability agree on it.
    if (relation.relation === RELATION_CORRECTION) interpretation.conversationRelation = RELATION_CORRECTION;
    else if (priorScopeDiscarded && interpretation.conversationRelation === 'continuation') {
      // A new subject must not be reported as a continuation.
      interpretation.conversationRelation = RELATION_NEW_TASK;
    }

    return {
      brainTurnId,
      relation,
      prior,
      interpretation,
      problems,
      userText: text,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2: DECIDE + PLAN
  //
  // Pure: interpretation + live capabilities -> a small, relevant plan.
  // -------------------------------------------------------------------------
  plan({ brainTurnId, interpretation, capabilities = [], options = {} } = {}) {
    const planned = planCapabilities(interpretation, capabilities, {
      maxCapabilities: options.maxCapabilities,
    });
    const loop = needsResearchLoop(interpretation);
    const mode = researchModeFor(interpretation);

    // A clarification turn plans nothing.
    if (interpretation.taskType === TASK_CLARIFICATION) {
      return {
        brainTurnId,
        roles: [],
        capabilities: [],
        mode: RESEARCH_NONE,
        researchLoop: false,
        reasons: ['clarification_requested'],
      };
    }

    // A conversation turn plans nothing. "hello" must never launch a lookup.
    if (interpretation.taskType === TASK_CONVERSATION) {
      return {
        brainTurnId,
        roles: [],
        capabilities: [],
        mode: RESEARCH_NONE,
        researchLoop: false,
        reasons: ['conversation_turn'],
      };
    }

    return {
      brainTurnId,
      roles: planned.roles,
      capabilities: planned.capabilities,
      dropped: planned.dropped,
      // Capabilities the execution context already rules out. Surfaced so a
      // skipped dispatch is reportable rather than invisible, and so a
      // precondition refusal never silently costs a research step.
      refused: planned.refused,
      mode,
      researchLoop: loop && planned.capabilities.length > 0,
      reasons: [
        `taskType=${interpretation.taskType}`,
        `freshness=${interpretation.freshnessRequirement}`,
        `mode=${mode}`,
        loop ? 'research_loop' : 'no_research_loop',
        ...(planned.refused || []).map((r) => `refused:${r.capability}:${r.reason}`),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Stage 3: RESEARCH LOOP (plan -> act -> observe -> verify -> replan)
  //
  // `execute` is the HOST's governed executor. The Brain calls it; it never
  // bypasses it. Each attempt is one ladder rung; the loop stops as soon as the
  // observation is good enough to answer from.
  // -------------------------------------------------------------------------
  async research({ brainTurnId, interpretation, plan, execute, context = {}, assess, options = {} } = {}) {
    const topic = interpretation.topic || interpretation.goal || '';
    const mode = plan.mode;
    const ladder = buildQueryLadder({
      topic,
      goal: interpretation.goal,
      userText: interpretation.evidence.userText,
      mode,
    });

    // A strategy is a (capability, args) pair, not a query string. Building the
    // pair up front is what makes recovery honest: several capabilities take
    // only a topic, so three different rungs can collapse into three identical
    // calls. Re-running the same call is not a replan, it is a loop, so any
    // strategy whose arguments duplicate an earlier one is dropped and the
    // budget goes to a different capability instead.
    const strategies = buildStrategies({ ladder, plan, mode, topic, interpretation });
    const ladderLimit = Math.min(strategies.length, this.maxResearchSteps, MAX_QUERY_VARIANTS);
    const attempts = [];
    let observation = null;
    let finalPlan = null;
    let aborted = false;
    const signal = context?.signal || options?.signal || null;

    for (let i = 0; i < ladderLimit; i += 1) {
      const { capability: capabilityName, args, query } = strategies[i];
      if (!capabilityName) continue;

      // A cancelled turn stops between rungs. The loop is bounded by the rung
      // budget AND by the caller's signal, so a research turn can never outlive
      // the request that authorised it.
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      let result = null;
      let threw = null;
      try {
        // The whole execution context is forwarded to the host executor. The
        // Brain never reads a userId or a socket -- it only carries them, so a
        // host cannot accidentally drop the identity the governed path needs.
        result = await execute({
          capability: capabilityName,
          args,
          reason: `research_step_${i + 1}`,
          context,
          signal,
          brainTurnId,
        });
      } catch (error) {
        // A host executor that throws is treated as a failed capability, never
        // as a Brain crash.
        threw = String(error?.message || error).slice(0, 160);
        result = { success: false, error: threw };
      }

      const succeeded = Boolean(result && result.success);
      const assessed =
        typeof assess === 'function' && succeeded
          ? (await safeAssess(assess, { result, query, goal: interpretation.goal })) ?? undefined
          : undefined;

      observation = evaluateObservation({
        result,
        query,
        goal: interpretation.goal,
        // The user's own words, so the evaluator can read the expected entity
        // TYPE from them ("...open-source technology project"). The abstract
        // goal ("understand paperclip") carries no type signal, so without this
        // a wrong-entity result cannot be caught.
        userText: interpretation.evidence?.userText,
        subject: interpretation.topic,
        succeeded,
        assessedRelevance: assessed,
      });

      attempts.push({
        step: i + 1,
        query,
        // The arguments actually dispatched. Recorded (bounded) so a replan can
        // be proven to be a DIFFERENT strategy and not just the same call twice.
        args: args && typeof args === 'object' ? { ...args } : args ?? null,
        capability: capabilityName,
        executed: true,
        succeeded,
        relevance: observation.relevance,
        score: observation.score,
        nextAction: observation.nextAction,
        // The real observed text, bounded. The host needs this to synthesize an
        // answer from what actually came back -- a host must never be left
        // guessing at the payload of a capability it already ran.
        observationText: succeeded
          ? (observation.texts || []).join('\n').slice(0, 4000)
          : null,
        failure: succeeded ? null : (result?.error || threw || 'capability_reported_failure'),
      });

      this._record({
        brainTurnId,
        event: 'brain.research.attempt',
        step: i + 1,
        capability: capabilityName,
        succeeded,
        relevance: observation.relevance,
        score: observation.score,
        nextAction: observation.nextAction,
      });

      if (observation.nextAction === 'synthesize') {
        finalPlan = { capability: capabilityName, args, query, step: i + 1 };
        break;
      }
      // A failed or rejected rung falls through to the next strategy. An
      // exhausted budget is a truthful failure, never a fabricated answer.
    }

    const usedSteps = attempts.length;
    const exhausted = usedSteps >= ladderLimit || attempts.length === 0;
    const answerable = Boolean(finalPlan) || (attempts.length > 0 && observation && observation.relevant);

    return {
      brainTurnId,
      mode,
      attempts,
      replanCount: Math.max(0, usedSteps - 1),
      observation,
      finalPlan,
      exhausted,
      aborted,
      answerable,
      ladder,
    };
  }

  // -------------------------------------------------------------------------
  // The full turn: understand -> plan -> (research) -> outcome.
  // -------------------------------------------------------------------------
  async think({ userText, actorKey, capabilities = [], execute, context = {}, assess, options = {} } = {}) {
    const { brainTurnId, relation, prior, interpretation, problems } = await this.understand({
      userText,
      actorKey,
      hasCapabilities: capabilities.length > 0,
      options,
    });

    const plan = this.plan({ brainTurnId, interpretation, capabilities, options });
    const conversationRelation = interpretation.conversationRelation;
    const wantsClarification =
      interpretation.requiresClarification || interpretation.taskType === TASK_CLARIFICATION;

    // --- terminations that need no research -------------------------------
    if (wantsClarification) {
      this._commit({ actorKey, interpretation, relation, outcome: OUTCOME_CLARIFY, capabilities: [] });
      this._record({
        brainTurnId,
        event: 'brain.turn',
        taskType: interpretation.taskType,
        relation: conversationRelation,
        capability: null,
        researchMode: RESEARCH_NONE,
        confidence: interpretation.confidence,
        replanCount: 0,
        resultRelevance: null,
        outcome: OUTCOME_CLARIFY,
        problems,
      });
      return { brainTurnId, interpretation, plan, outcome: OUTCOME_CLARIFY, needsClarification: true };
    }

    if (!plan.researchLoop) {
      // Either a conversation turn, a knowledge answer the model can give, or
      // an action request. An action still needs the governed host to run it.
      const outcome =
        interpretation.taskType === 'action_request' ? OUTCOME_EXECUTE_ACTION : OUTCOME_ANSWER_FROM_MODEL;
      this._commit({
        actorKey,
        interpretation,
        relation,
        outcome,
        capabilities: plan.capabilities.map((c) => c.names[0]).filter(Boolean),
      });
      this._record({
        brainTurnId,
        event: 'brain.turn',
        taskType: interpretation.taskType,
        relation: conversationRelation,
        capability: plan.capabilities[0]?.names?.[0] || null,
        researchMode: RESEARCH_NONE,
        confidence: interpretation.confidence,
        replanCount: 0,
        resultRelevance: null,
        outcome,
        problems,
      });
      return { brainTurnId, interpretation, plan, outcome, needsClarification: false };
    }

    // --- research path -----------------------------------------------------
    const research = await this.research({
      brainTurnId,
      interpretation,
      plan,
      execute,
      context,
      assess,
    });

    let outcome;
    if (research.aborted) outcome = OUTCOME_CANCELLED;
    else if (research.answerable) outcome = OUTCOME_ANSWER_FROM_OBSERVATION;
    else if (research.attempts.length === 0) outcome = OUTCOME_DEGRADED;
    else outcome = OUTCOME_TRUTHFUL_FAILURE;

    this._commit({
      actorKey,
      interpretation,
      relation,
      outcome,
      capabilities: plan.capabilities.map((c) => c.names[0]).filter(Boolean),
    });

    this._record({
      brainTurnId,
      event: 'brain.turn',
      taskType: interpretation.taskType,
      relation: conversationRelation,
      capability: research.finalPlan?.capability || pickCapabilityForMode(plan, plan.mode),
      researchMode: research.mode,
      confidence: interpretation.confidence,
      replanCount: research.replanCount,
      resultRelevance: research.observation?.relevance || null,
      resultScore: research.observation?.score ?? null,
      outcome,
      attempts: research.attempts.length,
      problems,
    });

    return {
      brainTurnId,
      interpretation,
      plan,
      research,
      outcome,
      needsClarification: false,
    };
  }

  // -------------------------------------------------------------------------

  _commit({ actorKey, interpretation, relation, outcome, capabilities }) {
    try {
      this.conversationState.commit(actorKey, interpretation, {
        relation: relation.relation,
        outcome,
        capabilities,
      });
    } catch (error) {
      // Losing conversational memory must never fail a turn.
      this._record({ event: 'brain.state.commit_failed', reason: String(error?.message || error).slice(0, 80) });
    }
  }

  /**
   * Safe structured observability. DECISIONS and OUTCOMES only.
   * No chain-of-thought, no user text, no tool arguments, no credentials.
   */
  _record(fields) {
    try {
      const payload = { at: Date.now() };
      for (const [k, v] of Object.entries(fields || {})) {
        if (k === 'problems' && Array.isArray(v)) payload.problems = v.slice(0, 6);
        else if (typeof v === 'string') payload[k] = v.slice(0, 120);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) payload[k] = v;
      }
      this.logger.log?.('[Brain]', JSON.stringify(payload));
    } catch {
      // Observability must never throw.
    }
  }
}

// ---- helpers ---------------------------------------------------------------

/** Every planned capability, best-fit first, as a flat ordered list. */
const orderedCapabilitiesForMode = (plan, mode) => {
  const caps = (plan && plan.capabilities) || [];
  if (!caps.length) return [];
  const rank = (c) => {
    const role = c.role;
    if (mode === RESEARCH_CURRENT_NEWS && role === 'news_headlines') return 0;
    if (mode === RESEARCH_TARGETED && role === 'deep_research') return 0;
    if (role === 'web_lookup') return 1;
    if (role === 'deep_research') return 2;
    if (role === 'news_headlines') return 3;
    return 4;
  };
  return caps
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((c) => (c.names || []).slice(0, 1).map((n) => ({ capability: n, role: c.role })));
};

/**
 * Expand the query ladder x the planned capabilities into a de-duplicated,
 * bounded list of executable strategies.
 */
const buildStrategies = ({ ladder, plan, mode, topic, interpretation }) => {
  const caps = orderedCapabilitiesForMode(plan, mode);
  if (!caps.length) return [];
  const out = [];
  const seen = new Set();
  // Rung-major: try the best query against every capability before degrading
  // the query, so a capability mismatch is fixed before the wording is.
  for (const query of ladder) {
    for (const { capability } of caps) {
      const args = buildArgsForMode(capability, mode, { query, topic, interpretation });
      let sig;
      try {
        sig = `${capability}:${JSON.stringify(args)}`;
      } catch {
        sig = `${capability}:unserializable`;
      }
      if (seen.has(sig)) continue; // identical call: not a replan
      seen.add(sig);
      out.push({ capability, args, query });
    }
  }
  return out;
};

/** Which planned capability serves a research mode. */
const pickCapabilityForMode = (plan, mode) => {
  const ordered = orderedCapabilitiesForMode(plan, mode);
  return ordered.length ? ordered[0].capability : null;
};

/** Build governed tool arguments for a research step. */
const buildArgsForMode = (capability, mode, { query, topic, interpretation }) => {
  const cleanQuery = cleanText(query, 300);
  if (capability === 'getTopNews') {
    return {
      topic: cleanText(topic || query, 120),
      limit: 5,
    };
  }
  if (capability === 'deepResearchSwarm') {
    return { topic: cleanText(topic || query, 160) };
  }
  if (capability === 'scrapeWebsite') {
    return { url: cleanQuery };
  }
  if (capability === 'webSearch') {
    return { query: cleanQuery };
  }
  return { query: cleanQuery, topic: cleanText(topic, 120) };
};

const safeAssess = async (assess, args) => {
  try {
    const v = await assess(args);
    return Number.isFinite(Number(v)) ? Number(v) : typeof v === 'object' && v && Number.isFinite(Number(v.relevance)) ? Number(v.relevance) : null;
  } catch {
    return null;
  }
};

/** Is a subject actually named in the user's message? Token overlap, not equality. */
const subjectAppearsInText = (subject, text) => {
  const hay = String(text || '').toLowerCase();
  const tokens = String(subject || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  return tokens.some((t) => hay.includes(t));
};

let singleton = null;
const getBrainRuntime = (options) => {
  if (!singleton) singleton = new BrainRuntime(options);
  return singleton;
};

module.exports = {
  BrainRuntime,
  getBrainRuntime,
  newTurnId,
  OUTCOME_ANSWER_FROM_MODEL,
  OUTCOME_ANSWER_FROM_OBSERVATION,
  OUTCOME_CLARIFY,
  OUTCOME_EXECUTE_ACTION,
  OUTCOME_TRUTHFUL_FAILURE,
  OUTCOME_DEGRADED,
  pickCapabilityForMode,
  buildArgsForMode,
  // re-exports for the host seam
  BrainConversationState,
  hasExplicitNewsDemand,
  hasPopularityCue,
  TASK_CURRENT_NEWS,
  THRESHOLDS,
  RELEVANCE_USELESS,
  RELEVANCE_WEAK,
};
