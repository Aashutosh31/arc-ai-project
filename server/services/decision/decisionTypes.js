'use strict';

// Bounded decision vocabulary for the ARC System One decision layer.
//
// Jev answers typed questions against a small state blob. Every decision
// value is normalized here into the ARC contract so providers stay
// swappable. Do not add unbounded questions: a new decision must define an
// allowed value set (choice) and a normalization rule at this boundary.

const OPERATION_OPTIONS = [
  'chat',
  'search',
  'media',
  'calendar',
  'messaging',
  'code',
  'mcp',
  'other'
];

// Choice criteria (option -> description). Jev picks from this bounded set
// only; it never invents tool names or MCP server names. The deterministic
// MCP planner keeps full responsibility for the actual server/tool choice.
const OPERATION_CRITERIA = {
  chat: 'General conversation, explanations, definitions, greetings, or text answers that need no external system.',
  search: 'Searching the web, news, feeds, or the workspace document index for live/external information.',
  media: 'Playing, pausing, browsing, or querying media (music, video, audio) through the user\'s device or a media service.',
  calendar: 'Reading, checking, or modifying calendar data (availability, events, meetings).',
  messaging: 'Composing or sending a message with an external side effect (WhatsApp, email, DM).',
  code: 'Writing, running, or executing code or shell commands with real side effects.',
  mcp: 'A capability provided by a connected external integration (issues, pages, docs, projects, CRM, notes...).',
  other: 'Any action needing an external capability not covered above; a human policy decision is required.'
};

// Ordered risk rubric (lowest -> highest). Jev returns an interpolated rung
// index in [0, levels-1]; decisionPolicy normalizes it to the 0..100 scale.
const RISK_CRITERIA = [
  'harmless: purely conversational, informational, or internal reasoning',
  'minor: read-only external lookup or a low-impact local side effect',
  'moderate: external read/write with limited consequence',
  'high: external write/send, irreversible, privacy-sensitive, or consequential action',
  'critical: large-scale, destructive, financially/legally consequential, or irreversible'
];

// The four current ARC decisions, in the exact AI SDK evaluate question form
// (boolean / choice / score). These are the ONLY questions Jev is asked.
const QUESTIONS = {
  needsExternalCapability: {
    type: 'boolean',
    instructions: 'Does the user request require an external capability, tool, API, MCP server, real-time external data source, or side effect to fulfill correctly?',
    criteria: {
      true: 'the request can only be fulfilled by calling a tool, API, MCP server, external data source, or by performing an external side effect',
      false: 'the request is fully answerable conversationally from the assistant\'s own knowledge with no external capability'
    }
  },
  operation: {
    type: 'choice',
    instructions: 'Which bounded ARC operation best matches this request?',
    criteria: OPERATION_CRITERIA
  },
  risk: {
    type: 'score',
    instructions: 'How strongly does this request indicate a potentially destructive, externally consequential, privacy-sensitive, or irreversible action?',
    criteria: RISK_CRITERIA
  },
  needsConfirmation: {
    type: 'boolean',
    instructions: 'Does fulfilling this request require explicit user confirmation before an external side effect?',
    criteria: {
      true: 'the user must confirm before the action happens (destructive, irreversible, consequential, or side-effect action)',
      false: 'the action is safe to perform without confirmation'
    }
  }
};

// Minimal decision state sent to Jev. Routing state only: the current
// request, a bounded slice of recent user context (for follow-up
// resolution), and compact working-state surfaces. NEVER full memory, the
// whole conversation, MCP inventories, tool lists, auth state, or secrets.
const buildDecisionState = ({ request = '', recentContext = [], workingState = null, query = '' } = {}) => {
  const state = {
    request: String(request || '').slice(0, 600)
  };
  const prior = Array.isArray(recentContext) ? recentContext : [];
  if (prior.length) {
    state.recentUserContext = prior
      .filter((t) => t && t.role === 'user' && String(t.content || '').trim())
      .slice(-2)
      .map((t) => String(t.content).slice(0, 300));
  }
  if (query && String(query) !== String(request || '')) {
    state.query = String(query).slice(0, 600);
  }
  const compact = compactWorkingState(workingState);
  if (compact) state.workingState = compact;
  return state;
};

// Working-state compaction: routing-relevant surfaces only (names + bounded
// refs). Anything else is dropped before it can reach a decision provider.
const compactWorkingState = (ws) => {
  if (!ws || typeof ws !== 'object') return null;
  const out = {};
  const surfaces = ['activeMedia', 'activeSearch', 'activeResource', 'activeTask', 'pendingTool'];
  for (const key of surfaces) {
    const value = ws[key];
    if (value == null) continue;
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(value || ''); } catch { text = ''; }
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (text) out[key] = text.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
};

// Normalized ARC decision contract. `provider` is the source that produced
// the decision ('deterministic' | 'jev' | 'legacy'); `confidence` is the
// probability of the deciding value (needsExternalCapability). `reason`
// explains legacy fallbacks (never user-facing).
const buildDecisionResult = ({
  needsExternalCapability = { value: false, probability: 0 },
  operation = {},
  risk = {},
  needsConfirmation = { value: false, probability: 0 },
  provider = 'legacy',
  latencyMs = 0,
  confidence = 0,
  decisionId = null,
  reason = null
} = {}) => ({
  provider,
  latencyMs,
  confidence,
  decisionId: decisionId || (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `decision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`),
  reason,
  needsExternalCapability: {
    value: Boolean(needsExternalCapability?.value),
    probability: clamp01(needsExternalCapability?.probability)
  },
  operation: {
    value: OPERATION_OPTIONS.includes(operation?.value) ? operation.value : 'other',
    ...(typeof operation?.probability === 'number' ? { probability: clamp01(operation.probability) } : {})
  },
  risk: {
    value: clampRisk(risk?.value),
    ...(typeof risk?.probability === 'number' ? { probability: clamp01(risk.probability) } : {})
  },
  needsConfirmation: {
    value: Boolean(needsConfirmation?.value),
    probability: clamp01(needsConfirmation?.probability)
  }
});

const clamp01 = (n) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
};

const clampRisk = (n) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 0;
};

module.exports = {
  OPERATION_OPTIONS,
  OPERATION_CRITERIA,
  RISK_CRITERIA,
  QUESTIONS,
  buildDecisionState,
  compactWorkingState,
  buildDecisionResult,
  clamp01,
  clampRisk
};