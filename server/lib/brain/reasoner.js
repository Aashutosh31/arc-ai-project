'use strict';

// ARC Brain — the reasoning contract and its reasoner abstraction.
//
// PROVIDER INDEPENDENCE
// The Brain is the orchestration architecture; the LLM is one reasoning
// component inside it. This module defines the seam:
//
//     reasoner({ system, user, contract }) -> { ok, candidate, problems }
//
// The runtime does not know or care which provider answered. Swapping Groq for
// Gemini for a local model means supplying a different reasoner, not rewriting
// agent behaviour. The deterministic reasoner below is the reference
// implementation and the one the test suite uses, so Brain behaviour is
// verifiable without a network call, a key, or a quota.
//
// TRUST BOUNDARY
// A reasoner's output is UNTRUSTED. It is raw model text. It is never executed,
// never rendered into tool arguments directly, and never allowed to name a
// capability that the live registry does not expose. It is validated by
// interpretation.normalizeInterpretation, bound to real capabilities by
// capabilityPlanner, and only then planned by BrainRuntime — and actual
// execution always goes through TaskExecutor.

const { normalizeInterpretation, TASK_TYPES, RESEARCH_MODES, FRESHNESS_REQUIREMENTS,
  TEMPORAL_REQUIREMENTS, CONVERSATION_RELATIONS } = require('./interpretation');

/** The machine-readable contract handed to the reasoner. */
const INTERPRETATION_CONTRACT = Object.freeze({
  type: 'object',
  required: ['goal', 'taskType', 'externalKnowledgeNeeded', 'preferredResearchMode',
    'conversationRelation', 'confidence', 'ambiguity'],
  properties: {
    goal: { type: 'string', description: "What the user actually wants, in their terms. e.g. 'understand the Paperclip project'." },
    taskType: { type: 'string', enum: TASK_TYPES },
    topic: { type: ['string', 'null'], description: 'The concrete subject, if any.' },
    entities: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'string' } } } },
    temporalRequirement: { type: 'string', enum: TEMPORAL_REQUIREMENTS },
    freshnessRequirement: { type: 'string', enum: FRESHNESS_REQUIREMENTS },
    externalKnowledgeNeeded: { type: 'boolean' },
    preferredResearchMode: { type: 'string', enum: RESEARCH_MODES },
    conversationRelation: { type: 'string', enum: CONVERSATION_RELATIONS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ambiguity: { type: 'number', minimum: 0, maximum: 1 },
    requiresClarification: { type: 'boolean' },
    candidateActions: {
      type: 'array',
      description: 'Only for action requests or explicitly named tools. Names are resolved against the live registry and still pass authorization.',
      items: { type: 'object', properties: { intent: { type: 'string' }, capability: { type: ['string', 'null'] }, rationale: { type: 'string' }, args: { type: 'object' } } },
    },
  },
});

/**
 * The decision prompt. It states the distinctions that were previously implicit
 * or absent — especially news vs. current-information research, which the
 * production prompt never mentioned at all.
 *
 * The prompt is a REASONING input, not a guarantee. The monotonic guard rails
 * in interpretation.js enforce the news rule independently, so a model that
 * ignores this prompt still cannot turn "getting viral nowadays" into news.
 */
const buildDecisionSystemPrompt = ({ hasPriorTopic, hasPriorNews, correction } = {}) => `
You are the DECISION layer of ARC, an intelligent agent. You do not answer the
user. You decide what the user wants, so the agent can plan correctly.

Return ONE JSON object matching the supplied contract. No prose, no markdown.

Classify the user's actual goal, not the vocabulary they used.

CRITICAL DISTINCTIONS

1. current_news vs. current_web_research vs. topic_research
   - current_news: the user explicitly asks for news, headlines, or a news
     briefing. Examples: "top headlines", "today's news", "latest news about X",
     "what's in the news", "any breaking news".
   - web_research / topic_research: the user wants to UNDERSTAND a subject.
     Examples: "tell me about X", "what is X", "research X", "look up this
     company", "find information about this project", "what is X project?",
     "what's happening with X" (as a subject, not a news ask).
   - A subject being viral, trending, popular, hot, recent, "getting attention",
     "blowing up", or "nowadays" is a FRESHNESS CUE. It means the answer should
     be up to date. It does NOT mean the user wants a news briefing.
     "tell me about the Paperclip project which is getting viral nowadays in
     tech" is topic_research with moderate freshness — NEVER current_news.
   - Only choose current_news when the user's own words ask for news/headlines.

2. knowledge vs. retrieval
   - Stable textbook knowledge ("what is recursion?") needs no tool. Answer from
     your own knowledge. Set externalKnowledgeNeeded=false.
   - Anything about a real project, company, person, product, or recent state of
     the world needs retrieval. Set externalKnowledgeNeeded=true.

3. conversationRelation
   - new_task: the user introduces a subject of their own. Even if the previous
     turn was news, a new subject is a NEW TASK. Never inherit a task type.
   - continuation / refinement: the message has no subject of its own and refers
     back ("more", "and?", "in India", "why?").
   - correction: the user is objecting to the previous hypothesis.
${correction ? '   - The user is CORRECTING the previous turn. Discard the previous hypothesis entirely and re-plan from scratch.' : ''}
${hasPriorTopic ? `   - The previous subject was: "${hasPriorTopic}". This is CONTEXT, not a command. It may be inherited ONLY by a message with no subject of its own.` : ''}
${hasPriorNews ? '   - The previous turn was a NEWS request. That must not leak into a new task.' : ''}

4. action_request
   - Use it when the user wants ARC to DO something ("send this email", "remind
     me at 5", "change the theme"). Name the capability in candidateActions.
     Actions are always executed through the governed substrate; you are only
     proposing.

5. requiresClarification
   - Set it only when genuinely ambiguous AND the ambiguity would change the
     plan. "tell me about it" with no prior subject qualifies. Ordinary
     vagueness does not.
`.trim();

/** Builds the user-side message: the utterance plus minimal, sanitized state. */
const buildDecisionUserPrompt = ({ userText, relation, priorTopic, priorTaskType, pendingClarification }) => {
  const lines = [`USER MESSAGE: ${String(userText || '').trim()}`];
  lines.push(`RELATION TO PREVIOUS TURN: ${relation}`);
  if (relation === 'refinement' || relation === 'continuation') {
    if (priorTopic) lines.push(`INHERITED SUBJECT (the user said no subject of their own): ${priorTopic}`);
  } else {
    if (priorTopic) lines.push(`PREVIOUS SUBJECT (context only, do not inherit): ${priorTopic}`);
    if (priorTaskType) lines.push(`PREVIOUS TASK TYPE (context only, do not inherit): ${priorTaskType}`);
  }
  if (pendingClarification) {
    lines.push(`PENDING CLARIFICATION: ${pendingClarification.question || '(unspecified)'}`);
  }
  lines.push('');
  lines.push('Return the JSON decision object now.');
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Deterministic reasoner (reference implementation + test double).
//
// This is NOT the production classifier. It is a small, honest baseline that
// makes the Brain's orchestration testable and gives the runtime something
// sane when no provider is available. It is intentionally conservative: when
// it is not confident it says so via low confidence / requiresClarification
// rather than inventing a plan.
// ---------------------------------------------------------------------------

const DETERMINISTIC_RULES = [
  {
    // Explicit action verbs with a known governed capability.
    re: /\b(send|email)\b.*\b(email|mail|message)\b|\bsend\s+(an?\s+)?(email|mail|message)\b/i,
    build: () => ({
      goal: 'perform a requested action',
      taskType: 'action_request',
      externalKnowledgeNeeded: false,
      preferredResearchMode: 'native_capability',
      candidateActions: [{ intent: 'action', capability: 'sendEmail', rationale: 'user asked to send an email' }],
    }),
  },
  {
    re: /\bremind me\b|\bset (a )?reminder\b|\bcreate a reminder\b/i,
    build: () => ({
      goal: 'create a reminder',
      taskType: 'action_request',
      externalKnowledgeNeeded: false,
      preferredResearchMode: 'native_capability',
      candidateActions: [{ intent: 'action', capability: 'createReminder', rationale: 'user asked for a reminder' }],
    }),
  },
  {
    re: /\b(what('s| is) the time|what time is it|current time)\b/i,
    build: () => ({ goal: 'get the current time', taskType: 'knowledge', externalKnowledgeNeeded: false, preferredResearchMode: 'native_capability', candidateActions: [{ intent: 'local_time', capability: 'getTime' }] }),
  },
  {
    re: /\b(weather|forecast|temperature)\b/i,
    build: () => ({ goal: 'check the weather', taskType: 'knowledge', externalKnowledgeNeeded: true, preferredResearchMode: 'native_capability', candidateActions: [{ intent: 'weather', capability: 'getWeather' }] }),
  },
  {
    // A greeting is a WHOLE utterance, never a prefix. "ok can you provide me
    // detailed information about X" opens with "ok" and is emphatically not a
    // greeting; treating a leading acknowledgement as one is how a real request
    // gets answered with small talk.
    re: /^\s*(hi|hey|hello|yo|sup|good\s+(morning|evening|afternoon)|thanks|thank\s+you|ok|okay|cool|nice|awesome|great|bye|goodbye|see\s+you|how\s+are\s+you)\b[\s!.?,]*$/i,
    build: () => ({ goal: 'converse', taskType: 'conversation', externalKnowledgeNeeded: false, preferredResearchMode: 'none' }),
  },
  {
    // EXPLICIT news demand. This is the only way the baseline will ever choose
    // current_news, and it requires the words "news"/"headline" in the user's
    // own message. Popularity cues never reach this rule: "getting viral",
    // "trending", "nowadays" and "popular" are evidence of interest, not a
    // request for headlines, and this is the exact confusion that sent a
    // Paperclip question to getTopNews forever.
    re: /\b(news|headlines?)\b/i,
    build: (text) => {
      const scope = extractNewsScope(text);
      return {
        goal: scope.topic
          ? `current news about ${scope.topic}`
          : scope.region
            ? `current news for ${scope.region}`
            : 'current news',
        taskType: 'current_news',
        topic: scope.topic || null,
        region: scope.region || null,
        freshnessRequirement: 'high',
        externalKnowledgeNeeded: true,
        preferredResearchMode: 'current_news',
        confidence: scope.topic || scope.region ? 0.85 : 0.65,
        ambiguity: scope.topic || scope.region ? 0.1 : 0.35,
      };
    },
  },
  {
    // Definitional question with a common-noun subject: "what is recursion?",
    // "what is an API?". A model can answer this from its own knowledge, so a
    // web lookup would be a pointless round trip. Capitalization is used as a
    // weak proper-noun signal: "what is Paperclip?" is a question about a
    // specific entity, so it still goes to research. The production LLM reasoner
    // does this properly; this is the honest limit of the baseline.
    re: /^\s*(?:what|whats|what's|explain)\s+(?:is|are|was|were)\s+(?:an?|the)?\s*([A-Za-z][A-Za-z-]{2,30})\s*\??\s*$/,
    build: (text) => {
      const m = text.match(/^\s*(?:what|whats|what's|explain)\s+(?:is|are|was|were)\s+(?:an?|the)?\s*([A-Za-z][A-Za-z-]{2,30})\s*\??\s*$/);
      const word = m ? m[1] : null;
      const topical = /\b(viral|trending|popular|nowadays|recently|currently|right now|these days|latest|today|now|this week|2025|2026|launch|release|acquire|acquisition|funding|news|headlines|update|price|stock|version)\b/i.test(text);
      if (!word || topical) return null;
      // Capitalization decides entity vs. concept. "recursion" and "API" are
      // concepts a model can define outright; "Paperclip" is a specific entity
      // whose details must be looked up rather than recalled.
      const isProperNoun = /^[A-Z]/.test(word) && !/^[A-Z0-9]+$/.test(word);
      if (isProperNoun) return null;
      return {
        goal: `explain ${word}`,
        taskType: 'knowledge',
        topic: word,
        freshnessRequirement: 'none',
        externalKnowledgeNeeded: false,
        preferredResearchMode: 'none',
        confidence: 0.7,
        ambiguity: 0.2,
      };
    },
  },
];

const createDeterministicReasoner = () => ({
  name: 'deterministic',
  async interpret({ userText, relation, priorTopic, priorTaskType, options = {} }) {
    const text = String(userText || '').trim();

    // A correction always starts from scratch; prior scope is discarded.
    //
    // "i just asked about paperclip project" is meta-language about the request,
    // not the request. Strip the meta-language, then extract the real subject —
    // otherwise the correction re-plans the previous topic all over again.
    if (relation === 'correction') {
      const stripped = text
        .replace(CORRECTION_META_RE, '')
        .replace(/^\s*(?:no|nope|nah|actually|also|again|but)\b[\s,]*/i, '')
        .replace(/\s*(?:not\s+what\s+i\s+(?:meant|asked)|as\s+i\s+(?:said|mentioned))\s*$/i, '')
        .trim();
      const topic = extractSubject(stripped) || (stripped.length > 2 && stripped.length <= 80 ? stripped : null);
      return {
        ok: true,
        candidate: {
          goal: topic ? `understand ${topic}` : null,
          taskType: topic ? 'topic_research' : 'clarification',
          topic,
          externalKnowledgeNeeded: Boolean(topic),
          preferredResearchMode: topic ? 'general_web' : 'none',
          conversationRelation: 'correction',
          confidence: topic ? 0.6 : 0.2,
          ambiguity: topic ? 0.3 : 0.9,
          requiresClarification: !topic,
        },
        problems: [],
      };
    }

    for (const rule of DETERMINISTIC_RULES) {
      if (!rule.re.test(text)) continue;
      // A rule may decline a match it recognized (e.g. a proper noun it does not
      // want to answer from memory). Declining must fall through to the next
      // rule, not terminate the loop with an empty interpretation.
      const built = rule.build(text);
      if (!built) continue;
      // Defaults come first so a rule that states its own confidence wins.
      return {
        ok: true,
        candidate: { confidence: 0.85, ambiguity: 0.1, conversationRelation: relation, ...built },
        problems: [],
      };
    }

    // A subject-less follow-up inherits the subject, never the task type.
    if (relation === 'refinement' || relation === 'continuation') {
      return {
        ok: true,
        candidate: {
          goal: priorTopic ? `more about ${priorTopic}` : 'continue the previous answer',
          taskType: priorTaskType || 'knowledge',
          topic: priorTopic || null,
          externalKnowledgeNeeded: Boolean(priorTopic),
          preferredResearchMode: priorTopic ? (priorTaskType === 'current_news' ? 'current_news' : 'general_web') : 'none',
          conversationRelation: relation,
          confidence: priorTopic ? 0.6 : 0.2,
          ambiguity: priorTopic ? 0.35 : 0.9,
        },
        problems: [],
      };
    }

    // Otherwise: is there a subject worth researching?
    const topic = extractSubject(text);
    if (topic) {
      return {
        ok: true,
        candidate: {
          goal: `understand ${topic}`,
          taskType: 'topic_research',
          topic,
          freshnessRequirement: /\b(viral|trending|popular|nowadays|recently|right now|currently|these days)\b/i.test(text) ? 'moderate' : 'low',
          externalKnowledgeNeeded: true,
          preferredResearchMode: 'general_web',
          conversationRelation: 'new_task',
          confidence: 0.7,
          ambiguity: 0.3,
        },
        problems: [],
      };
    }

    return {
      ok: true,
      candidate: {
        goal: text ? 'clarify the request' : null,
        taskType: 'clarification',
        externalKnowledgeNeeded: false,
        preferredResearchMode: 'none',
        conversationRelation: relation,
        confidence: 0.2,
        ambiguity: 0.9,
        requiresClarification: true,
      },
      problems: [],
    };
  },
});

// Subject extraction for the baseline.
//
// A naive stop-word loop breaks on real phrasings: in "ok can you provide me
// detailed information about paperclip which is getting viral", the first token
// is "ok", which is not a stop word, so the loop stops immediately and the
// "subject" becomes "ok". So the scaffolding is stripped from the FRONT first
// (acknowledgements, politeness, the request verb phrase), and only then is the
// subject taken, terminating at the first genuine stop word.
const LEAD_ACK_RE = /^\s*(?:(?:ok|okay|hey|hi|hello|so|well|now|please|pls|also|and|but|um+|uh+|hmm+|right)\b[\s,!.]*)+/i;
const LEAD_POLITE_RE = /^\s*(?:(?:can|could|would|will|do|does|did)\s+(?:you|u)\b[\s,]*)+/i;
const LEAD_SUBJECTIVE_RE = /^\s*(?:i\s+(?:want|need|would\s+like|'?d\s+like|am)\s+(?:to|you\s+to)\b[\s]*)+/i;
const REQUEST_VERB_RE = new RegExp(
  '^\\s*(?:' + [
    'tell\\s+me\\s+(?:all\\s+)?about',
    'give\\s+me\\s+(?:some\\s+|detailed\\s+|a\\s+detailed\\s+|more\\s+|brief\\s+)*(?:information|info|details?|background|context|overview)\\s*(?:on|about|for)?',
    'provide\\s+me\\s+(?:with\\s+)?(?:some\\s+|detailed\\s+|a\\s+detailed\\s+|more\\s+|brief\\s+)*(?:information|info|details?|background|context|overview)\\s*(?:on|about|for)?',
    'show\\s+me',
    'find\\s+(?:me\\s+)?(?:some\\s+|detailed\\s+|more\\s+)*(?:information|info|details?|background|context|overview)?\\s*(?:on|about|for)?',
    'search\\s+(?:the\\s+web\\s+)?(?:for|about)',
    'look\\s+up',
    'research',
    'explain',
    'describe',
    'details?\\s*(?:on|about|for)',
    '(?:information|info|details?|background|context|overview)\\s*(?:on|about|for)',
    'more\\s*(?:on|about|for)',
    'what(?:\\u2019|\\x27s|s|\\s+is|\\s+are)?',
    'whats',
    'who(?:\\u2019|\\x27s|s|\\s+is|\\s+are)?',
    'tell\\s+me',
    'give\\s+me',
    'let\\s+me\\s+know\\s+about',
  ].join('|') + ')\\b',
  'i',
);

const SUBJECT_STOP = new Set([
  'a', 'an', 'the', 'of', 'for', 'on', 'in', 'is', 'are', 'was', 'were', 'and', 'to',
  'with', 'that', 'this', 'it', 'its', 'they', 'them', 'us', 'me', 'my', 'i', 'about',
  'which', 'who', 'how', 'do', 'does', 'did', 'be', 'been', 'has', 'have',
  'had', 'get', 'got', 'make', 'made', 'know', 'think', 'want', 'need', 'like',
  'project', 'thing', 'stuff', 'information', 'info', 'details', 'detail', 'overview',
  'background', 'context', 'update', 'updates', 'nowadays', 'recently', 'currently',
  'viral', 'trending', 'popular', 'getting', 'right', 'these', 'days', 'everything',
  'something', 'anything', 'there', 'here', 'can', 'could', 'would', 'will', 'you',
  'please', 'ok', 'okay', 'hey', 'hi', 'so', 'well', 'now', 'also', 'but', 'very',
  'really', 'just', 'tell', 'give', 'show', 'find', 'search', 'look', 'research',
  'explain', 'describe', 'provide', 'compare', 'vs', 'more', 'still', 'any', 'some',
  'all', 'anymore', 'else',
  // time words: "what happened with Paperclip today" -> Paperclip
  'today', 'yesterday', 'tomorrow', 'tonight', 'morning', 'evening', 'afternoon',
  'last', 'past', 'first', 'latest', 'breaking', 'recent', 'current', 'this', 'that',
  // research adverbs: "research Paperclip deeply" -> Paperclip
  'deeply', 'deep', 'thoroughly', 'thorough', 'detailed', 'properly', 'carefully',
  'quickly', 'fully', 'seriously', 'rigorously',
  // frame verbs left over from "what happened with X" / "what's up with X"
  'happened', 'happening', 'up', 'new', 'going',
]);

// Frames that sit between the request verb and the real subject.
const SUBJECT_FRAME_RE = new RegExp(
  '^\\s*(?:' + [
    '(?:happened|happening|goes|went|going|is\\s+happening)\\s+(?:with|to|on|in|around)',
    '(?:up|new|going\\s+on)\\s+(?:with|on)\\s+',
    'the\\s+(?:project|company|person|tool|repo|repository|product|startup|tech|technology|thing|app|service)\\s+(?:called|named)?',
  ].join('|') + ')\\b',
  'i',
);

// Meta-language about the request itself, used only by the correction branch.
const CORRECTION_META_RE = new RegExp(
  '^\\s*(?:' + [
    'i\\s+(?:just\\s+)?(?:meant|asked\\s+about|said\\s+about|was\\s+asking\\s+about|asked)',
    'that\\u2019?s\\s+not',
    'not\\s+what\\s+i\\s+(?:meant|asked|was\\s+asking)',
    'do\\s+not\\s+mean',
    'i\\s+don\\u2019?t\\s+mean',
  ].join('|') + ')\\b',
  'i',
);

const RESEARCH_ADVERB_RE =
  /^\s*(?:deeply|deep|thoroughly|thorough|detailed|properly|carefully|quickly|fully|seriously|rigorously)\b/i;

// News scope extraction, used only by the explicit-news branch.
const NEWS_TOPIC_FRAME_RE = new RegExp(
  '^\\s*(?:' + [
    // Allow stacked modifiers: "today's top headlines", "latest breaking news".
    '(?:the\\s+)?(?:(?:latest|breaking|recent|today\\u2019?s?|top|current|big|local|all)\\s+){1,2}(?:news|headlines?|updates?|stories|developments?)',
    '(?:news|headlines?|updates?|stories)\\s*(?:about|on|regarding|for|of|in|around)?',
  ].join('|') + ')\\b',
  'i',
);

const extractSubject = (text) => {
  let s = String(text || '').replace(/[?!.]+$/g, '').trim();
  if (!s) return null;

  // Strip leading scaffolding, longest-first, and re-apply until stable.
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(LEAD_ACK_RE, '').replace(LEAD_POLITE_RE, '').replace(LEAD_SUBJECTIVE_RE, '');
    s = s.replace(REQUEST_VERB_RE, '').trim();
    if (s === before) break;
  }
  s = s.replace(/^[\s,.:;-]+/, '').trim();
  if (!s) return null;

  // Then drop the frame words that sit between the verb and the noun.
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(SUBJECT_FRAME_RE, '').replace(RESEARCH_ADVERB_RE, '').trim();
    if (s === before) break;
  }
  s = s.replace(/^[\s,.:;-]+/, '').trim();
  if (!s) return null;

  const words = s.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9'-]+|[^A-Za-z0-9'-]+$/g, '')).filter(Boolean);
  const kept = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (SUBJECT_STOP.has(lower)) {
      if (kept.length >= 1) break; // a stop word AFTER content ends the subject
      continue; // leading filler: skip
    }
    kept.push(w);
    if (kept.length >= 6) break;
  }
  const subject = kept.join(' ').trim();
  if (subject.length < 3 || subject.length > 80) return null;
  return subject;
};

/**
 * Topic/region for an explicit news ask: "latest news about Paperclip" ->
 * topic Paperclip; "top headlines in India" -> region India.
 * Returns {} when the ask is not a scoped news request.
 */
const extractNewsScope = (text) => {
  let s = String(text || '').replace(/[?!.]+$/g, '').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(LEAD_ACK_RE, '').replace(LEAD_POLITE_RE, '').trim();
    s = s.replace(NEWS_TOPIC_FRAME_RE, '').replace(REQUEST_VERB_RE, '').trim();
    if (s === before) break;
  }
  s = s.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
  if (!s) return {};
  const KNOWN_REGIONS = ['india', 'us', 'usa', 'uk', 'world', 'tech', 'technology', 'science', 'business', 'sports', 'finance', 'markets', 'europe', 'asia', 'africa', 'canada', 'australia'];
  const lower = s.toLowerCase();
  if (KNOWN_REGIONS.includes(lower)) return { region: s };
  if (s.split(/\s+/).length === 1 && KNOWN_REGIONS.includes(lower.replace(/s$/, ''))) return { region: s };
  const regionMatch = s.match(/\bin\s+([A-Za-z][A-Za-z ]{1,20})$/);
  if (regionMatch && KNOWN_REGIONS.includes(regionMatch[1].trim().toLowerCase())) {
    return { region: regionMatch[1].trim() };
  }
  const topic = extractSubject(s);
  return topic ? { topic } : {};
};

/**
 * Wrap any reasoner so its output is always normalized. A reasoner that throws,
 * returns prose, or returns garbage yields a safe low-confidence
 * interpretation instead of breaking the turn.
 */
const guardReasoner = (inner) => ({
  name: `guarded:${inner?.name || 'anonymous'}`,
  async interpret(ctx) {
    let raw;
    try {
      raw = await inner.interpret(ctx);
    } catch (error) {
      return {
        ok: false,
        candidate: null,
        problems: [`reasoner_threw:${String(error?.message || error).slice(0, 80)}`],
        fallback: true,
      };
    }
    if (!raw || typeof raw !== 'object') {
      return { ok: false, candidate: null, problems: ['reasoner_returned_non_object'], fallback: true };
    }
    const normalized = normalizeInterpretation(raw.candidate, {
      userText: ctx?.userText,
    });
    // The reasoner's own complaints ("provider unavailable", "unparseable")
    // must survive normalization. Dropping them would hide every provider
    // failure behind a clean-looking interpretation and make the fallback
    // invisible in observability.
    const problems = [...(Array.isArray(raw.problems) ? raw.problems : []), ...normalized.problems];
    // The reasoner may state its own relation; the state's ruling wins when
    // the reasoner disagrees about a correction, because a correction must
    // always discard prior scope.
    const relation = ctx?.relation === 'correction' ? 'correction' : normalized.interpretation.conversationRelation;
    normalized.interpretation.conversationRelation = relation;
    return { ok: normalized.ok, candidate: normalized.interpretation, problems: [...new Set(problems)] };
  },
});

module.exports = {
  INTERPRETATION_CONTRACT,
  buildDecisionSystemPrompt,
  buildDecisionUserPrompt,
  createDeterministicReasoner,
  guardReasoner,
  extractSubject,
};
