'use strict';

// ARC Brain — the structured interpretation contract.
//
// WHY THIS EXISTS
// The previous architecture collapsed "what does the user want" into a single
// enum chosen by regex (parseNewsIntent in AIService.js). That enum was the
// only thing standing between a user sentence and a capability call, which is
// why "paperclip which is getting viral nowadays in tech" could become a
// GDELT news request. A single enum cannot express the difference between
// "tell me about Paperclip" and "what's the latest news about Paperclip",
// because the difference is not a label, it is a bundle of independent
// attributes (goal, topic, freshness, required external knowledge, relation to
// the previous turn).
//
// So the Brain's internal representation is a STRUCTURED interpretation, not
// an intent enum. taskType is one field among many, and several fields combine
// to decide capability selection.
//
// This module owns:
//   1. the contract (field names, allowed values, defaults)
//   2. strict validation/coercion of an untrusted model response
//   3. MONOTONIC GUARD RAILS that can only make the interpretation MORE
//      conservative, never less
//
// Provider independence: nothing here knows about Groq, Gemini, or any HTTP
// client. A reasoner produces a candidate object; this module decides whether
// that object is safe to act on.

// ---- task types ------------------------------------------------------------
// Deliberately a taxonomy of USER GOALS, not of tools. A tool is chosen later,
// from the interpretation, by the capability planner.
const TASK_CONVERSATION = 'conversation';
const TASK_KNOWLEDGE = 'knowledge';
const TASK_CURRENT_NEWS = 'current_news';
const TASK_WEB_RESEARCH = 'web_research';
const TASK_TOPIC_RESEARCH = 'topic_research';
const TASK_CODING_HELP = 'coding_help';
const TASK_ACTION_REQUEST = 'action_request';
const TASK_CLARIFICATION = 'clarification';
const TASK_OTHER = 'other';

const TASK_TYPES = Object.freeze([
  TASK_CONVERSATION,
  TASK_KNOWLEDGE,
  TASK_CURRENT_NEWS,
  TASK_WEB_RESEARCH,
  TASK_TOPIC_RESEARCH,
  TASK_CODING_HELP,
  TASK_ACTION_REQUEST,
  TASK_CLARIFICATION,
  TASK_OTHER,
]);

// Task types that are inherently about retrieving external information. Used
// by the research planner to decide whether an observation can be evaluated for
// relevance at all (there is nothing to evaluate for a greeting).
const RETRIEVAL_TASK_TYPES = Object.freeze([
  TASK_CURRENT_NEWS,
  TASK_WEB_RESEARCH,
  TASK_TOPIC_RESEARCH,
]);

// ---- temporal / freshness --------------------------------------------------
// `temporalRequirement` describes what the USER SAID about time.
// `freshnessRequirement` describes how current the answer must be. They are
// separate because "the Paperclip project that is popular right now" states a
// temporal cue but still wants a topic explanation, not a news briefing.
const TEMPORAL_NONE = 'none';
const TEMPORAL_RECENT_CONTEXT = 'recent_context';
const TEMPORAL_LATEST = 'latest';
const TEMPORAL_EXPLICIT = 'explicit';

const TEMPORAL_REQUIREMENTS = Object.freeze([
  TEMPORAL_NONE,
  TEMPORAL_RECENT_CONTEXT,
  TEMPORAL_LATEST,
  TEMPORAL_EXPLICIT,
]);

const FRESHNESS_NONE = 'none';
const FRESHNESS_LOW = 'low';
const FRESHNESS_MODERATE = 'moderate';
const FRESHNESS_HIGH = 'high';

const FRESHNESS_REQUIREMENTS = Object.freeze([
  FRESHNESS_NONE,
  FRESHNESS_LOW,
  FRESHNESS_MODERATE,
  FRESHNESS_HIGH,
]);

// ---- research mode ---------------------------------------------------------
// This is the single most consequential field in the contract: it decides
// WHICH KIND of retrieval runs, and therefore which capability family is even
// considered. "current_news" must never be inferred from popularity cues.
const RESEARCH_NONE = 'none';
const RESEARCH_CURRENT_NEWS = 'current_news';
const RESEARCH_GENERAL_WEB = 'general_web';
const RESEARCH_TARGETED = 'targeted_research';
const RESEARCH_MEMORY = 'memory';
const RESEARCH_NATIVE_CAPABILITY = 'native_capability';
const RESEARCH_MCP_CAPABILITY = 'mcp_capability';

const RESEARCH_MODES = Object.freeze([
  RESEARCH_NONE,
  RESEARCH_CURRENT_NEWS,
  RESEARCH_GENERAL_WEB,
  RESEARCH_TARGETED,
  RESEARCH_MEMORY,
  RESEARCH_NATIVE_CAPABILITY,
  RESEARCH_MCP_CAPABILITY,
]);

// ---- relation to the previous turn ----------------------------------------
// The distinction that fixes the reported contamination bug. A previous news
// turn is CONTEXT. It may refine a genuinely continuous request; it may never
// CREATE a news task out of a message that does not ask for news.
const RELATION_NEW_TASK = 'new_task';
const RELATION_CONTINUATION = 'continuation';
const RELATION_REFINEMENT = 'refinement';
const RELATION_CORRECTION = 'correction';

const CONVERSATION_RELATIONS = Object.freeze([
  RELATION_NEW_TASK,
  RELATION_CONTINUATION,
  RELATION_REFINEMENT,
  RELATION_CORRECTION,
]);

// ---------------------------------------------------------------------------
// Guard rail: explicit news demand.
//
// This is deliberately NOT the primary classifier — the reasoner is. It is a
// narrow, monotonic safety rail that can only DOWNGRADE current_news to
// topic_research, never the reverse. It exists because the exact production
// failure was a model (or a regex) choosing news for a message that never asked
// for news, and no prompt-only fix is a guarantee.
//
// The rail recognises only unambiguous, first-person demand for news or
// headlines. It deliberately does NOT include: viral, trending, popular,
// hot, blowing up, talked about, recent, nowadays, currently, latest, today.
// Those are popularity/freshness cues, not news demands — treating them as
// news demand is precisely the bug being fixed.
//
// A topical "news about X" also counts: "news" is the noun the user chose.
// Requiring a region/topic-free phrase like "what happened today" is NOT
// treated as news here, because that phrasing is genuinely ambiguous with
// "what happened to this project" and is left to the reasoner.
const EXPLICIT_NEWS_RE =
  /\b(news|newsfeed|headlines?|news\s+briefing|news\s+roundup|press)\b/i;

// Popularity / buzz cues. Recorded as EVIDENCE for the reasoner and for
// observability, and used to justify a freshness bump, but never sufficient on
// their own to select current_news.
const POPULARITY_CUE_RE =
  /\b(viral|trending|popular|buzzing|blow(?:ing|s)?\s*up|talked\s+about|hot\s+right\s+now|everywhere|everyone'?s\s+talking|nowadays|these\s+days|recently)\b/i;

const hasExplicitNewsDemand = (text) => EXPLICIT_NEWS_RE.test(String(text || ''));
const hasPopularityCue = (text) => POPULARITY_CUE_RE.test(String(text || ''));

const clamp01 = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const cleanText = (value, max = 400) => {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};

const oneOf = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

const asArray = (value) => (Array.isArray(value) ? value : []);

// Entity shape: { type, value }. Types are free-form strings from the reasoner
// but values are always cleaned, because entities end up in tool arguments.
const normalizeEntities = (value) =>
  asArray(value)
    .map((e) => {
      if (typeof e === 'string') {
        const v = cleanText(e, 120);
        return v ? { type: 'unknown', value: v } : null;
      }
      if (!e || typeof e !== 'object') return null;
      const v = cleanText(e.value ?? e.name ?? e.text, 120);
      if (!v) return null;
      return {
        type: cleanText(e.type, 40) || 'unknown',
        value: v,
      };
    })
    .filter(Boolean)
    .slice(0, 12);

// Candidate action shape: { intent, capability, rationale, args }.
// `capability` is a NAME that must still be resolved through the governed
// substrate; the Brain never executes it. `intent` is the capability role the
// planner should look for, used when no exact name is available.
const normalizeCandidateActions = (value) =>
  asArray(value)
    .map((a) => {
      if (typeof a === 'string') {
        return { intent: 'unspecified', capability: null, rationale: null, args: null };
      }
      if (!a || typeof a !== 'object') return null;
      const capability = cleanText(a.capability || a.tool || a.name, 80);
      const intent = cleanText(a.intent || a.role || a.kind, 60) || 'unspecified';
      const rationale = cleanText(a.rationale || a.reason || a.why, 200);
      const args =
        a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : null;
      return { intent, capability, rationale, args };
    })
    .filter(Boolean)
    .slice(0, 6);

/**
 * The canonical, fully-populated interpretation. Every field is present and
 * typed; downstream code never has to null-check a Brain output.
 */
const emptyInterpretation = (userText = '') => ({
  goal: null,
  taskType: TASK_OTHER,
  topic: null,
  entities: [],
  temporalRequirement: TEMPORAL_NONE,
  freshnessRequirement: FRESHNESS_NONE,
  externalKnowledgeNeeded: false,
  preferredResearchMode: RESEARCH_NONE,
  conversationRelation: RELATION_NEW_TASK,
  confidence: 0,
  ambiguity: 1,
  requiresClarification: false,
  candidateActions: [],
  // Non-decision evidence, carried for observability and for the reasoner
  // prompt. Never drives capability selection on its own.
  evidence: {
    userText: cleanText(userText, 400),
    explicitNewsDemand: hasExplicitNewsDemand(userText),
    popularityCue: hasPopularityCue(userText),
  },
});

/**
 * Validate and coerce an untrusted candidate into a safe interpretation.
 *
 * The reasoner is a language model, so its output is untrusted input. This
 * function is the trust boundary: it clamps numbers, rejects unknown enum
 * values, drops malformed entities, and applies the monotonic guard rails.
 *
 * It NEVER throws. A malformed response yields a safe, low-confidence
 * interpretation that the caller can treat as "no plan" rather than crashing
 * the turn or, worse, executing something arbitrary.
 *
 * @param {object} candidate raw reasoner output
 * @param {object} [options]
 * @param {string} [options.userText] the user message, for guard rails
 * @param {object} [options.conversation] prior Brain conversation state
 * @returns {{ok: boolean, interpretation: object, problems: string[]}}
 */
const normalizeInterpretation = (candidate, options = {}) => {
  const userText = options.userText || '';
  const problems = [];
  const src = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  if (!candidate || typeof candidate !== 'object') problems.push('not_an_object');

  const out = emptyInterpretation(userText);

  out.goal = cleanText(src.goal, 300);
  out.topic = cleanText(src.topic, 160);
  out.entities = normalizeEntities(src.entities);
  out.candidateActions = normalizeCandidateActions(src.candidateActions);

  out.taskType = oneOf(src.taskType, TASK_TYPES, TASK_OTHER);
  if (src.taskType && !TASK_TYPES.includes(src.taskType)) {
    problems.push(`unknown_taskType:${String(src.taskType).slice(0, 40)}`);
  }

  out.temporalRequirement = oneOf(
    src.temporalRequirement,
    TEMPORAL_REQUIREMENTS,
    TEMPORAL_NONE,
  );
  out.freshnessRequirement = oneOf(
    src.freshnessRequirement,
    FRESHNESS_REQUIREMENTS,
    FRESHNESS_NONE,
  );
  out.preferredResearchMode = oneOf(src.preferredResearchMode, RESEARCH_MODES, RESEARCH_NONE);
  out.conversationRelation = oneOf(
    src.conversationRelation,
    CONVERSATION_RELATIONS,
    RELATION_NEW_TASK,
  );

  out.externalKnowledgeNeeded = src.externalKnowledgeNeeded === true;
  out.requiresClarification = src.requiresClarification === true;
  out.confidence = clamp01(src.confidence, 0);
  out.ambiguity = clamp01(src.ambiguity, 1);

  // ---- monotonic guard rails (can only make the plan more conservative) ----

  // Rail 1: news is only ever chosen when the user actually asked for news.
  // This is the exact production failure. It is checked against the USER'S
  // OWN WORDS, never against conversation state, so history can never
  // manufacture a news request.
  const wantsNews =
    out.taskType === TASK_CURRENT_NEWS || out.preferredResearchMode === RESEARCH_CURRENT_NEWS;
  if (wantsNews && !out.evidence.explicitNewsDemand) {
    if (out.taskType === TASK_CURRENT_NEWS) {
      out.taskType = TASK_TOPIC_RESEARCH;
      out.preferredResearchMode = RESEARCH_GENERAL_WEB;
      out.externalKnowledgeNeeded = true;
      // Confidence must fall: we overrode the reasoner.
      out.confidence = Math.min(out.confidence, 0.5);
      out.evidence.newsDowngraded = true;
      problems.push('news_downgraded_no_explicit_demand');
    } else {
      // The MODE claimed news but the task did not. Clear the mode only.
      // Rewriting the taskType here would promote a non-retrieval turn into a
      // research task, which is how "hello" ends up launching a lookup.
      if (out.preferredResearchMode === RESEARCH_CURRENT_NEWS) {
        out.preferredResearchMode = RESEARCH_NONE;
        problems.push('news_mode_rejected_no_explicit_demand');
      }
    }
  }

  // Rail 2: a news task must actually want external information.
  if (out.taskType === TASK_CURRENT_NEWS) {
    out.externalKnowledgeNeeded = true;
    if (out.preferredResearchMode === RESEARCH_NONE) {
      out.preferredResearchMode = RESEARCH_CURRENT_NEWS;
    }
  }

  // Rail 3: a retrieval task implies external knowledge, and a non-retrieval
  // task must not silently claim it (that would launch a needless research
  // loop for "hello").
  if (RETRIEVAL_TASK_TYPES.includes(out.taskType)) {
    out.externalKnowledgeNeeded = true;
  }
  if (!out.externalKnowledgeNeeded && out.preferredResearchMode !== RESEARCH_NONE) {
    // Contradiction: a research mode with no external need. Prefer the
    // declared need only when the mode is a capability lookup (the user asked
    // for a tool by name); otherwise drop the mode.
    if (
      out.preferredResearchMode !== RESEARCH_NATIVE_CAPABILITY &&
      out.preferredResearchMode !== RESEARCH_MCP_CAPABILITY &&
      out.preferredResearchMode !== RESEARCH_MEMORY
    ) {
      out.preferredResearchMode = RESEARCH_NONE;
      problems.push('research_mode_without_external_need');
    }
  }

  // Rail 4: retrieval task types need a research mode, or nothing will run.
  if (RETRIEVAL_TASK_TYPES.includes(out.taskType) && out.preferredResearchMode === RESEARCH_NONE) {
    out.preferredResearchMode =
      out.taskType === TASK_CURRENT_NEWS ? RESEARCH_CURRENT_NEWS : RESEARCH_GENERAL_WEB;
  }

  // Rail 5: a conversation/clarification turn plans NOTHING. It must not carry
  // a retrieval mode, a claim of external knowledge, or a candidate action —
  // that combination is what produced "spun up GDELT to answer a greeting".
  // Keyed on the task, not the mode, so a bad mode cannot smuggle a lookup in.
  if (
    (out.taskType === TASK_CONVERSATION || out.taskType === TASK_CLARIFICATION) &&
    (out.preferredResearchMode !== RESEARCH_NONE ||
      out.externalKnowledgeNeeded ||
      out.candidateActions.length > 0)
  ) {
    out.preferredResearchMode = RESEARCH_NONE;
    out.externalKnowledgeNeeded = false;
    out.candidateActions = [];
    problems.push('conversation_turn_with_web_research');
  }

  // Rail 6: an action request may not be answered by research alone. It needs
  // a capability, and it will still pass the governed substrate.
  if (out.taskType === TASK_ACTION_REQUEST && out.candidateActions.length === 0) {
    problems.push('action_request_without_capability');
    out.confidence = Math.min(out.confidence, 0.5);
  }

  // Rail 7: requiresClarification and a high-confidence plan are
  // contradictory. Clarification wins; asking is the safe move.
  if (out.requiresClarification && out.confidence > 0.75) {
    out.confidence = Math.min(out.confidence, 0.6);
    problems.push('clarification_with_high_confidence');
  }

  // A goal is required for anything that acts. Derive a safe one rather than
  // letting an empty goal reach the planner.
  if (!out.goal) {
    out.goal = out.topic ? `understand ${out.topic}` : null;
  }

  return { ok: problems.length === 0, interpretation: out, problems };
};

module.exports = {
  // task types
  TASK_CONVERSATION,
  TASK_KNOWLEDGE,
  TASK_CURRENT_NEWS,
  TASK_WEB_RESEARCH,
  TASK_TOPIC_RESEARCH,
  TASK_CODING_HELP,
  TASK_ACTION_REQUEST,
  TASK_CLARIFICATION,
  TASK_OTHER,
  TASK_TYPES,
  RETRIEVAL_TASK_TYPES,
  // temporal / freshness
  TEMPORAL_NONE,
  TEMPORAL_RECENT_CONTEXT,
  TEMPORAL_LATEST,
  TEMPORAL_EXPLICIT,
  TEMPORAL_REQUIREMENTS,
  FRESHNESS_NONE,
  FRESHNESS_LOW,
  FRESHNESS_MODERATE,
  FRESHNESS_HIGH,
  FRESHNESS_REQUIREMENTS,
  // research modes
  RESEARCH_NONE,
  RESEARCH_CURRENT_NEWS,
  RESEARCH_GENERAL_WEB,
  RESEARCH_TARGETED,
  RESEARCH_MEMORY,
  RESEARCH_NATIVE_CAPABILITY,
  RESEARCH_MCP_CAPABILITY,
  RESEARCH_MODES,
  // conversation relations
  RELATION_NEW_TASK,
  RELATION_CONTINUATION,
  RELATION_REFINEMENT,
  RELATION_CORRECTION,
  CONVERSATION_RELATIONS,
  // guards + api
  hasExplicitNewsDemand,
  hasPopularityCue,
  EXPLICIT_NEWS_RE,
  POPULARITY_CUE_RE,
  emptyInterpretation,
  normalizeInterpretation,
  clamp01,
  cleanText,
};
