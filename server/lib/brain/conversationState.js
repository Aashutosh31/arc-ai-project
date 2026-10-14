'use strict';

// ARC Brain — explicit conversation state.
//
// THE BUG THIS MODULE EXISTS TO FIX
// parseNewsIntent (AIService.js) treated persisted scope as a COMMAND:
//
//     if (!active && !hasNewsWords) return null;     // AIService.js:324
//
// `active` was the previous turn's news scope. Once any news turn happened,
// that clause waived the news-word requirement entirely, so a message that
// never mentioned news ("i just asked about paperclip project") still produced
// a GDELT news request. Worse, the scope was written at INTENT time
// (AIService.js:4693-4706) before the tool ran, so a news turn that FAILED
// still armed the next turn. The loop was self-sustaining and the user could
// not escape it by correcting themselves.
//
// THE RULE HERE
// Conversation history is CONTEXT, not COMMAND. Prior state may only:
//   - refine a turn that is genuinely continuous (a follow-up with no
//     resolvable subject of its own), or
//   - be discarded, when a new subject or a correction appears.
//
// Prior state may NEVER, on its own, select a task type, a research mode, or a
// capability. That is what makes the "previous turn was news" -> "tell me
// about Kubernetes" case a new task instead of a news refinement.
//
// State is per-actor scoped and TTL-bounded, so it cannot leak between users
// or grow without limit.

const { RELATION_NEW_TASK, RELATION_CONTINUATION, RELATION_REFINEMENT, RELATION_CORRECTION,
  TASK_CURRENT_NEWS, cleanText } = require('./interpretation');

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes of conversational memory
const MAX_HISTORY = 12;

/**
 * Correction detection.
 *
 * This is intentionally a small, high-precision set of OPENERS plus a
 * structural check, because a correction is the one case where being eager is
 * correct: misreading a correction as a normal request is what trapped the
 * user in the news loop. It is still not the primary intent classifier — the
 * reasoner decides the goal; this only decides "the user is objecting to the
 * previous hypothesis", which is a grammatical fact about the message, not a
 * semantic guess.
 */
const CORRECTION_PATTERNS = [
  /^\s*(no|nope|nah)\b/i,
  /^\s*not\s+(what|the|that|what\s+i)/i,
  /\b(i\s+meant|i\s+asked\s+about|i\s+said\s+about|that'?s\s+not\s+what)\b/i,
  /\b(not\s+the\s+news|not\s+news|wasn'?t\s+asking\s+for\s+news)\b/i,
  /\b(forget\s+(that|it)|never\s*mind|nevermind|scratch\s+that)\b/i,
  /\b(you\s+(misunderstood|got\s+it\s+wrong|got\s+wrong|are\s+doing\s+the\s+wrong))\b/i,
  /\b(again|stop)\b.*\b(already|asked|said|told)\b/i,
  /^\s*(i\s+)?(just\s+)?asked\b/i,
];

const isCorrection = (text) => {
  const s = String(text || '').trim();
  if (!s || s.length > 400) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(s));
};

// Follow-up detection: a message with no subject of its own. Deliberately
// conservative. A message that names ANY concrete subject is not a follow-up,
// so "tell me about Kubernetes" after a news turn can never be absorbed.
//
// The trailing group matters more than it looks: "more" is a follow-up, and so
// is "more detail", "more info" and "more detail about it". A pattern anchored
// to accept only bare "more" reads the others as new subjects, which silently
// drops the one piece of context the user was relying on.
const FILLER_RE = new RegExp(
  '^\\s*(?:' + [
    'more', 'again', 'go on', 'continue', 'keep going', 'and', 'also', 'next',
    'why', 'how', 'really', 'same', 'that', 'this', 'it', 'those', 'these',
    'ok', 'okay', 'sure', 'yes', 'yeah', 'yep', 'please do', 'elaborate', 'expand',
    'details?', 'deeper', 'go deeper', 'anything else', 'any more', 'anything more',
    'tell me more', 'explain more', 'expand on it', 'expand on that',
    'elaborate on it', 'elaborate on that', 'go into more detail', 'go in depth',
    'what else', 'anything else\\?', 'and\\?',
  ].join('|') +
  ')\\b[\\s!.,?]*' +
  '(?:(?:detail|details|info|information|context|background|depth|history|examples?|usage|insight|insights|on it|on that|about it|about that|on this|about this))?[\\s!.,?]*$',
  'i',
);

// A message that looks like a bare fragment continuing a prior answer.
const PRONOUN_SUBJECT_RE =
  /^\s*(it|its|that|this|those|these|they|them|he|she|him|her)\b/i;

const hasConcreteSubject = (text, state) => {
  const s = String(text || '').trim();
  if (!s) return false;
  // A quoted or capitalized proper noun is a subject.
  if (/\b[A-Z][a-z]{2,}/.test(s) && !/^\s*(I|What|Who|Where|When|How|Why)\b/.test(s)) return true;
  // A URL, package, or code identifier.
  if (/https?:\/\/|\b[a-z0-9-]+\.(com|io|org|dev|ai|net)\b|\bgithub\.com\b/.test(s)) return true;
  // Any capitalized word that is not the first word of a common sentence frame.
  const words = s.split(/\s+/);
  if (words.length > 2) {
    for (let i = 1; i < words.length; i += 1) {
      if (/^[A-Z][a-zA-Z0-9]{2,}$/.test(words[i])) return true;
    }
  }
  // Long messages describe their own subject even if lowercase.
  if (s.split(/\s+/).length >= 6) return true;
  // A remembered topic that the message explicitly names.
  if (state && state.topic) {
    const t = state.topic.toLowerCase();
    if (t.length >= 4 && s.toLowerCase().includes(t)) return true;
  }
  return false;
};

const isFollowUp = (text, state) => {
  const s = String(text || '').trim();
  if (!s) return false;
  if (FILLER_RE.test(s)) return true;
  // A short pronoun-led fragment continues the previous answer.
  if (s.length <= 80 && PRONOUN_SUBJECT_RE.test(s) && !hasConcreteSubject(s, state)) return true;
  return false;
};

/**
 * Per-actor conversation state. One instance per user (or guest) id.
 * Deliberately in-process and TTL-bounded: it is conversational working memory,
 * not durable memory. Durable user facts are a separate, governed capability.
 */
class BrainConversationState {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, object>} actorKey -> state */
    this._byActor = new Map();
  }

  _slot(actorKey) {
    const now = Date.now();
    const key = String(actorKey || 'anonymous');
    let entry = this._byActor.get(key);
    if (entry && now - entry.updatedAt > this.ttlMs) {
      entry = null; // expired: conversational memory does not survive a long gap
    }
    if (!entry) {
      entry = {
        topic: null,
        taskType: null,
        researchMode: null,
        goal: null,
        lastCapabilities: [],
        // True only when the last turn was a news request the guard rails
        // actually granted. A bare qualifier may continue such a turn; it may
        // never conjure one.
        newsGranted: false,
        lastOutcome: null,
        pendingClarification: null,
        correctionCount: 0,
        turnCount: 0,
        history: [],
        updatedAt: now,
      };
      this._byActor.set(key, entry);
    }
    entry.updatedAt = now;
    return entry;
  }

  /**
   * Resolve how this turn relates to the previous one, BEFORE interpreting the
   * goal. Ordering matters: a correction must be recognized before the
   * previous scope can influence anything.
   */
  relate(userText, { actorKey } = {}) {
    const slot = this._slot(actorKey);
    const text = String(userText || '').trim();

    if (isCorrection(text)) {
      return {
        relation: RELATION_CORRECTION,
        // The previous hypothesis is explicitly invalidated for this turn.
        discardActiveScope: true,
        priorTopic: slot.topic,
        priorTaskType: slot.taskType,
        priorResearchMode: slot.researchMode,
        // Explicitly null, not absent: a correction inherits NOTHING, and a
        // caller should not have to distinguish "no inheritance" from
        // "the state forgot to answer".
        inheritedTopic: null,
        inheritedGoal: null,
        correctionCount: slot.correctionCount,
        reason: 'user_objected_to_previous_hypothesis',
      };
    }

    const followUp = isFollowUp(text, slot);
    if (followUp && slot.topic) {
      return {
        relation: slot.taskType === TASK_CURRENT_NEWS ? RELATION_CONTINUATION : RELATION_REFINEMENT,
        discardActiveScope: false,
        // Inherited SUBJECT only. Note what is NOT inherited: the task type
        // and research mode are re-derived by the reasoner from the merged
        // text, so a "more" after news continues news, but a "more" after a
        // research task cannot silently become news.
        inheritedTopic: slot.topic,
        inheritedGoal: slot.goal,
        priorTaskType: slot.taskType,
        reason: 'subjectless_follow_up',
      };
    }

    // A bare qualifier carries no request of its own: "in India",
    // "what about the US?", "only business". It narrows what is already
    // active, so it CONTINUES the prior scope rather than replacing it. This
    // must be decided before the concrete-subject check below, because a region
    // word ("India") is capitalized and would otherwise read as a brand new
    // subject, which would break a multi-turn scoping conversation.
    if (!carriesNewRequest(text) && slot.taskType) {
      return {
        relation: slot.taskType === TASK_CURRENT_NEWS ? RELATION_CONTINUATION : RELATION_REFINEMENT,
        discardActiveScope: false,
        inheritedTopic: slot.topic,
        inheritedGoal: slot.goal,
        inheritedTaskType: slot.taskType,
        inheritedResearchMode: slot.researchMode,
        priorTaskType: slot.taskType,
        priorNewsGranted: slot.newsGranted,
        reason: 'bare_scope_qualifier',
      };
    }

    return {
      relation: RELATION_NEW_TASK,
      discardActiveScope: true,
      priorTopic: slot.topic,
      priorTaskType: slot.taskType,
      inheritedTopic: null,
      inheritedGoal: null,
      reason: hasConcreteSubject(text, slot) ? 'new_subject_present' : 'no_inherited_scope',
    };
  }

  /**
   * Commit an interpretation for this turn. Only the SUBJECT and the resolved
   * goal are durable; a failed turn still updates the topic (the user really
   * did ask about it) but records the outcome so the next turn can recover.
   */
  commit(actorKey, interpretation, meta = {}) {
    const slot = this._slot(actorKey);
    slot.turnCount += 1;
    if (meta.relation === RELATION_CORRECTION) slot.correctionCount += 1;

    // A correction replaces the subject rather than merging into it.
    if (meta.relation === RELATION_CORRECTION) {
      slot.topic = null;
      slot.taskType = null;
      slot.researchMode = null;
    }

    if (interpretation && interpretation.topic) slot.topic = interpretation.topic;
    if (interpretation && interpretation.taskType) slot.taskType = interpretation.taskType;
    if (interpretation && interpretation.preferredResearchMode) {
      slot.researchMode = interpretation.preferredResearchMode;
    }
    if (interpretation && interpretation.goal) slot.goal = interpretation.goal;

    // The Brain only ever assigns current_news after the monotonic rail has
    // confirmed explicit demand, so this task type IS the record of a granted
    // news request. Tracking it is what lets "in India" continue a news turn
    // without letting any message continue one that was never granted.
    slot.newsGranted = Boolean(
      interpretation && interpretation.taskType === 'current_news',
    );

    slot.lastCapabilities = Array.isArray(meta.capabilities) ? meta.capabilities.slice(0, 6) : [];
    slot.lastOutcome = meta.outcome || null;
    slot.pendingClarification = interpretation && interpretation.requiresClarification
      ? { question: cleanText(meta.clarificationQuestion, 300) || null, at: Date.now() }
      : null;

    slot.history.push({
      at: Date.now(),
      relation: meta.relation || null,
      taskType: interpretation ? interpretation.taskType : null,
      topic: interpretation ? interpretation.topic : null,
      outcome: meta.outcome || null,
    });
    if (slot.history.length > MAX_HISTORY) slot.history.splice(0, slot.history.length - MAX_HISTORY);
    return slot;
  }

  get(actorKey) {
    const slot = this._slot(actorKey);
    return {
      topic: slot.topic,
      taskType: slot.taskType,
      researchMode: slot.researchMode,
      newsGranted: slot.newsGranted,
      goal: slot.goal,
      lastCapabilities: slot.lastCapabilities.slice(),
      lastOutcome: slot.lastOutcome,
      pendingClarification: slot.pendingClarification,
      correctionCount: slot.correctionCount,
      turnCount: slot.turnCount,
      history: slot.history.slice(),
    };
  }

  /** The bounded, summarized turn history for an actor. */
  history(actorKey) {
    return this._slot(actorKey).history.slice();
  }

  /** Drop a subject without dropping the conversation (user said "forget that"). */
  forgetTopic(actorKey) {
    const slot = this._slot(actorKey);
    slot.topic = null;
    slot.taskType = null;
    slot.researchMode = null;
    slot.lastOutcome = null;
    return slot;
  }

  clear(actorKey) {
    if (actorKey === undefined) this._byActor.clear();
    else this._byActor.delete(String(actorKey || 'anonymous'));
  }
}

/** The process-wide instance the runtime uses. */
let singleton = null;
const getConversationState = () => {
  if (!singleton) singleton = new BrainConversationState();
  return singleton;
};

/**
 * Does this message carry its OWN request frame?
 *
 * This is the grammatical fact that separates a scope refinement from a new
 * request, and it is what the old news gate could not see:
 *
 *   "in India"                      no request frame -> continues the news scope
 *   "what about the US?"            no request frame -> continues the news scope
 *   "only technology news"          no request frame -> continues the news scope
 *   "provide me detailed information about paperclip"   HAS a frame -> NEW
 *   "tell me about the Paperclip project"               HAS a frame -> NEW
 *
 * A message that asks for information never continues a prior lookup, however
 * short it is and however active that lookup is. This is why the Paperclip
 * question could not be absorbed by the news turn before it, and why "in India"
 * still is.
 */
const REQUEST_FRAME_RE = new RegExp(
  [
    '^\\s*',
    // optional acknowledgement / politeness scaffolding, repeated: real speech
    // stacks these ("ok so can you..."), so a single optional token is not enough
    '(?:(?:ok|okay|hey|so|well|now|also|and|but|please|pls)\\b[\\s,]*)*',
    '(?:(?:can|could|would|will|do|does|did)\\s+)?',
    '(?:you\\s+)?',
    '(?:u\\s+)?',
    '(?:',
    '(?:tell|give|show|find|provide|fetch|get|search|look|research|explore|explain|describe|summari[sz]e|browse|dig)\\b',
    '|(?:what|who|where|when|why|how)\\s+(?:is|are|was|were|do|does|did)\\b',
    "|what\\s*'?s\\b",
    ')',
  ].join(''),
  'i',
);

const carriesNewRequest = (text) => REQUEST_FRAME_RE.test(String(text || '').trim());

module.exports = {
  BrainConversationState,
  getConversationState,
  isCorrection,
  isFollowUp,
  hasConcreteSubject,
  carriesNewRequest,
  CORRECTION_PATTERNS,
  DEFAULT_TTL_MS,
};
