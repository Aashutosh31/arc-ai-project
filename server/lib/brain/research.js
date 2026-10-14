'use strict';

// ARC Brain — research planning and observation evaluation.
//
// This is the loop that separates an AGENT from a tool router:
//
//   UNDERSTAND -> HYPOTHESIZE -> SEARCH -> OBSERVE -> EVALUATE -> REPLAN
//
// A search result is NOT an answer. In production, any getTopNews result —
// including a failure — became the turn's answer via buildToolFailureText. Here
// an observation is scored first, and a low-relevance observation is REJECTED
// rather than synthesized.
//
// Query strategy is a bounded LADDER, not a single attempt. Each rung is a
// genuinely different strategy, so a rung is only worth trying if the previous
// one failed for a reason the next one addresses. research.js owns the ladder;
// observation.js owns the verdict.

const {
  RESEARCH_CURRENT_NEWS, RESEARCH_GENERAL_WEB, RESEARCH_TARGETED, POPULARITY_CUE_RE,
} = require('./interpretation');
const {
  inferEntityTypes,
  inferEntityType,
  inferExpectedTypes,
  compareEntityType,
  identityMatch,
  MISMATCH,
  REFINEMENT,
  COMPATIBLE,
} = require('./entities');

const MAX_RESEARCH_STEPS = 3;
const MAX_QUERY_VARIANTS = 3;

// Relevance verdicts, ordered by severity so a caller can pick the worst.
const RELEVANCE_USELESS = 'useless';
const RELEVANCE_WEAK = 'weak';
const RELEVANCE_PARTIAL = 'partial';
const RELEVANCE_RELEVANT = 'relevant';

// Verdict categories. These are enums, not prose: a log line can carry a
// category without carrying chain-of-thought.
const CATEGORY = Object.freeze({
  EXECUTION_FAILED: 'execution_failed',
  NO_CONTENT: 'no_content_returned',
  IDENTITY_MISMATCH: 'identity_mismatch',
  ENTITY_TYPE_MISMATCH: 'entity_type_mismatch',
  UNVERIFIED_ENTITY_TYPE: 'unverified_entity_type',
  GOAL_NOT_COVERED: 'goal_not_covered',
  PARTIAL_COVERAGE: 'partial_coverage',
  ON_TOPIC: 'on_topic',
});

// Thresholds. `useless` below WEAK is rejected outright — this is the
// "List of Malayalam films of 2026" case for a Paperclip query.
const THRESHOLDS = Object.freeze({
  rejectBelow: 0.25,
  weakBelow: 0.5,
  partialBelow: 0.75,
});

const clamp01 = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};

// Words that carry no subject information. They are dropped before any
// relevance math: without this, "the" satisfies a goal token and a page about
// Malayalam films looks like it partially covers "understand the paperclip
// project". Relevance must be judged on what the result is ABOUT.
const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were',
  'you', 'your', 'our', 'its', 'his', 'her', 'their', 'them', 'they', 'but', 'not',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must', 'have', 'has',
  'had', 'been', 'being', 'does', 'did', 'get', 'got', 'give', 'give', 'tell', 'show',
  'provide', 'please', 'want', 'need', 'like', 'know', 'think', 'about', 'what', 'whats',
  'which', 'who', 'whom', 'whose', 'how', 'why', 'when', 'where', 'any', 'some', 'all',
  'more', 'most', 'much', 'many', 'just', 'now', 'also', 'very', 'really', 'quite',
  'me', 'my', 'our', 'us', 'out', 'off', 'over', 'under', 'about', 'there', 'here',
  'latest', 'recent', 'recently', 'currently', 'nowadays', 'today', 'detailed', 'detail',
  'details', 'information', 'info', 'summary', 'overview', 'background', 'context',
  'tell', 'search', 'find', 'look', 'research', 'explain', 'describe', 'update',
  'understand', 'learn', 'know', 'see', 'read', 'summarize', 'summarise',
  'updates', 'full', 'complete', 'list', 'top', 'best', 'good', 'new', 'first', 'last',
]);

const tokensOf = (text) =>
  unique(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)),
  );

const unique = (arr) => [...new Set(arr.filter(Boolean))];

/**
 * Build the query strategy ladder for a goal.
 *
 * Each rung is materially different:
 *   0. the user's own phrasing
 *   1. topic-scoped, stripped of conversational scaffolding
 *   2. topic + disambiguator ("project", "github", "what is")
 *
 * This is what makes "replan" mean something. Re-running the identical query
 * cannot succeed, so the ladder never repeats a query.
 */
const buildQueryLadder = ({ topic, goal, userText, mode }) => {
  const bare = String(topic || '').trim();
  const goalText = String(goal || '').trim();
  const raw = String(userText || '').trim();

  const variants = [];

  // The SUBJECT-scoped query goes first. It is the cleanest statement of what
  // is being asked, and it is the only rung that is safe for a correction: the
  // raw user text of "i just asked about paperclip project" is meta-language
  // about the request, and searching for it verbatim finds nothing.
  if (bare) variants.push(bare);

  // The user's own phrasing second: it carries disambiguation the subject lost
  // ("the paperclip project in tech").
  if (raw && raw.length <= 200 && raw.toLowerCase() !== bare.toLowerCase()) {
    variants.push(raw);
  }

  // Topic + a disambiguator that matches the research mode. For news we want
  // recency framing; for topic research we want "what is X".
  if (bare) {
    if (mode === RESEARCH_CURRENT_NEWS) {
      variants.push(`${bare} latest news`);
    } else {
      variants.push(`what is ${bare}`);
      variants.push(`${bare} project github`);
    }
  }

  if (!bare && goalText) {
    variants.push(goalText);
  }

  return unique(variants).slice(0, MAX_QUERY_VARIANTS);
};

/**
 * Structural overlap between a query and an observation's text.
 * Pure string math — no model call — so relevance can be judged even when the
 * provider is unavailable. It is a floor, not a ceiling: the reasoner refines
 * it when available.
 */
const lexicalRelevance = ({ query, texts = [], focus = null }) => {
  // The FOCUS is what the result must be about. Scoring against the raw user
  // message is a trap: the first ladder rung is the whole conversational
  // sentence ("ok can you provide me detailed information about paperclip
  // which is getting viral nowadays in tech"), so a result that mentions
  // "paperclip" once covers only 1 of 9 tokens and looks useless. The subject
  // is the thing that has to appear, so the subject is what is scored.
  const focusText = String(focus || '').trim() || String(query || '');
  const qTokens = tokensOf(focusText);
  if (!qTokens.length) qTokens.push(...tokensOf(query));
  if (!qTokens.length) return 0;
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  if (!haystack) return 0;
  let hits = 0;
  for (const t of qTokens) {
    if (haystack.includes(t)) hits += 1;
  }
  const coverage = hits / qTokens.length;
  // Reward partial coverage: a result that nails the rarest focus token is
  // worth more than one that matches only a common word.
  const hTokens = new Set(tokensOf(haystack));
  let rareBonus = 0;
  for (const t of qTokens) if (hTokens.has(t)) rareBonus += t.length >= 6 ? 2 : 1;
  const rarity = rareBonus / (qTokens.length * 2 || 1);
  return clamp01(coverage * 0.7 + rarity * 0.3);
};

/**
 * How much of the user's own DISTINGUISHING vocabulary the result echoes.
 *
 * "Distinguishing" excludes the subject, stop words, and popularity/freshness
 * cues — those express intent ("getting popular"), not content, so requiring a
 * result to contain them would be nonsense. What is left is the vocabulary that
 * would distinguish an answer to THIS goal from a page that merely contains the
 * subject string.
 *
 * Used as a confidence signal, never as a hard gate: a genuinely good result
 * ("Paperclip: a note-taking app with a web clipper") legitimately shares no
 * vocabulary with "open-source technology project", and a hard gate would
 * refuse it. Zero corroboration therefore means "we cannot tell", not "wrong".
 */
const goalCorroboration = ({ texts, goal, userText, subject, query }) => {
  const goalText = [goal, userText].map((s) => String(s || '')).join(' ');
  const subjectLower = String(subject || '').trim().toLowerCase();
  const withoutIntent = String(goalText).replace(new RegExp(POPULARITY_CUE_RE.source, 'gi'), ' ');
  const terms = tokensOf(withoutIntent)
    .filter((t) => !(subjectLower && subjectLower.includes(t) && t.length >= 4))
    .filter((t) => !String(goal || '').toLowerCase().includes(t) ? true : true);
  if (!terms.length) return { ratio: null, matched: [], total: 0 };
  const haystack = (texts || []).filter(Boolean).join(' \n ').toLowerCase();
  const matched = terms.filter((t) => haystack.includes(t));
  return { ratio: matched.length / terms.length, matched, total: terms.length };
};

/**
 * Extract the text an observation actually contains, from whatever shape the
 * governed capability returned. Native tools are ad-hoc by design, so this
 * probes defensively rather than assuming a fixed schema.
 */
const extractObservationText = (result) => {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  // A governed capability may legitimately return plain text.
  if (typeof result === 'string') { push(result); return unique(out).slice(0, 40); }
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result.articles)) {
    for (const a of result.articles) {
      if (a && typeof a === 'object') { push(a.title); push(a.headline); push(a.summary); }
      else push(a);
    }
  }
  if (Array.isArray(result.results)) {
    for (const r of result.results) {
      if (r && typeof r === 'object') { push(r.title); push(r.snippet); push(r.summary); push(r.description); push(r.text); push(r.content); }
      else push(r);
    }
  }
  if (Array.isArray(result.items)) {
    for (const r of result.items) {
      if (r && typeof r === 'object') { push(r.title); push(r.name); push(r.description); push(r.text); }
      else push(r);
    }
  }
  push(result.title); push(result.headline); push(result.snippet);
  push(result.summary); push(result.text); push(result.content);
  push(result.answer); push(result.message); push(result.output);
  // Wrapped payloads: several tools return { result: ... } or { data: ... }.
  // Unwrap one level rather than silently scoring an empty observation.
  for (const key of ['result', 'data', 'payload', 'output']) {
    const inner = result[key];
    if (typeof inner === 'string') push(inner);
    else if (inner && typeof inner === 'object') {
      for (const t of extractObservationText(inner)) push(t);
    }
  }
  if (typeof result === 'string') push(result);
  return unique(out).slice(0, 40);
};

/**
 * Score a governed execution result against the user's goal.
 *
 * Relevance is judged on three axes rather than string overlap alone, because
 * overlap cannot separate "Paperclip" the software project from "Paperclip" the
 * short film — both contain the subject exactly once:
 *
 *   identity  the result is about the same named thing
 *   type      it is the same KIND of thing (see ./entities.js)
 *   goal      it covers what the user actually asked for
 *
 * A wrong entity type is a HARD gate, not a discount: a film cannot answer a
 * question about a technology project no matter how well the words line up.
 * An untyped result is NOT a mismatch — it is ambiguity, and ambiguity is
 * surfaced rather than resolved by guessing.
 *
 * @param {object} params
 * @param {object} params.result raw TaskExecutor result (untrusted shape)
 * @param {string} params.query the query that produced it
 * @param {string} params.goal the user's actual goal
 * @param {boolean} [params.succeeded] execution success flag
 * @param {string} [params.subject] the resolved subject; what a valid result
 *   must be about. Preferred over `query` for relevance scoring.
 * @param {string} [params.userText] the user's own words, used only to read
 *   the expected entity TYPE ("...technology project"). Never for coverage.
 * @param {number} [params.assessedRelevance] reasoner-provided 0..1, when available
 * @returns {{
 *   relevant: boolean, confidence: number, relevance: string, category: string,
 *   reason: string, missingInformation: string[], contradiction: string|null,
 *   nextAction: string, executionFailed: boolean, texts: string[],
 *   ambiguity: number, score: number, entity: object, identity: object,
 *   typeCompatibility: object
 * }}
 */
const evaluateObservation = ({
  result, query, goal, userText, subject, succeeded, assessedRelevance,
} = {}) => {
  const executionFailed = succeeded === false;
  const texts = extractObservationText(result);
  // The SUBJECT is what a valid result must be about. With no explicit subject,
  // fall back to the most specific available description: "paperclip" beats
  // "understand the paperclip project" beats the whole user sentence.
  const candidates = [subject, goal, query].map((s) => String(s || '').trim()).filter(Boolean);
  const focus = candidates.sort((a, b) => a.length - b.length)[0] || '';
  const lexical = lexicalRelevance({ query, texts, focus });

  // ---- axis 1: identity -----------------------------------------------------
  const identity = identityMatch(texts, subject);

  // ---- axis 2: entity type ---------------------------------------------------
  const observed = texts.length ? inferEntityTypes(texts.join('\n'), { subject }) : inferEntityTypes('');
  const expected = inferExpectedTypes({ goal, query, userText, subject });
  const typeVerdict = compareEntityType(observed, expected);

  // The optional semantic layer is a bounded VERIFICATION layer. It can lower a
  // score (it sees something the lexical floor missed) and it may lift a very
  // low floor to 0.35, but it is never trusted above the observed evidence: a
  // model claiming relevance cannot override identity or type.
  const assessed = Number.isFinite(assessedRelevance) ? clamp01(assessedRelevance) : null;
  // A confident model verdict counts as a SECOND, independent confirmation —
  // which is what makes the layer useful for results the deterministic floor
  // cannot type. It still cannot outvote a hard identity or type gate, both of
  // which are applied to the observed text itself.
  const modelConfirmed = assessed !== null && assessed >= 0.75;

  // A result we could not type, for a goal that DID express a type, is a real
  // limit of what we know — never a rejection, and never full confidence.
  const typeUnverified = Boolean(expected.hasExpectation)
    && observed.candidates.length === 0
    && !executionFailed
    && texts.length > 0;

  // CONFIDENCE GATE.
  //
  // Matching the subject string is not evidence that a result answers the
  // question: "Shopping list: paperclip, eggs, bread" contains the subject once
  // and scores identically to a real description. So a result is only treated as
  // CONFIRMED when its entity type positively corroborates the goal's type
  // expectation, or when it echoes the goal's distinguishing vocabulary. An
  // unconfirmed result is capped at `partial`, which sends the loop to another
  // rung instead of synthesizing on a coin flip.
  const typeConfirmed = typeVerdict.compatibility === COMPATIBLE
    || typeVerdict.compatibility === REFINEMENT;
  const corroboration = goalCorroboration({ texts, goal, userText, subject, query });
  const unconfirmed = Boolean(
    texts.length && !executionFailed
    && !typeConfirmed
    && !modelConfirmed
    && !(corroboration.ratio !== null && corroboration.ratio >= 0.25),
  );

  // ---- combine --------------------------------------------------------------
  // Identity is a gate. Type mismatch is a hard gate. Otherwise the three axes
  // combine additively, so a well-covered result of the right type scores well.
  let coverage = lexical;
  if (!identity.matched) coverage = 0;
  const typeFactor = typeVerdict.factor;
  let score = clamp01(coverage * typeFactor);

  let category;
  let reason;
  if (executionFailed) {
    category = CATEGORY.EXECUTION_FAILED;
    reason = 'the_capability_reported_failure';
  } else if (texts.length === 0) {
    category = CATEGORY.NO_CONTENT;
    reason = 'the_capability_returned_no_readable_text';
    score = 0;
  } else if (!identity.matched) {
    category = CATEGORY.IDENTITY_MISMATCH;
    reason = 'the_result_never_mentions_the_requested_subject';
    score = 0;
  } else if (typeVerdict.compatibility === MISMATCH) {
    category = CATEGORY.ENTITY_TYPE_MISMATCH;
    reason = `the_result_is_a_${observed.primary.type.replace(/_/g, ' ')}`
      + `_but_the_goal_expects_${(expected.types[0] || expected.families[0] || 'another type').replace(/_/g, ' ')}`;
    score = 0;
  } else {
    category = null; // assigned below
  }

  if (assessed !== null) {
    score = Math.min(assessed, Math.max(score, 0.35));
  }

  let relevance;
  if (score < THRESHOLDS.rejectBelow) relevance = RELEVANCE_USELESS;
  else if (score < THRESHOLDS.weakBelow) relevance = RELEVANCE_WEAK;
  else if (score < THRESHOLDS.partialBelow) relevance = RELEVANCE_PARTIAL;
  else relevance = RELEVANCE_RELEVANT;

  if (!category) {
    if (unconfirmed) {
      category = CATEGORY.UNVERIFIED_ENTITY_TYPE;
      reason = 'the_result_matches_the_subject_but_nothing_confirms_it_answers_this_goal';
    } else if (typeUnverified) {
      category = CATEGORY.UNVERIFIED_ENTITY_TYPE;
      reason = 'the_goal_names_a_type_but_the_result_could_not_be_typed';
    } else if (score < THRESHOLDS.weakBelow) {
      category = CATEGORY.GOAL_NOT_COVERED;
      reason = 'the_result_mentions_the_subject_but_not_the_goal';
    } else if (relevance === RELEVANCE_PARTIAL) {
      category = CATEGORY.PARTIAL_COVERAGE;
      reason = 'the_result_covers_part_of_the_goal';
    } else {
      category = CATEGORY.ON_TOPIC;
      reason = typeVerdict.compatibility === REFINEMENT
        ? 'the_result_is_a_narrower_view_of_the_requested_type'
        : 'the_result_matches_the_subject_type_and_goal';
    }
  }

  let ambiguity = clamp01(
    (unconfirmed ? 0.5 : (expected.hasExpectation && observed.candidates.length === 0 ? 0.4 : 0))
    + (typeVerdict.compatibility === REFINEMENT ? 0.15 : 0)
    + (relevance === RELEVANCE_PARTIAL ? 0.2 : 0)
    + (relevance === RELEVANCE_WEAK ? 0.3 : 0),
  );
  if (unconfirmed && relevance === RELEVANCE_RELEVANT) {
    relevance = RELEVANCE_PARTIAL;
  }

  const missingInformation = [];
  if (texts.length === 0) missingInformation.push('no_content_returned');
  if (score < THRESHOLDS.partialBelow) missingInformation.push('core_topic_not_covered');
  if (executionFailed) missingInformation.push('capability_execution_failed');
  if (typeUnverified) missingInformation.push('entity_type_unverified');
  if (unconfirmed) missingInformation.push('answer_not_confirmed_by_type_or_vocabulary');
  if (typeVerdict.compatibility === MISMATCH) missingInformation.push('requested_entity_type_not_present');

  // Contradiction is only claimed when we can see it: a result whose text
  // explicitly negates the goal is a contradiction, absence of evidence is not.
  let contradiction = null;
  const goalTokens = tokensOf(focus);
  if (goalTokens.length >= 1 && texts.length) {
    const joined = texts.join(' ').toLowerCase();
    const covered = goalTokens.filter((t) => joined.includes(t)).length;
    if (covered === 0 && score < THRESHOLDS.weakBelow) {
      contradiction = 'result_never_mentions_the_requested_subject';
    }
  }

  let nextAction;
  if (executionFailed) {
    nextAction = 'retry_with_alternate_strategy';
  } else if (relevance === RELEVANCE_USELESS) {
    nextAction = 'reject_and_replan';
  } else if (relevance === RELEVANCE_WEAK) {
    nextAction = 'replan_broader_query';
  } else if (relevance === RELEVANCE_PARTIAL) {
    // Spend one more rung on a query that names the type, rather than
    // synthesizing on an unconfirmed match.
    nextAction = (unconfirmed || typeUnverified)
      ? 'replan_with_type_disambiguator'
      : 'replan_targeted_query';
  } else {
    nextAction = 'synthesize';
  }

  const relevant = relevance === RELEVANCE_RELEVANT || relevance === RELEVANCE_PARTIAL;
  return {
    relevant,
    // Confidence in the ANSWER, not in the score. An ambiguous or untyped match
    // is never reported at full confidence.
    confidence: clamp01(score * (executionFailed ? 0.3 : 1) * (1 - ambiguity * 0.5), 0),
    relevance,
    category,
    reason,
    score: Number(score.toFixed(3)),
    lexicalScore: Number(lexical.toFixed(3)),
    assessedScore: assessed,
    ambiguity: Number(ambiguity.toFixed(3)),
    entity: observed.primary,
    entityCandidates: observed.candidates.map((c) => c.type),
    expectedEntityFamilies: expected.families,
    identity: { matched: identity.matched, reason: identity.reason },
    typeCompatibility: {
      compatibility: typeVerdict.compatibility,
      reason: typeVerdict.reason,
      confirmed: typeConfirmed,
    },
    corroboration: {
      ratio: corroboration.ratio === null ? null : Number(corroboration.ratio.toFixed(3)),
      matchedTerms: corroboration.matched.slice(0, 8),
      totalTerms: corroboration.total,
    },
    missingInformation,
    contradiction,
    nextAction,
    executionFailed,
    texts,
  };
};

module.exports = {
  MAX_RESEARCH_STEPS,
  MAX_QUERY_VARIANTS,
  CATEGORY,
  RELEVANCE_USELESS,
  RELEVANCE_WEAK,
  RELEVANCE_PARTIAL,
  RELEVANCE_RELEVANT,
  THRESHOLDS,
  buildQueryLadder,
  lexicalRelevance,
  inferEntityType,
  inferExpectedTypes,
  extractObservationText,
  evaluateObservation,
};
