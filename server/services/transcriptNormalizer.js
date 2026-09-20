// Voice Runtime 4.0 — contextual speech-to-text normalization + safety.
//
// The browser only captures mic frames; the server owns transcription. The
// current Gemini unary transcription returns plain text with NO confidence
// scores or word alternatives, so this module is the authoritative
// "did we really hear that" layer. It is pure and deterministic:
//
//   buildVoiceContext(...)  -> bounded vocabulary context { terms, hints }
//   normalizeTranscript(...) -> { text, rawText, corrections,
//                                 needsClarification, lowConfidence,
//                                 destructive, reason }
//
// Scope (bounded on purpose):
//   * vocabulary is capped; edit-distance work is tiny.
//   * destructive commands always gate on explicit confirmation (§17).
//   * low-confidence corrections are flagged (§15) and, when severe, gated.
//
// No network, no credentials, no RNG. Requiring this module has no effects.
const toolsRegistry = () => {
  try {
    // Lazy: only loads the tool registry when the caller did not pass tools.
    // The registry auto-scans server/tools and logs plugin loads.
    const registry = require('../tools');
    return registry && registry.tools ? Object.keys(registry.tools) : [];
  } catch {
    return [];
  }
};

// ---- Destructive command vocabulary ---------------------------------------
const DESTRUCTIVE_VERBS = new Set([
  'delete', 'remove', 'erase', 'clear', 'drop', 'wipe', 'destroy', 'kill',
  'terminate', 'shutdown', 'shut', 'revoke', 'disable', 'uninstall', 'reset',
  'cancel', 'purge', 'silence', 'dismiss',
]);

const DESTRUCTIVE_RESOURCES = new Set([
  'conversation', 'chat', 'chats', 'message', 'messages', 'memory', 'memories',
  'repository', 'repositories', 'repo', 'repos', 'project', 'workspace',
  'account', 'server', 'database', 'db', 'email', 'emails', 'calendar',
  'meeting', 'meetings', 'event', 'events', 'reminder', 'reminders', 'alarm',
  'alarms', 'timer', 'timers', 'notification', 'notifications', 'token',
  'tokens', 'key', 'keys', 'file', 'files', 'task', 'tasks', 'browser',
  'tab', 'tabs', 'media', 'history', 'data', 'schedule', 'assignment',
  'context', 'reminder',
]);

// ---- Curated domain vocabulary ---------------------------------------------
// Each entry: canonical term plus spelling aliases users actually voice.
// Keeping this small and bounded keeps edit-distance work ~free.
const CURATED_VOCAB = [
  { term: 'ARC' },
  { term: 'ARC AI' },
  { term: 'GitHub', aliases: ['git hub'] },
  { term: 'Linear' },
  { term: 'Notion' },
  { term: 'React' },
  { term: 'MongoDB', aliases: ['mongo', 'mongo db', 'mongodb'] },
  { term: 'Node.js', aliases: ['node', 'nodejs', 'node js'] },
  { term: 'Socket.IO', aliases: ['socket io', 'socket'] },
  { term: 'WhatsApp', aliases: ['whats app', 'whatsapp'] },
  { term: 'Gemini' },
  { term: 'Gmail', aliases: ['g mail'] },
  { term: 'Google Calendar', aliases: ['google calendar', 'gcal'] },
  { term: 'Calendar', aliases: ['calandar', 'calender', 'calenders'] },
  { term: 'Pinecone' },
  { term: 'Slack' },
  { term: 'Discord' },
  { term: 'YouTube', aliases: ['you tube'] },
  { term: 'Spotify' },
  { term: 'README', aliases: ['read me'] },
  { term: 'repository', aliases: ['repo', 'repos', 'repositories', 'repositorry'] },
  { term: 'request', aliases: ['requist', 'requsts'] },
  { term: 'conversation', aliases: ['convo', 'conversations', 'conversation history'] },
  { term: 'workspace', aliases: ['workspaces'] },
  { term: 'dashboard', aliases: ['dash board'] },
  { term: 'pull request', aliases: ['pr', 'pull requests'] },
  { term: 'issue', aliases: ['issues', 'issuue'] },
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'can', 'could',
  'would', 'should', 'will', 'shall', 'do', 'does', 'did', 'have', 'has',
  'had', 'you', 'your', 'my', 'mine', 'me', 'i', 'we', 'our', 'this', 'that',
  'these', 'those', 'it', 'its', 'as', 'but', 'if', 'then', 'than', 'about',
  'please', 'just', 'ok', 'okay', 'hey', 'hi', 'hello',
]);

// Everyday English words that Speech-to-Text produces routinely. The recognizer
// essentially never needs a domain correction on these, and treating them as
// correction candidates turns common VAD transcripts (e.g. "what") into bad
// tool-name spellings. Symmetric: they are neither corrected nor used as target.
const COMMON_WORDS = new Set([
  'what', 'whats', 'whose', 'why', 'when', 'where', 'how', 'who', 'which',
  'them', 'there', 'their', 'here', 'hers', 'his', 'hers', 'yours', 'they',
  'some', 'any', 'each', 'both', 'few', 'many', 'much', 'more', 'most',
  'other', 'another', 'such', 'own', 'same', 'than', 'too', 'very', 'once',
  'often', 'always', 'sometimes', 'never', 'again', 'ago', 'even', 'only',
  'still', 'though', 'through', 'during', 'without', 'within', 'across',
  'along', 'around', 'before', 'after', 'between', 'also', 'really', 'today',
  'tomorrow', 'yesterday', 'now', 'then', 'soon', 'later', 'nothing',
]);

// ---- Edit distance (standard Levenshtein, O(n*m), bounded inputs) ----------
const editDistance = (a, b) => {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa === sb) return 0;
  const la = sa.length;
  const lb = sb.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (la > 60 || lb > 60) return Math.max(la, lb); // guard; vocab terms are short
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    const ca = sa.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j += 1) {
      const cost = ca === sb.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[lb];
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- Context builder --------------------------------------------------------
// Produces a bounded vocabulary: tool names, MCP/API server names, workspace
// tokens, recent conversation entities, plus the curated domain list.
const buildVoiceContext = ({
  tools = null,
  mcpServers = [],
  workspace = null,
  conversation = [],
  extraTerms = [],
  maxTerms = 80,
  includeCurated = true,
} = {}) => {
  const collect = new Map(); // lower -> canonical
  const add = (canonical) => {
    const key = String(canonical || '').trim().toLowerCase();
    if (!key || key.length < 2 || key.length > 40) return;
    if (!collect.has(key)) collect.set(key, String(canonical).trim());
  };

  if (includeCurated) {
    for (const entry of CURATED_VOCAB) {
      // Canonical terms only; spoken aliases are resolved by the correction
      // table (buildCorrectionTable reads CURATED_VOCAB directly).
      add(entry.term);
    }
  }

  const names = Array.isArray(tools) ? tools
    : (tools && typeof tools === 'object' ? Object.keys(tools) : toolsRegistry());
  for (const raw of names) {
    const name = String(raw || '');
    add(name);
    // "sendEmail" -> send / email (helps the recognizer with tool words).
    // Common words (e.g. "whats" from sendWhatsAppMessage) are excluded so the
    // vocab never competes with everyday speech.
    const words = name.replace(/([A-Z]+)/g, ' $1').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/);
    for (const w of words) {
      if (w.length < 3) continue;
      const lower = w.toLowerCase();
      if (STOPWORDS.has(lower) || COMMON_WORDS.has(lower)) continue;
      add(w);
    }
  }

  for (const server of mcpServers || []) {
    const name = String(typeof server === 'string' ? server : server?.name || '').trim();
    if (name) { add(name); add(name.replace(/[^a-zA-Z0-9]+/g, ' ').trim()); }
  }

  if (workspace) {
    for (const key of ['name', 'title']) {
      const value = String(workspace?.[key] || '').trim();
      if (value) {
        add(value);
        for (const w of value.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)) {
          const lower = w.toLowerCase();
          if (w.length < 3 || STOPWORDS.has(lower) || COMMON_WORDS.has(lower)) continue;
          add(w);
        }
      }
    }
  }

  const convoTermCount = Math.max(0, Math.floor(maxTerms / 8));
  let convoAdded = 0;
  for (const message of Array.isArray(conversation) ? conversation.slice(-4) : []) {
    if (convoAdded >= convoTermCount) break;
    const value = [message?.content, message?.text, message?.message].find((v) => typeof v === 'string');
    if (!value) continue;
    for (const raw of value.split(/\s+/)) {
      if (convoAdded >= convoTermCount) break;
      const w = raw.replace(/[^A-Za-z0-9]/g, '');
      if (!w || w.length < 4 || STOPWORDS.has(w.toLowerCase())) continue;
      // Prefer entities: capitalized words or long technical tokens.
      if (raw[0] && raw[0] !== raw[0].toLowerCase() || w.length >= 6) {
        add(w);
        convoAdded += 1;
      }
    }
  }

  for (const term of extraTerms || []) add(term);

  const terms = [...collect.values()];
  const bounded = terms.slice(0, Math.max(1, maxTerms));
  // `hints`: single + 2-word phrases only, for prompt-injection vocabulary.
  const hints = [];
  for (const term of bounded) {
    const words = term.split(/\s+/);
    if (words.length <= 2 && !/[^a-zA-Z0-9 .'-]/.test(term)) hints.push(term);
    if (hints.length >= Math.min(60, maxTerms)) break;
  }
  return { terms: bounded, hints };
};

// ---- Correction table -------------------------------------------------------
// termMap: exact vocabulary terms (surface spelling equals canonical).
// aliasMap: spoken variants -> canonical term (always canonicalized).
// phrase: 2-word surfaces (terms + aliases) matched on adjacent tokens.
const buildCorrectionTable = (terms) => {
  const termMap = new Map();
  const aliasMap = new Map();
  const phrase = new Map();
  for (const term of terms) {
    const lower = term.toLowerCase();
    termMap.set(lower, term);
    if (lower.split(/\s+/).length === 2) phrase.set(lower, term);
  }
  for (const entry of CURATED_VOCAB) {
    termMap.set(entry.term.toLowerCase(), entry.term);
    for (const alias of entry.aliases || []) {
      const a = alias.toLowerCase();
      aliasMap.set(a, entry.term);
      if (a.split(/\s+/).length === 2 && !phrase.has(a)) phrase.set(a, entry.term);
    }
  }
  return { termMap, aliasMap, phrase };
};

const acceptCorrection = (token, candidate, distance) => {
  const len = token.length;
  if (len < 4 || distance === 0) return false;
  const maxDist = len <= 5 ? 1 : (len <= 9 ? 2 : 3);
  if (distance > maxDist) return false;
  if (distance / len > 0.25) return false;
  void candidate;
  return true;
};

const correctionConfidence = (token, distance) => {
  const len = Math.max(token.length, 1);
  if (distance >= len) return 0.35;
  return clamp(1 - distance / len, 0.35, 0.98);
};

// Preserve the source token's casing style on the corrected token.
const fitCase = (token, corrected) => {
  if (!/[A-Z]/.test(token)) return String(corrected).toLowerCase();
  if (/^[A-Z]/.test(token) && !/[a-z]/.test(token.slice(1))) {
    const lower = String(corrected).toLowerCase();
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }
  return String(corrected).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
};

// ---- Transcript normalization ------------------------------------------------
// tokenize preserves whitespace/punctuation; only word tokens are considered.
const TOKEN_SPLIT_RE = /(\s+|[.,;!?()"'])/;

const normalizeTranscript = (text, context = null) => {
  const rawText = String(text || '');
  const ctx = context || buildVoiceContext();
  const { termMap, aliasMap, phrase } = buildCorrectionTable(ctx.terms);

  const corrections = [];
  const parts = rawText.split(TOKEN_SPLIT_RE);
  const isWord = (part) => /^[A-Za-z0-9][A-Za-z0-9'-]*$/.test(part);

  let lowConfidence = false;
  let minCorrectionConfidence = 1;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!isWord(part)) continue;
    const lower = part.toLowerCase();

    // multi-word phrase first (current word + next word, whitespace only)
    let nextWord = i + 1;
    while (nextWord < parts.length && !isWord(parts[nextWord]) && /^\s+$/.test(parts[nextWord])) nextWord += 1;
    if (nextWord < parts.length && isWord(parts[nextWord])) {
      const phraseKey = `${lower} ${parts[nextWord].toLowerCase()}`;
      if (phrase.has(phraseKey)) {
        const canonical = phrase.get(phraseKey);
        corrections.push({ from: `${part} ${parts[nextWord]}`, to: canonical, confidence: 1 });
        parts[i] = canonical;
        parts[nextWord] = '';
        i = nextWord;
        continue;
      }
    }

    if (termMap.has(lower)) continue; // exact vocab term — no correction
    if (STOPWORDS.has(lower) || COMMON_WORDS.has(lower)) {
      // Everyday speech: never "correct" it into a domain term, and never use
      // it as a correction candidate.
      continue;
    }

    if (aliasMap.has(lower)) {
      // Spoken variant of a domain term — canonicalize with full confidence.
      const canonical = aliasMap.get(lower);
      corrections.push({ from: part, to: canonical, confidence: 1 });
      parts[i] = canonical;
      continue;
    }

    // nearest candidate by edit distance over canonical terms
    let bestCanonical = null;
    let bestDistance = Infinity;
    for (const [candidateLower, canonical] of termMap) {
      const distance = editDistance(lower, candidateLower);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCanonical = canonical;
      } else if (distance === bestDistance && candidateLower === lower) {
        bestCanonical = canonical;
      }
    }
    if (!bestCanonical || bestDistance === 0) continue;
    if (!acceptCorrection(lower, bestCanonical, bestDistance)) continue;
    const confidence = correctionConfidence(lower, bestDistance);
    const canonicalWords = String(bestCanonical).split(/\s+/);
    const replacement = canonicalWords.length > 1
      ? fitCase(part, canonicalWords[0]) + ' ' + canonicalWords.slice(1).join(' ')
      : fitCase(part, bestCanonical);
    corrections.push({ from: part, to: replacement, confidence: Number(confidence.toFixed(2)) });
    if (confidence < 0.8) lowConfidence = true;
    if (confidence < minCorrectionConfidence) minCorrectionConfidence = confidence;
    parts[i] = replacement;
  }

  const resultText = parts.join('').replace(/[ \t]+/g, ' ').trim();
  const tokens = resultText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  // ---- Destructive detection -------------------------------------------------
  let destructive = null;
  for (let i = 0; i < tokens.length; i += 1) {
    if (!DESTRUCTIVE_VERBS.has(tokens[i])) continue;
    let target = null;
    let targetConfidence = 0;
    for (let j = i + 1; j < Math.min(i + 5, tokens.length); j += 1) {
      if (STOPWORDS.has(tokens[j]) || DESTRUCTIVE_VERBS.has(tokens[j])) continue;
      if (DESTRUCTIVE_RESOURCES.has(tokens[j])) {
        target = tokens[j];
        // exact resource match on a vocabulary term is the strongest signal
        targetConfidence = 0.9;
        break;
      }
      const related = corrections.find((c) => c.to.toLowerCase().includes(tokens[j]) || c.from.toLowerCase() === tokens[j]);
      if (related && DESTRUCTIVE_RESOURCES.has(related.to.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
        target = tokens[j];
        targetConfidence = related.confidence;
        break;
      }
      if (j === i + 1) target = tokens[j]; // first non-stopword is the presumptive target
    }
    destructive = { verb: tokens[i], target, confidence: Number(targetConfidence.toFixed(2)) };
    break;
  }

  // ---- Gating -----------------------------------------------------------------
  let needsClarification = false;
  let reason = null;
  if (destructive) {
    // §17: destructive commands always require explicit confirmation.
    needsClarification = true;
    reason = destructive.target
      ? `destructive-command:${destructive.verb}`
      : `destructive-command:${destructive.verb}:unknown-target`;
  } else if (minCorrectionConfidence < 0.6) {
    // §15: severely low-confidence corrections are flagged for confirmation.
    needsClarification = true;
    reason = 'low-confidence-correction';
  }

  return {
    text: resultText,
    rawText,
    corrections,
    needsClarification,
    lowConfidence,
    destructive,
    reason,
  };
};

const isDestructiveCommand = (normalized) => Boolean(normalized?.destructive);

module.exports = {
  DESTRUCTIVE_VERBS,
  DESTRUCTIVE_RESOURCES,
  CURATED_VOCAB,
  editDistance,
  buildVoiceContext,
  normalizeTranscript,
  isDestructiveCommand,
};