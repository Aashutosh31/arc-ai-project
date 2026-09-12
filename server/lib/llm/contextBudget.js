// Centralized LLM request-context budget pipeline.
//
// Every provider request is assembled against explicit token budgets so a
// large accumulated memory database can never again push a trivial request
// over the provider ceiling. Estimation is a documented chars/4 heuristic
// (calibrated ~2.9 on JSON-heavy payloads, so /4 stays conservative).
// Trimming is deterministic: fixed priority order, never the user message,
// never broken tool schemas, never a blind resend.
//
// Budgets (tokens) for the current Groq on-demand environment (8000 TPM):
//   SAFE_TOTAL 7000 = INPUT (~5400-5800, derived) + OUTPUT (1200/1600).
const { GROUP_PRIORITY, CAPABILITY_GROUPS } = require('./toolSelection');

const SAFE_TOTAL_BUDGET_TOKENS = 7000;
const OUTPUT_BUDGET_DEFAULT = 1200;
const OUTPUT_BUDGET_EXTENDED = 1600;

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 8;

const MEMORY_BUDGET_TOKENS = 700;
const FACTS_BUDGET_TOKENS = 400;
const RAG_BUDGET_TOKENS = 800;

const DOC_CHARS_INITIAL = 12000;
const DOC_CHARS_MIN = 1000;
const MINIMAL_DOC_CHARS = 4000;

const STOPWORDS = new Set(
  'the,a,an,and,or,but,for,with,from,that,this,these,those,what,when,where,which,who,whom,how,why,does,do,did,are,is,was,were,be,been,being,have,has,had,will,would,should,could,can,may,might,must,shall,not,no,yes,if,then,than,too,very,just,about,into,over,after,before,between,under,again,once,here,there,their,they,them,his,her,its,our,your,you,me,my,we,please,tell,explain,simple,terms'.split(',')
);

const estTokensForChars = (chars) => Math.max(0, Math.ceil(Number(chars || 0) / CHARS_PER_TOKEN));

const estMessagesTokens = (messages) => {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estTokensForChars(String(m?.content || '').length);
  }
  return total;
};

const estToolsTokens = (schemas) => {
  try {
    return estTokensForChars(JSON.stringify(schemas || []).length);
  } catch {
    return 0;
  }
};

const queryWords = (query) => {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return new Set(words);
};

const overlapScore = (text, words) => {
  if (!words || words.size === 0) return 0;
  const hay = String(text || '').toLowerCase();
  let score = 0;
  for (const w of words) {
    if (hay.includes(w)) score += 1;
  }
  return score;
};

const timeValue = (v) => {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

// Rank: pinned first, then query relevance, then recency. No embeddings.
function rankDocs(docs, query, textOf) {
  const words = queryWords(query);
  const withTime = (docs || []).map((d, i) => ({ d, i }));
  withTime.sort((a, b) => timeValue(b.d.timestamp || b.d.createdAt) - timeValue(a.d.timestamp || a.d.createdAt));
  const scored = withTime.map(({ d }, recencyRank) => ({
    d,
    score: (d.pinned ? 1000 : 0) + overlapScore(textOf(d), words) * 10 + (withTime.length - recencyRank)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.d);
}

const truncateTo = (text, maxChars) => {
  const s = String(text || '');
  return s.length > maxChars ? s.slice(0, maxChars) : s;
};

// Compact memory docs into short bullets — NEVER verbatim documents.
// Format: `- <query…140> → <response…220>`.
function compactMemories(docs, query, budgetTokens = MEMORY_BUDGET_TOKENS) {
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  const ranked = rankDocs(docs, query, (d) => `${d.query || ''} ${d.response || ''}`);
  const lines = [];
  let chars = 0;
  let kept = 0;
  for (const d of ranked) {
    if (!d.query && !d.response) continue;
    const line = `- ${truncateTo(d.query || '(saved note)', 140)} → ${truncateTo(d.response || '', 220)}`;
    if (chars + line.length + 1 > budgetChars) break;
    lines.push(line);
    chars += line.length + 1;
    kept += 1;
  }
  const total = (docs || []).length;
  return { text: lines.join('\n'), kept, dropped: total - kept, chars };
}

function compactFacts(docs, query, budgetTokens = FACTS_BUDGET_TOKENS) {
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  const ranked = rankDocs(docs, query, (d) => d.fact || '');
  const lines = [];
  let chars = 0;
  let kept = 0;
  for (const d of ranked) {
    if (!d.fact) continue;
    const line = `- ${truncateTo(d.fact, 160)}`;
    if (chars + line.length + 1 > budgetChars) break;
    lines.push(line);
    chars += line.length + 1;
    kept += 1;
  }
  const total = (docs || []).length;
  return { text: lines.join('\n'), kept, dropped: total - kept, chars };
}

// RAG items arrive pre-ranked; keep order, shrink snippet caps to fit.
function compactRag(items, budgetTokens = RAG_BUDGET_TOKENS) {
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  let chars = 0;
  let kept = 0;
  for (const item of list) {
    const label = item.type === 'conversation' ? 'Conversation' : item.type === 'message' ? 'Message' : 'Memory';
    const remaining = budgetChars - chars;
    if (remaining < 40) break;
    const snippetCap = Math.max(60, Math.min(220, remaining - 60));
    const line = `- [${label} | ${item.source} | score ${(Number(item.score || 0) * 100).toFixed(0)}] ${truncateTo(item.snippet || '', snippetCap)}`;
    if (chars + line.length + 1 > budgetChars) break;
    lines.push(line);
    chars += line.length + 1;
    kept += 1;
  }
  return { text: lines.join('\n'), kept, dropped: list.length - kept, chars };
}

const nameToGroup = (() => {
  const map = new Map();
  for (const [group, names] of Object.entries(CAPABILITY_GROUPS)) {
    for (const name of names) map.set(name, group);
  }
  return map;
})();

// Drop whole tool groups from lowest priority until the tool set fits.
// Schemas are never truncated or edited — a tool is either fully present
// with its required parameters or absent.
function trimToolsToBudget(tools, budgetTokens) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const rankOf = (schema) => {
    const g = nameToGroup.get(schema?.function?.name);
    const idx = GROUP_PRIORITY.indexOf(g);
    return idx < 0 ? GROUP_PRIORITY.length : idx;
  };
  list.sort((a, b) => rankOf(a) - rankOf(b));
  while (list.length > 0 && estToolsTokens(list) > budgetTokens) list.pop();
  return list;
}

const buildSystemPrompt = (template, { longTermText, retrievalText }) =>
  String(template || '')
    .replace('__LONG_TERM_MEMORY_SLOT__', longTermText || '')
    .replace('__RETRIEVAL_CONTEXT_SLOT__', retrievalText || '');

// Main pipeline: waterfall-fit all parts into inputBudget.
// Returns { ok, systemPrompt, messages, tools, maxTokens, report }.
// ok:false ONLY when even the minimal profile overflows (gigantic user
// input) — the caller must then refuse WITHOUT calling the provider.
function assembleBudgetedRequest(parts) {
  const {
    systemTemplate,
    baseUserText = '',
    docText = '',
    memoryDocs = [],
    factDocs = [],
    ragItems = [],
    selectedTools = [],
    outputBudget = OUTPUT_BUDGET_DEFAULT,
    query = ''
  } = parts || {};

  const maxTokens = Math.max(256, Number(outputBudget) || OUTPUT_BUDGET_DEFAULT);
  const inputBudget = Math.max(0, SAFE_TOTAL_BUDGET_TOKENS - maxTokens);
  const compactionPasses = [];

  const renderAll = (state) => {
    const longTermText = state.factsText
      ? `\n\nCRITICAL CONTEXT - You permanently know these facts about the user:\n${state.factsText}` : '';
    const retrievalText = (state.memoryText || state.ragText)
      ? `${state.memoryText ? `\n\nRECENT MEMORY:\n${state.memoryText}` : ''}${state.ragText ? `\n\nRELEVANT RETRIEVAL CONTEXT (ranked, deduplicated):\n${state.ragText}` : ''}` : '';
    const systemPrompt = buildSystemPrompt(systemTemplate, { longTermText, retrievalText });
    const userContent = state.docText ? `${baseUserText}${state.docText}` : String(baseUserText || '');
    const messages = [{ role: 'user', content: userContent }];
    return { systemPrompt, messages, tools: state.tools };
  };

  const estimate = (built) =>
    estTokensForChars(String(built.systemPrompt || '').length) +
    estMessagesTokens(built.messages) +
    estToolsTokens(built.tools);

  // Initial render at full per-category budgets.
  const mem0 = compactMemories(memoryDocs, query, MEMORY_BUDGET_TOKENS);
  const fact0 = compactFacts(factDocs, query, FACTS_BUDGET_TOKENS);
  const rag0 = compactRag(ragItems, RAG_BUDGET_TOKENS);
  const state = {
    tools: [...selectedTools],
    memoryText: mem0.text,
    factsText: fact0.text,
    ragText: rag0.text,
    docText: String(docText || '')
  };
  const counts = {
    memoryKept: mem0.kept, memoryDropped: mem0.dropped,
    factsKept: fact0.kept, factsDropped: fact0.dropped,
    ragKept: rag0.kept, ragDropped: rag0.dropped
  };

  const over = (built) => estimate(built) > inputBudget;

  const shrink = (label, fn) => {
    const before = estimate(renderAll(state));
    fn();
    const after = estimate(renderAll(state));
    if (after < before) compactionPasses.push(label);
    return after;
  };

  let built = renderAll(state);
  let est = estimate(built);

  // Pass 1: drop low-priority tool groups (never edit schemas).
  if (over(built)) {
    est = shrink('tools', () => {
      const toolsBudgetTokens = Math.max(0, inputBudget - estTokensForChars(String(built.systemPrompt || '').length) - estMessagesTokens(built.messages));
      state.tools = trimToolsToBudget(state.tools, toolsBudgetTokens);
    });
    built = renderAll(state);
  }
  // Pass 2: halve memory, then drop.
  if (over(built)) {
    est = shrink('memory-half', () => {
      const c = compactMemories(memoryDocs, query, Math.floor(MEMORY_BUDGET_TOKENS / 2));
      state.memoryText = c.text;
      counts.memoryKept = c.kept; counts.memoryDropped = c.dropped;
    });
    built = renderAll(state);
  }
  if (over(built)) {
    est = shrink('memory-drop', () => {
      state.memoryText = '';
      counts.memoryDropped = (memoryDocs || []).length; counts.memoryKept = 0;
    });
    built = renderAll(state);
  }
  // Pass 3: halve facts, then drop.
  if (over(built)) {
    est = shrink('facts-half', () => {
      const c = compactFacts(factDocs, query, Math.floor(FACTS_BUDGET_TOKENS / 2));
      state.factsText = c.text;
      counts.factsKept = c.kept; counts.factsDropped = c.dropped;
    });
    built = renderAll(state);
  }
  if (over(built)) {
    est = shrink('facts-drop', () => {
      state.factsText = '';
      counts.factsDropped = (factDocs || []).length; counts.factsKept = 0;
    });
    built = renderAll(state);
  }
  // Pass 4: halve RAG, then drop.
  if (over(built)) {
    est = shrink('rag-half', () => {
      const c = compactRag(ragItems, Math.floor(RAG_BUDGET_TOKENS / 2));
      state.ragText = c.text;
      counts.ragKept = c.kept; counts.ragDropped = c.dropped;
    });
    built = renderAll(state);
  }
  if (over(built)) {
    est = shrink('rag-drop', () => {
      state.ragText = '';
      counts.ragDropped = (Array.isArray(ragItems) ? ragItems.length : 0); counts.ragKept = 0;
    });
    built = renderAll(state);
  }
  // Pass 5: shrink the attached document (user's own text is never touched;
  // the truncation notice pattern is preserved by the caller).
  if (over(built) && state.docText) {
    est = shrink('doc-shrink', () => {
      const target = Math.max(DOC_CHARS_MIN, Math.floor(String(state.docText).length / 2));
      state.docText = truncateTo(state.docText, target);
    });
    built = renderAll(state);
  }
  // Pass 6: minimal profile — system + user only.
  if (over(built)) {
    compactionPasses.push('minimal-profile');
    state.tools = [];
    state.memoryText = '';
    state.factsText = '';
    state.ragText = '';
    if (state.docText) state.docText = truncateTo(state.docText, MINIMAL_DOC_CHARS);
    counts.memoryKept = 0; counts.factsKept = 0; counts.ragKept = 0;
    built = renderAll(state);
    est = estimate(built);
  }

  const ok = est <= inputBudget;
  const report = {
    estimatedInputTokens: est,
    outputBudget: maxTokens,
    estimatedTotal: est + maxTokens,
    safeBudget: SAFE_TOTAL_BUDGET_TOKENS,
    inputBudget,
    toolsCount: built.tools.length,
    toolChars: (() => { try { return JSON.stringify(built.tools).length; } catch { return -1; } })(),
    memoryCount: counts.memoryKept,
    memoryChars: String(state.memoryText || '').length,
    factsCount: counts.factsKept,
    factsChars: String(state.factsText || '').length,
    ragCount: counts.ragKept,
    ragChars: String(state.ragText || '').length,
    historyCount: built.messages.length,
    historyChars: built.messages.reduce((a, m) => a + String(m?.content || '').length, 0),
    systemChars: String(built.systemPrompt || '').length,
    userChars: String(baseUserText || '').length + String(state.docText || '').length,
    compactionApplied: compactionPasses.length > 0,
    compactionPasses
  };
  return { ok, ...built, maxTokens, report };
}

module.exports = {
  SAFE_TOTAL_BUDGET_TOKENS,
  OUTPUT_BUDGET_DEFAULT,
  OUTPUT_BUDGET_EXTENDED,
  CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  MEMORY_BUDGET_TOKENS,
  FACTS_BUDGET_TOKENS,
  RAG_BUDGET_TOKENS,
  DOC_CHARS_INITIAL,
  DOC_CHARS_MIN,
  estTokensForChars,
  estMessagesTokens,
  estToolsTokens,
  compactMemories,
  compactFacts,
  compactRag,
  trimToolsToBudget,
  assembleBudgetedRequest
};
