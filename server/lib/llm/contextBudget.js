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

// Bounded recent-conversation window (CORE fix for follow-up references like
// "its", "that", "the second one"). Recent turns are provider messages[]
// history — verbatim, most-recent-first fit — and rank ABOVE long-term
// memory/RAG so memory can never crowd out the turns that give "it" meaning.
// Working state is a compact structured line-block injected into the system
// prompt (active media/search/resource/task/pending tool), never giant tool
// outputs verbatim. Older dropped turns collapse into a short extractive
// summary (never a substitute for recent turns).
const HISTORY_BUDGET_TOKENS = 1500;
const WORKING_STATE_BUDGET_TOKENS = 500;
const SUMMARY_BUDGET_TOKENS = 300;
// MCP capability inventory: bounded availability block naming the
// already-authorized integrations + their exposed tools. Ranks just below
// working state (the model must see what it can call) and above long-term
// memory — it is never the first thing dropped.
const MCP_INVENTORY_BUDGET_TOKENS = 1200;
const MAX_RECENT_TURNS = 10;
const PER_TURN_CHAR_CAP = 1500;
const PER_TURN_CHAR_CAP_MIN = 300;

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

// ---- Recent conversation window -------------------------------------------
// Chronological [{ role: 'user'|'assistant', content }] EXCLUDING the current
// user turn (caller appends it last). Verbatim, most-recent-first fit: the
// immediately preceding turns (which carry tool results, entities, media,
// search results, page IDs) are kept first and never sacrificed for memory.
// perTurnCap bounds giant single turns; window bound keeps display history
// (100+ messages) separate from provider context (<= MAX_RECENT_TURNS).
function compactRecentTurns(turns, budgetTokens = HISTORY_BUDGET_TOKENS, perTurnCap = PER_TURN_CHAR_CAP) {
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  const list = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && typeof t.content !== 'undefined' && String(t.content).trim())
    .map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: truncateTo(String(t.content), Math.max(60, perTurnCap))
    }));
  const total = list.length;
  // Display history and provider context stay separate: the window holds at
  // most MAX_RECENT_TURNS no matter how many messages the UI shows. Turns
  // outside the window count as dropped (they feed the rolling summary).
  const windowed = list.slice(-MAX_RECENT_TURNS);
  const kept = [];
  let chars = 0;
  // Fit most-recent-first so recency wins deterministically.
  for (let i = windowed.length - 1; i >= 0; i -= 1) {
    const t = windowed[i];
    const cost = t.content.length + MESSAGE_OVERHEAD_TOKENS * CHARS_PER_TOKEN;
    if (chars + cost > budgetChars) break;
    kept.unshift(t);
    chars += cost;
  }
  return { turns: kept, kept: kept.length, dropped: total - kept.length, chars, perTurnCap };
}

// ---- Working state ----------------------------------------------------------
// Compact structured object (or pre-rendered string) describing the live
// task: { activeMedia, activeSearch, activeResource, activeTask,
// pendingTool }. Rendered as short reference lines — titles/ids/queries,
// bounded result refs — never giant tool outputs verbatim.
function compactWorkingState(state, budgetTokens = WORKING_STATE_BUDGET_TOKENS) {
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  if (!state) return { text: '', chars: 0 };
  if (typeof state === 'string') {
    const text = truncateTo(state.trim(), budgetChars);
    return { text, chars: text.length };
  }
  const lines = [];
  const push = (label, value) => {
    if (value == null || value === '') return;
    let rendered = '';
    try {
      rendered = typeof value === 'string' ? value : JSON.stringify(value);
    } catch { rendered = '[unserializable]'; }
    rendered = truncateTo(rendered, 300);
    lines.push(`${label}: ${rendered}`);
  };
  push('Active media', state.activeMedia);
  push('Active search', state.activeSearch);
  push('Active resource', state.activeResource);
  push('Active task', state.activeTask);
  push('Pending tool', state.pendingTool);
  for (const key of Object.keys(state)) {
    if (['activeMedia', 'activeSearch', 'activeResource', 'activeTask', 'pendingTool'].includes(key)) continue;
    push(key, state[key]);
  }
  let text = lines.join('\n');
  if (text.length > budgetChars) text = truncateTo(text, budgetChars);
  return { text, chars: text.length };
}

// ---- Rolling older-context summary ------------------------------------------
// Deterministic extractive summary of turns that fell outside the recent
// window. Preserves intents/entities as short first-line refs — never a
// substitute for recent verbatim turns.
function buildConversationSummary(droppedTurns, budgetTokens = SUMMARY_BUDGET_TOKENS) {
  const budgetChars = Math.max(0, budgetTokens * CHARS_PER_TOKEN);
  const list = Array.isArray(droppedTurns) ? droppedTurns : [];
  if (!list.length) return { text: '', chars: 0 };
  const refs = list.slice(0, 8).map((t) => {
    const firstLine = String(t.content || '').split('\n')[0].trim();
    return `- (${t.role === 'assistant' ? 'assistant' : 'user'}) ${truncateTo(firstLine, 140)}`;
  });
  let text = `Earlier in this conversation:\n${refs.join('\n')}`;
  if (list.length > refs.length) text += `\n- …and ${list.length - refs.length} more earlier turns.`;
  if (text.length > budgetChars) text = truncateTo(text, budgetChars);
  return { text, chars: text.length };
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
//
// Production 400 fix: `options.protectedNames` lists tool names that must
// NEVER be dropped here (explicitly user-requested / active continuation
// tools). MCP schemas otherwise rank last (unknown group) and were evicted
// first under pressure — including the exact tool the user named, after
// which the model still called it and Groq rejected the request ("not in
// request.tools"). Protected tools sort first and only unprotected tools are
// popped. If the protected set alone exceeds the budget it is kept anyway:
// omitting a tool the model is about to call fails loudly at the provider,
// while the token budget stays a conservative heuristic.
function trimToolsToBudget(tools, budgetTokens, options = {}) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const protectedNames = new Set(
    (Array.isArray(options?.protectedNames) ? options.protectedNames : []).filter((n) => typeof n === 'string')
  );
  const rankOf = (schema) => {
    const g = nameToGroup.get(schema?.function?.name);
    const idx = GROUP_PRIORITY.indexOf(g);
    return idx < 0 ? GROUP_PRIORITY.length : idx;
  };
  const shielded = [];
  const droppable = [];
  for (const schema of list) {
    if (protectedNames.has(schema?.function?.name)) shielded.push(schema);
    else droppable.push(schema);
  }
  shielded.sort((a, b) => rankOf(a) - rankOf(b));
  droppable.sort((a, b) => rankOf(a) - rankOf(b));
  const kept = [...shielded, ...droppable];
  while (kept.length > shielded.length && estToolsTokens(kept) > budgetTokens) kept.pop();
  return kept;
}

const buildSystemPrompt = (template, { longTermText, retrievalText, workingText, summaryText, mcpInventoryText }) => {
  const workingBlock = workingText
    ? `\n\nWORKING STATE (live task references — prefer these for "it/that/the previous one"):\n${workingText}` : '';
  const summaryBlock = summaryText
    ? `\n\nOLDER CONVERSATION SUMMARY (background only — recent turns below take precedence):\n${summaryText}` : '';
  const mcpBlock = mcpInventoryText
    ? `\n\n${mcpInventoryText}` : '';
  return String(template || '')
    .replace('__LONG_TERM_MEMORY_SLOT__', longTermText || '')
    .replace('__RETRIEVAL_CONTEXT_SLOT__', `${workingBlock}${mcpBlock}${summaryBlock}${retrievalText || ''}`);
};

// Main pipeline: waterfall-fit all parts into inputBudget.
//
// Final provider context shape:
//
//   SYSTEM (+ working state + summary + relevant memory/RAG)
//   + RECENT CONVERSATION TURNS (verbatim, bounded window)
//   + CURRENT USER TURN
//   + BOUNDED TOOL SCHEMAS
//
// Deterministic priority (never violated by compaction):
//   1. system instructions  2. current user turn  3. active/pending tool
//   state  4. immediate recent conversation  5. recent tool-result refs
//   (inside recent turns + working state)  6. relevant memory  7. older
//   conversation (summary)  8. low-priority RAG.
//
// Compaction therefore drops in reverse: unprotected tools → RAG → memory
// → facts → summary → history (oldest first, then per-turn cap) → MCP
// inventory (headers survive longest) → working state → document →
// minimal-profile refusal.
//
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
    query = '',
    recentTurns = [],
    workingState = null,
    conversationSummary = '',
    mcpInventoryText = ''
  } = parts || {};
  // Tool names that must survive budgeting (explicitly requested / active
  // tools — dropping them causes provider "not in request.tools" 400s).
  const protectedToolNames = Array.isArray(parts?.protectedToolNames)
    ? parts.protectedToolNames.filter((n) => typeof n === 'string')
    : [];

  const maxTokens = Math.max(256, Number(outputBudget) || OUTPUT_BUDGET_DEFAULT);
  const inputBudget = Math.max(0, SAFE_TOTAL_BUDGET_TOKENS - maxTokens);
  const compactionPasses = [];

  const fullMcpInventory = String(mcpInventoryText || '');
  const mcpHeadersOnly = (() => {
    try {
      const kept = String(fullMcpInventory || '').split('\n')
        .filter((line) => !/^\s+•/.test(line));
      return kept.join('\n');
    } catch { return ''; }
  })();
  const renderAll = (state) => {
    const longTermText = state.factsText
      ? `\n\nCRITICAL CONTEXT - You permanently know these facts about the user:\n${state.factsText}` : '';
    const retrievalText = (state.memoryText || state.ragText)
      ? `${state.memoryText ? `\n\nRECENT MEMORY:\n${state.memoryText}` : ''}${state.ragText ? `\n\nRELEVANT RETRIEVAL CONTEXT (ranked, deduplicated):\n${state.ragText}` : ''}` : '';
    const systemPrompt = buildSystemPrompt(systemTemplate, {
      longTermText,
      retrievalText,
      workingText: state.workingText,
      summaryText: state.summaryText,
      mcpInventoryText: state.mcpInventoryText
    });
    const userContent = state.docText ? `${baseUserText}${state.docText}` : String(baseUserText || '');
    // Bounded recent window first, current turn always last and untouched.
    const messages = [...state.historyTurns, { role: 'user', content: userContent }];
    return { systemPrompt, messages, tools: state.tools };
  };

  const estimate = (built) =>
    estTokensForChars(String(built.systemPrompt || '').length) +
    estMessagesTokens(built.messages) +
    estToolsTokens(built.tools);

  // Initial render at full per-category budgets. Recent history and
  // working state start full — memory/RAG compact first under pressure.
  const mem0 = compactMemories(memoryDocs, query, MEMORY_BUDGET_TOKENS);
  const fact0 = compactFacts(factDocs, query, FACTS_BUDGET_TOKENS);
  const rag0 = compactRag(ragItems, RAG_BUDGET_TOKENS);
  const hist0 = compactRecentTurns(recentTurns, HISTORY_BUDGET_TOKENS, PER_TURN_CHAR_CAP);
  const work0 = compactWorkingState(workingState, WORKING_STATE_BUDGET_TOKENS);
  const suppliedSummary = String(conversationSummary || '').trim();
  const droppedForSummary = (Array.isArray(recentTurns) ? recentTurns.length : 0) - hist0.kept > 0
    ? recentTurns.slice(0, Math.max(0, (Array.isArray(recentTurns) ? recentTurns.length : 0) - hist0.kept))
    : [];
  const sum0 = suppliedSummary
    ? { text: truncateTo(suppliedSummary, SUMMARY_BUDGET_TOKENS * CHARS_PER_TOKEN), chars: Math.min(suppliedSummary.length, SUMMARY_BUDGET_TOKENS * CHARS_PER_TOKEN) }
    : buildConversationSummary(droppedForSummary, SUMMARY_BUDGET_TOKENS);
  const mcp0chars = fullMcpInventory.length > MCP_INVENTORY_BUDGET_TOKENS * CHARS_PER_TOKEN
    ? `${fullMcpInventory.slice(0, MCP_INVENTORY_BUDGET_TOKENS * CHARS_PER_TOKEN)}\n…[inventory truncated to budget]`
    : fullMcpInventory;
  const state = {
    tools: [...selectedTools],
    memoryText: mem0.text,
    factsText: fact0.text,
    ragText: rag0.text,
    historyTurns: hist0.turns,
    workingText: work0.text,
    summaryText: sum0.text,
    mcpInventoryText: mcp0chars,
    docText: String(docText || '')
  };
  const counts = {
    memoryKept: mem0.kept, memoryDropped: mem0.dropped,
    factsKept: fact0.kept, factsDropped: fact0.dropped,
    ragKept: rag0.kept, ragDropped: rag0.dropped,
    historyKept: hist0.kept, historyDropped: hist0.dropped,
    historyPerTurnCap: hist0.perTurnCap
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

  // Pass 1: drop low-priority tool groups (never edit schemas, never drop
  // explicitly requested / active tools).
  if (over(built)) {
    est = shrink('tools', () => {
      const toolsBudgetTokens = Math.max(0, inputBudget - estTokensForChars(String(built.systemPrompt || '').length) - estMessagesTokens(built.messages));
      state.tools = trimToolsToBudget(state.tools, toolsBudgetTokens, { protectedNames: protectedToolNames });
    });
    built = renderAll(state);
  }
  // Pass 2: halve RAG, then drop (lowest priority — task-dependent only).
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
  // Pass 3: halve memory, then drop. Memory NEVER crowds out recent turns.
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
  // Pass 4: halve facts, then drop.
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
  // Pass 5: drop the older-conversation summary (background only).
  if (over(built) && state.summaryText) {
    est = shrink('summary-drop', () => {
      state.summaryText = '';
    });
    built = renderAll(state);
  }
  // Pass 6: shrink recent history — oldest turns first, then per-turn cap.
  // Recent turns outrank memory/facts/RAG: those are already gone here.
  if (over(built) && state.historyTurns.length > 0) {
    est = shrink('history-drop-oldest', () => {
      const keepFrom = Math.ceil(state.historyTurns.length / 2);
      const dropped = state.historyTurns.length - keepFrom;
      state.historyTurns = state.historyTurns.slice(-keepFrom);
      counts.historyKept = state.historyTurns.length;
      counts.historyDropped = (counts.historyDropped || 0) + dropped;
    });
    built = renderAll(state);
  }
  if (over(built) && state.historyTurns.length > 0) {
    est = shrink('history-shrink-turns', () => {
      const c = compactRecentTurns(state.historyTurns, Math.floor(HISTORY_BUDGET_TOKENS / 2), PER_TURN_CHAR_CAP_MIN);
      state.historyTurns = c.turns;
      counts.historyKept = c.kept;
      counts.historyDropped = (counts.historyDropped || 0) + c.dropped;
      counts.historyPerTurnCap = c.perTurnCap;
    });
    built = renderAll(state);
  }
  if (over(built) && state.historyTurns.length > 0) {
    est = shrink('history-drop', () => {
      counts.historyDropped = (counts.historyDropped || 0) + state.historyTurns.length;
      counts.historyKept = 0;
      state.historyTurns = [];
    });
    built = renderAll(state);
  }
  // Pass 7: shrink the MCP inventory (tool detail lines first, server
  // headers survive longest so the model still knows what exists).
  if (over(built) && state.mcpInventoryText) {
    est = shrink('mcp-half', () => {
      const target = Math.max(400, Math.floor(String(state.mcpInventoryText).length / 2));
      state.mcpInventoryText = truncateTo(state.mcpInventoryText, target);
    });
    built = renderAll(state);
  }
  if (over(built) && state.mcpInventoryText && mcpHeadersOnly) {
    est = shrink('mcp-headers-only', () => {
      state.mcpInventoryText = truncateTo(mcpHeadersOnly, 1200);
    });
    built = renderAll(state);
  }
  // Pass 8: shrink working state (active/pending refs — shrunk late because
  // follow-ups like "send it" need them; the current turn itself is sacred).
  if (over(built) && state.workingText) {
    est = shrink('working-half', () => {
      const c = compactWorkingState(state.workingText, Math.floor(WORKING_STATE_BUDGET_TOKENS / 2));
      state.workingText = c.text;
    });
    built = renderAll(state);
  }
  if (over(built) && state.workingText) {
    est = shrink('working-drop', () => {
      state.workingText = '';
    });
    built = renderAll(state);
  }
  // Pass 9: shrink the attached document (user's own text is never touched;
  // the truncation notice pattern is preserved by the caller).
  if (over(built) && state.docText) {
    est = shrink('doc-shrink', () => {
      const target = Math.max(DOC_CHARS_MIN, Math.floor(String(state.docText).length / 2));
      state.docText = truncateTo(state.docText, target);
    });
    built = renderAll(state);
  }
  // Pass 10: minimal profile — system + current user (+ up to 2 most recent
  // turns when they fit) + protected tools only. Explicitly requested /
  // active tools are retained even here: dropping a tool the model is about
  // to call fails loudly at the provider, so if the minimal profile plus
  // the protected tools still overflows, the pipeline honestly refuses
  // (ok:false) instead of sending a tool-less request the model cannot use.
  // The MCP server headers survive minimally so availability stays explicit.
  if (over(built)) {
    compactionPasses.push('minimal-profile');
    const shielded = state.tools.filter((s) => protectedToolNames.includes(s?.function?.name));
    state.tools = [...shielded];
    state.memoryText = '';
    state.factsText = '';
    state.ragText = '';
    state.summaryText = '';
    state.workingText = '';
    state.mcpInventoryText = mcpHeadersOnly ? truncateTo(mcpHeadersOnly, 800) : '';
    state.historyTurns = (state.historyTurns || []).slice(-2);
    if (state.docText) state.docText = truncateTo(state.docText, MINIMAL_DOC_CHARS);
    counts.memoryKept = 0; counts.factsKept = 0; counts.ragKept = 0;
    counts.historyKept = state.historyTurns.length;
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
    historyKept: counts.historyKept || 0,
    historyDropped: counts.historyDropped || 0,
    historyPerTurnCap: counts.historyPerTurnCap || PER_TURN_CHAR_CAP,
    workingStateChars: String(state.workingText || '').length,
    mcpInventoryChars: String(state.mcpInventoryText || '').length,
    summaryChars: String(state.summaryText || '').length,
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
  HISTORY_BUDGET_TOKENS,
  WORKING_STATE_BUDGET_TOKENS,
  MCP_INVENTORY_BUDGET_TOKENS,
  SUMMARY_BUDGET_TOKENS,
  MAX_RECENT_TURNS,
  PER_TURN_CHAR_CAP,
  PER_TURN_CHAR_CAP_MIN,
  DOC_CHARS_INITIAL,
  DOC_CHARS_MIN,
  estTokensForChars,
  estMessagesTokens,
  estToolsTokens,
  compactMemories,
  compactFacts,
  compactRag,
  compactRecentTurns,
  compactWorkingState,
  buildConversationSummary,
  trimToolsToBudget,
  assembleBudgetedRequest
};
