'use strict';

// Deterministic fast decision path.
//
// Pure, cheap, and conservative: it answers ONLY the questions it can answer
// conclusively, and stays silent (certain: false) otherwise so Jev — or the
// legacy ARC routing — decides. No giant regex machine: a bounded greeting
// vocabulary for the conversational case and a curated capability-verb list
// for the tool case.
//
// Safety rules:
//   - a pending tool-call, an active working-state surface, or an attached
//     document/image ALWAYS disables the fast path (continuations and
//     multimodal requests are resolved by the full pipeline, never guessed);
//   - the no-tool verdict is only emitted for unmistakable chit-chat.

const { buildDecisionResult } = require('./decisionTypes');

const normalizeText = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Unmistakable conversational chit-chat. Full-phrase matches only; short
// acknowledgment tokens ("ok", "yes", "thanks") are deliberately excluded
// because they can answer a pending clarification and would wrongly skip the
// tool path mid-flow.
const GREETING_PHRASES = new Set([
  'hello', 'hello there', 'hi', 'hi there', 'hey', 'heya', 'hey there', 'hiya',
  'howdy', 'yo', 'hola', 'sup', 'wassup', 'whats up', 'whats up?',
  'what is up', 'how are you', 'how are you doing', 'how are things',
  'how are things going', 'hows it going', 'how is it going', 'how do you do',
  'are you there', 'can you hear me', 'do you hear me', 'are you awake',
  'you there', 'anybody there', 'is anyone there', 'hello world', 'test',
  'testing', 'testing 123', 'test test', 'just testing', 'thanks',
  'thank you', 'thank you so much', 'thanks a lot', 'thanks so much',
  'many thanks', 'thx', 'ty', 'good morning', 'good afternoon', 'good evening',
  'good night', 'goodnight', 'bye', 'bye bye', 'goodbye', 'see you',
  'see you later', 'see ya', 'cya', 'good talk', 'nice to meet you',
  'pleased to meet you', 'have a good day', 'have a nice day',
  'have a great day', 'take care', 'talk to you later', 'good job',
  'well done', 'ok thanks', 'ok thank you', 'hi how are you',
  'hello how are you', 'hey how are you', 'lot of fun', 'thats all',
  'thats it', 'nothing else', 'no thank you', 'no thanks', 'yes please'
]);

const hasGreeting = (text) => GREETING_PHRASES.has(normalizeText(text));

// Obvious knowledge/explanation questions ("what is React?", "explain
// JavaScript closures"). Bounded, conservative: a fixed question opener plus
// content, and ownership/workspace/doc/time terms EXCLUDE the fast path so a
// personal lookup ("what is my deadline?", "what is in the document?") never
// skips the tool pipeline by accident. Tool signals are still checked first
// and always win (e.g. "what is the weather in London" → tool path).
const KNOWLEDGE_OPENERS = [
  'what is ', 'what is a ', 'what are ', 'what does ', 'what do ', 'whats ',
  'who is ', 'who are ', 'where is ', 'where are ', 'when is ', 'when are ',
  'why is ', 'why are ', 'how does ', 'how do ', 'how is ', 'how are ',
  'explain ', 'define ', 'describe ', 'tell me about '
];
const KNOWLEDGE_EXCLUDERS = /(^|\s)(my|project|projects|document|documents|file|files|page|pages|issue|issues|ticket|tickets|task|tasks|deadline|account|billing|workspace|settings|profile|status|error|report|reports|data|time|meeting|meetings|event|events)\b/;

const hasKnowledgeQuestion = (text) => {
  const lower = String(text || '').toLowerCase();
  if (KNOWLEDGE_EXCLUDERS.test(lower)) return false;
  return KNOWLEDGE_OPENERS.some((o) => lower.startsWith(o));
};

// Curated capability verbs/surfaces. These are unambiguously external-action
// phrasings tied to ARC's capability surfaces; matching any of them forces
// the normal tool/MCP path deterministically (Jev is not needed).
const TOOL_PATTERNS = [
  // external integrations / MCP
  /(linear|notion|jira|slack|monday|asana|clickup)\b/,
  /(create|make|open|close|update|delete|rename|archive|list|show|fetch|get|search|find)\s+(my\s+)?(linear|notion|issue|issues|project|projects|task|tasks|page|pages|ticket|tickets|doc|docs|note|notes)\b/,
  // calendar
  /\b(schedule|book|reschedule|cancel)\b.*\b(meeting|event|appointment|call|calls)\b/,
  /\b(check|show|see|look at|find)\b.*\b(my\s+)?(calendar|availability|free time|schedule)\b/,
  /\b(what meetings|whats on my calendar|what is on my calendar|am i free)\b/,
  // messaging / email / WhatsApp
  /\b(send|text|message|forward|email)\b/,
  /\bwhatsapp\b/,
  // web / real-time data
  /\b(search the web|web search|search online|google that|search for)\b/,
  /\b(get|check|what is|whats|what\'s|current|today|tomorrow|now)\b.*\b(weather|time in|news|stock|price|score)\b/,
  // media
  /\b(play|pause|resume|stop|skip|seek|shuffle|queue)\b.*\b(music|song|track|playlist|video|album|artist)\b/,
  /\b(set|add|create|remove|delete)\b.*\b(reminder|alarm|timer|todo|task|event)\b/,
  // code execution
  /\b(run|execute|compile|debug)\b.*\b(code|script|program|shell|command|function)\b/,
  // browser / device
  /\b(open|navigate to|go to)\b.*\b(website|url|site|page|browser|link|youtube)\b/
];

const hasToolSignal = (text) => {
  const lower = String(text || '').toLowerCase();
  return TOOL_PATTERNS.some((re) => re.test(lower));
};

// Bring the working-state indicator through: any active surface means a
// possible continuation ("play the slower version", "update that page",
// "send the second result") so the request must resolve through the normal
// pipeline.
const hasActiveWorkingState = (workingState) => {
  if (!workingState || typeof workingState !== 'object') return false;
  return ['activeMedia', 'activeSearch', 'activeResource', 'activeTask'].some((k) => workingState[k] != null);
};

// Operation guess for deterministic tool decisions (advisory only; the MCP
// planner remains authoritative).
const guessOperation = (text) => {
  const lower = String(text || '').toLowerCase();
  if (/\b(calendar|meeting|event|appointment|schedule|availability)\b/.test(lower)) return 'calendar';
  if (/\b(whatsapp|message|send|text|email)\b/.test(lower)) return 'messaging';
  if (/\b(weather|news|stock|price|search the web|web search|online)\b/.test(lower)) return 'search';
  if (/\b(music|song|playlist|video|media)\b/.test(lower)) return 'media';
  if (/\b(run|execute|code|script|function)\b/.test(lower)) return 'code';
  if (/\b(linear|notion|jira|slack|issue|project|page|doc)\b/.test(lower)) return 'mcp';
  return 'other';
};

// Pure classifier. Returns:
//   { certain: true, decision }  – deterministic, high-confidence verdict
//   { certain: false, reason }   – defer to the next layer
const classify = ({
  request = '',
  query = '',
  workingState = null,
  pendingTool = null,
  hasAttachment = false
} = {}) => {
  try {
    const hasPending = Boolean(pendingTool && (typeof pendingTool.toolName === 'string' || typeof pendingTool.tool === 'string'));
    const activeState = hasActiveWorkingState(workingState);
    if (hasAttachment || hasPending || activeState) {
      // Cannot answer conclusively; never guess on continuations/multimodal.
      return { certain: false, reason: hasAttachment ? 'attachment' : (hasPending ? 'pending-tool' : 'active-state') };
    }

    const current = String(request || '');
    const selectionQuery = String(query || '');
    const toolSignal = hasToolSignal(selectionQuery || current);

    if (toolSignal) {
      const op = guessOperation(selectionQuery || current);
      return {
        certain: true,
        decision: buildDecisionResult({
          needsExternalCapability: { value: true, probability: 1 },
          operation: { value: op, probability: 1 },
          risk: {},
          needsConfirmation: {},
          provider: 'deterministic',
          latencyMs: 0,
          confidence: 1,
          reason: 'deterministic-tool-signal'
        })
      };
    }

    if (hasGreeting(current)) {
      return {
        certain: true,
        decision: buildDecisionResult({
          needsExternalCapability: { value: false, probability: 1 },
          operation: { value: 'chat', probability: 1 },
          risk: { value: 0, probability: 1 },
          needsConfirmation: { value: false, probability: 1 },
          provider: 'deterministic',
          latencyMs: 0,
          confidence: 1,
          reason: 'deterministic-greeting'
        })
      };
    }

    if (hasKnowledgeQuestion(current)) {
      return {
        certain: true,
        decision: buildDecisionResult({
          needsExternalCapability: { value: false, probability: 1 },
          operation: { value: 'chat', probability: 1 },
          risk: { value: 0, probability: 1 },
          needsConfirmation: { value: false, probability: 1 },
          provider: 'deterministic',
          latencyMs: 0,
          confidence: 1,
          reason: 'deterministic-knowledge'
        })
      };
    }

    return { certain: false, reason: 'uncertain' };
  } catch {
    // The classifier must never throw into the request path.
    return { certain: false, reason: 'classifier-error' };
  }
};

module.exports = {
  normalizeText,
  hasGreeting,
  hasToolSignal,
  hasKnowledgeQuestion,
  hasActiveWorkingState,
  guessOperation,
  classify
};