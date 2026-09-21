const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const TaskExecutor = require('./TaskExecutor');
const toolRegistry = require('../tools/index');
const pdfExtract = require('pdf-extraction'); // 🚀 The modern, working package!
const { consumeCredits, isGuestActorId } = require('./creditService');
const LLMRouter = require('../lib/llm/LLMRouter');
const StreamingRuntime = require('../lib/llm/StreamingRuntime');
const { buildMemoryContext, searchWorkspace } = require('./workspaceSearchService');
const WorkspaceContextManager = require('./WorkspaceContextManager');
const TaskPlanner = require('./TaskPlanner');
const ToolRecoveryManager = require('./ToolRecoveryManager');
const { upsertTextVector } = require('./workspaceIndexService');
const { buildProviderContinuationMessages, normalizeProviderError, describeProviderFailure, classifyProviderFailure } = require('../lib/llm/utils');
const { selectToolSchemas, detectOutputIntent, activeToolNamesFromCalls, selectContinuationTools, partitionToolCallsByExposure, declareToolCapabilities, classifyIntentCapabilities, buildMcpCapabilityInventory, reselectMcpCapabilities, isNoToolAvailableProse, isManualApiFallbackProse, extractMissingToolName, toolEntityStem, mcpServerKeyOf, mcpScopeMatches, detectMcpServerScope } = require('../lib/llm/toolSelection');
const {
    requiredParams,
    effectiveRequiredParams,
    missingEffective,
    validateArgs,
    extractArgValues,
    extractIdentifierValue,
    missingRequired,
    applyParamDefaults,
    buildClarification,
    createPending,
    advancePending,
    isCancelText,
    isIdentifierParam
} = require('../lib/llm/pendingArgs');
const { McpToolSource } = require('../lib/mcp');
const {
    OUTPUT_BUDGET_DEFAULT,
    OUTPUT_BUDGET_EXTENDED,
    DOC_CHARS_INITIAL,
    assembleBudgetedRequest
} = require('../lib/llm/contextBudget');
const WorkspaceRuntimeManager = require('./WorkspaceRuntimeManager');
const WorkspaceLogger = require('../lib/WorkspaceLogger');
const ttsService = require('./ttsService');
const { decisionEngine, decisionPolicy } = require('./decision');

// Truthful refusal when a request cannot fit the provider context budget
// even after deterministic compaction. Used both for pre-provider refusal
// and for provider-reported 413s — one message, no duplication drift.
const CONTEXT_BUDGET_USER_MESSAGE = "That request exceeds the current AI provider's context budget. Please start a new conversation or shorten the request and try again.";

// Generic creation-context nouns (never vendor names): a required parameter
// shaped like one of these (team_id, projectId, workspace, …) names a
// creation SCOPE resolvable through the integration's own LIST/READ tools —
// not user content, and never an ID the user must hand-type. Anything else
// identifier-shaped (issue_id, pageId, …) is the entity's own reference.
const CREATION_CONTEXT_NOUNS = new Set([
  'team', 'project', 'workspace', 'space', 'organization', 'org', 'parent',
  'board', 'cycle', 'milestone', 'sprint', 'epic', 'label', 'assignee',
  'reporter', 'author', 'owner', 'member', 'user', 'group', 'department',
  'folder', 'collection', 'database', 'channel', 'repository', 'repo',
  'account', 'customer', 'contact', 'status', 'state', 'priority'
]);

// Maximum live resolver reads per creation-context attempt (bounded like
// every other resolution path).
const CREATION_RESOLVER_BUDGET = 3;

const SCHEDULE_KEYWORDS = [
    'schedule',
    'book',
    'create a meeting',
    'create meeting',
    'set meeting',
    'set a meeting',
    'add event',
    'arrange call',
    'put on my calendar'
];

const READ_KEYWORDS = [
    'what meetings',
    'upcoming events',
    "what's on my calendar",
    'whats on my calendar',
    'am i free',
    'availability',
    'show events'
];

const hasAnyPhrase = (text, phrases) => phrases.some((phrase) => text.includes(phrase));

const hasDateTimeSignal = (text) => {
    const dateWords = [
        'today', 'tomorrow', 'tonight', 'this morning', 'this afternoon', 'this evening',
        'next week', 'next month', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
        'saturday', 'sunday', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug',
        'sep', 'sept', 'oct', 'nov', 'dec'
    ];

    const hasDateWord = dateWords.some((word) => text.includes(word));
    const hasTimePattern = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\bat\s+\d{1,2}(:\d{2})?\b/i.test(text);
    const hasRelativePattern = /\bin\s+\d+\s+(minute|minutes|hour|hours|day|days|week|weeks)\b/i.test(text);

    return hasDateWord || hasTimePattern || hasRelativePattern;
};

const hasTitleSignal = (text) => {
    return /\babout\b|\bfor\b|\bwith\b|"[^"]+"|'[^']+'/i.test(text);
};

const classifyCalendarIntent = (rawText) => {
    const text = String(rawText || '').toLowerCase();
    if (!text.trim()) return { type: 'none', shouldForceSchedule: false };

    const scheduleIntent = hasAnyPhrase(text, SCHEDULE_KEYWORDS);
    const readIntent = hasAnyPhrase(text, READ_KEYWORDS);
    const dateTimeSignal = hasDateTimeSignal(text);
    const titleSignal = hasTitleSignal(text);
    const shouldForceSchedule = scheduleIntent && (dateTimeSignal || titleSignal);

    if (shouldForceSchedule) {
        return {
            type: 'schedule',
            shouldForceSchedule: true,
            reason: 'schedule keyword + date/time/title signal'
        };
    }

    if (scheduleIntent) {
        return {
            type: 'schedule',
            shouldForceSchedule: true,
            reason: 'schedule keyword detected'
        };
    }

    if (readIntent) {
        return {
            type: 'read',
            shouldForceSchedule: false,
            reason: 'calendar read keyword detected'
        };
    }

    return { type: 'none', shouldForceSchedule: false };
};

const parseDurationMinutes = (text) => {
    const match = String(text || '').match(/\bfor\s+(\d+)\s*(minute|minutes|hour|hours)\b/i);
    if (!match) return 30;
    const value = Number(match[1]);
    const unit = String(match[2] || '').toLowerCase();
    if (Number.isNaN(value) || value <= 0) return 30;
    return unit.startsWith('hour') ? value * 60 : value;
};

const parseMeetingTitle = (text) => {
    const raw = String(text || '');
    const calledMatch = raw.match(/\b(?:called|titled)\s+(.+?)(?:\s+for\s+\d+\s*(?:minute|minutes|hour|hours)\b|$)/i);
    if (calledMatch && calledMatch[1]) return calledMatch[1].trim();

    const aboutMatch = raw.match(/\b(?:meeting|call|event)\s+(?:about|for)\s+(.+?)(?:\s+at\b|\s+tomorrow\b|\s+today\b|\s+on\b|\s+for\s+\d+\s*(?:minute|minutes|hour|hours)\b|$)/i);
    if (aboutMatch && aboutMatch[1]) return aboutMatch[1].trim();

    return 'Meeting';
};

const parseStartDate = (text) => {
    const raw = String(text || '').toLowerCase();
    const now = new Date();
    const start = new Date(now);

    if (raw.includes('tomorrow')) {
        start.setDate(start.getDate() + 1);
        return start;
    }

    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetWeekday = weekdays.find((day) => raw.includes(day));
    if (targetWeekday) {
        const today = start.getDay();
        const target = weekdays.indexOf(targetWeekday);
        let diff = target - today;
        if (diff <= 0) diff += 7;
        start.setDate(start.getDate() + diff);
    }

    return start;
};

const parseTimeOnDate = (text, baseDate) => {
    const raw = String(text || '');
    const date = new Date(baseDate);
    const match = raw.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i) || raw.match(/\b(\d{1,2})(?::(\d{2}))\s*(am|pm)\b/i);

    if (match) {
        let hours = Number(match[1]);
        const minutes = Number(match[2] || 0);
        const meridian = String(match[3] || '').toLowerCase();

        if (meridian === 'pm' && hours < 12) hours += 12;
        if (meridian === 'am' && hours === 12) hours = 0;

        if (!Number.isNaN(hours) && !Number.isNaN(minutes)) {
            date.setHours(hours, minutes, 0, 0);
            return date;
        }
    }

    // Default to next full hour when no explicit time is given.
    date.setHours(date.getHours() + 1, 0, 0, 0);
    return date;
};

const plannerTriggerKeywords = ['research', 'compare', 'analysis', 'architect', 'architecture', 'recommend', 'plan', 'strategy', 'summarize'];

const shouldUsePlanner = (toolCalls, assistantText) => {
    if (!toolCalls || toolCalls.length === 0) return false;
    // If multiple tools are required, prefer planner
    if (toolCalls.length > 1) return true;

    // If the single tool is a heavy research or orchestration tool, and assistant prompt hints at research/plan, use planner
    const heavyTools = new Set(['deepResearchSwarm', 'webSearch', 'scrapeWebsite', 'memoryRecall', 'memorize', 'deep_research']);
    const name = (toolCalls[0]?.function?.name || '').toString();
    if (heavyTools.has(name)) {
        const text = String(assistantText || '').toLowerCase();
        if (plannerTriggerKeywords.some((k) => text.includes(k))) return true;
        // also trigger if explicit 'plan' or 'compare' in tool args
        try {
            const args = typeof toolCalls[0].function.arguments === 'string'
                ? JSON.parse(toolCalls[0].function.arguments)
                : toolCalls[0].function.arguments || {};
            const argText = JSON.stringify(args).toLowerCase();
            if (plannerTriggerKeywords.some((k) => argText.includes(k))) return true;
        } catch (e) {}
    }

    return false;
};

const buildEmptyToolResponse = ({ calendarIntent, toolCalls = [], fallbackToolResults = [] } = {}) => {
    if (calendarIntent?.type === 'schedule') {
        return 'Meeting request processed but confirmation pending.';
    }

    const toolNames = new Set([
        ...toolCalls.map((toolCall) => toolCall?.function?.name),
        ...fallbackToolResults.map((entry) => entry?.name)
    ].filter(Boolean));

    if (toolNames.has('storeUserFact') || toolNames.has('memorize')) {
        return 'Got it, I’ll remember that.';
    }

    if (toolNames.has('recallMemory')) {
        return 'I checked your memory store for relevant matches.';
    }

    if (toolNames.has('checkCalendar')) {
        return 'I checked your calendar.';
    }

    return 'Done.';
};

class AIService {
    constructor() {
        this.llmRouter = new LLMRouter();
        this.streamingRuntime = new StreamingRuntime();
        this.activeRequests = new Map();
        this.workspaceRuntime = new WorkspaceRuntimeManager({ logger: console });
        this.wsLog = new WorkspaceLogger('AIService');
    }

    getRequestKey(socket, userId) {
        if (socket && socket.id) return `socket:${socket.id}`;
        return `user:${userId}`;
    }

    beginRequest(socket, userId) {
        const key = this.getRequestKey(socket, userId);

        const prev = this.activeRequests.get(key);
        if (prev && !prev.controller.signal.aborted) {
            prev.controller.abort('superseded');
        }

        const controller = new AbortController();
        this.activeRequests.set(key, { controller });
        return { key, controller };
    }

    endRequest(key, controller) {
        const current = this.activeRequests.get(key);
        if (current && current.controller === controller) {
            this.activeRequests.delete(key);
        }
    }

    abortForSocket(socketId) {
        if (!socketId) return;
        const key = `socket:${socketId}`;
        const current = this.activeRequests.get(key);
        if (current && !current.controller.signal.aborted) {
            current.controller.abort('user_interrupted');
            this.activeRequests.delete(key);
        }
    }

    mapCalendarToolName(originalToolName, calendarIntent) {
        if (!calendarIntent || calendarIntent.type === 'none') {
            return originalToolName;
        }

        if (calendarIntent.type === 'schedule') {
            return 'scheduleMeeting';
        }

        if (calendarIntent.type === 'read') {
            return 'checkCalendar';
        }

        return originalToolName;
    }

    // ---- Pending tool-call persistence (multi-turn argument collection) ----
    // Stored on the Conversation document so fragmentary follow-ups merge
    // into the SAME tool call across stateless turns. Guests have no
    // conversation record, so pending is disabled for them (single-turn
    // behavior unchanged). All methods are failure-silent: pending is an
    // optimization over the normal flow, never load-bearing for it.
    async loadPendingToolCall(conversationId, userId) {
        if (isGuestActorId(userId) || !conversationId) return null;
        try {
            const doc = await Conversation.findById(conversationId).select('pendingToolCall').lean();
            const p = doc?.pendingToolCall;
            if (!p || typeof p.toolName !== 'string' || !p.args || typeof p.args !== 'object') return null;
            return p;
        } catch {
            return null;
        }
    }

    async savePendingToolCall(conversationId, userId, pending) {
        if (isGuestActorId(userId) || !conversationId || !pending) return;
        try {
            await Conversation.findByIdAndUpdate(conversationId, { pendingToolCall: pending });
        } catch {
            // Persistence must never break the request path.
        }
    }

    async clearPendingToolCall(conversationId, userId) {
        if (isGuestActorId(userId) || !conversationId) return;
        try {
            await Conversation.findByIdAndUpdate(conversationId, { pendingToolCall: null });
        } catch {
            // Persistence must never break the request path.
        }
    }

    // Schema lookup for pending validation/extraction. Offered request tools
    // first (what the model saw), then the native registry, then the
    // policy-permitted MCP set. Generic over native and MCP tools.
    resolvePendingSchema(toolName, offeredTools, mcpSchemas) {
        if (!toolName) return null;
        const pools = [offeredTools, (() => { try { return toolRegistry.getSchemas(); } catch { return []; } })(), mcpSchemas];
        for (const pool of pools) {
            const hit = (Array.isArray(pool) ? pool : []).find((s) => s?.function?.name === toolName);
            if (hit) return hit;
        }
        return null;
    }

    // ---- MCP tool-visibility invariant (inventory === request.tools) ----
    // The model must NEVER be told about an MCP tool unless that exact tool
    // is callable in the current provider request. Inventory is therefore
    // generated ONLY from the final provider-visible tool set — never the
    // full discovered registry, never the whole policy-exposed set. The
    // block is marker-wrapped so every stage that changes the tool set
    // (budget trim, mismatch retry, continuation) refreshes the SAME block.
    // Server-level failure lines name no tools (they only say a server is
    // unavailable and where to re-authorize). Generic: wire-name prefix
    // only, no tool/vendor knowledge.
    mcpInventoryBlockForTools(finalTools, { metadata = null, failures = [] } = {}) {
        const START = '<!--MCP-INV-BEGIN-->';
        const END = '<!--MCP-INV-END-->';
        try {
            const list = Array.isArray(finalTools) ? finalTools : [];
            let mcpTools = [];
            try {
                mcpTools = list.filter((s) => {
                    const n = s?.function?.name;
                    return typeof n === 'string' && McpToolSource.isMcpToolName(n);
                });
            } catch { mcpTools = []; }
            let body = '';
            if (!mcpTools.length) {
                body = 'MCP INTEGRATIONS: No MCP tools are currently available for this request. '
                    + 'Answer from your own capabilities and the tools actually provided. '
                    + 'Do not invent MCP tool names.';
            } else {
                let inv = null;
                try { inv = buildMcpCapabilityInventory(mcpTools, { metadata, failures: [] }); } catch { inv = null; }
                body = (inv && inv.text) ? inv.text : 'MCP INTEGRATIONS: No MCP tools are currently available for this request.';
            }
            let failureLines = '';
            try {
                const fails = Array.isArray(failures) ? failures.slice(0, 4) : [];
                failureLines = fails.map((f) => {
                    const id = String(f?.configId || f?.server || 'integration');
                    const reason = String(f?.reason || 'connection failed').slice(0, 120);
                    return `- ${id} — unavailable (${reason}). Ask the user to authorize/reconnect it in Settings; use the connected integration, never separate developer credentials.`;
                }).join('\n');
            } catch { failureLines = ''; }
            const text = failureLines ? `${body}\n${failureLines}` : body;
            return `${START}\n${text}\n${END}`;
        } catch {
            return `${START}\nMCP INTEGRATIONS: No MCP tools are currently available for this request.\n${END}`;
        }
    }

    refreshInventoryPrompt(systemPrompt, blockText) {
        const START = '<!--MCP-INV-BEGIN-->';
        const END = '<!--MCP-INV-END-->';
        try {
            const prompt = String(systemPrompt || '');
            const block = String(blockText || '');
            if (!prompt.includes(START) || !prompt.includes(END)) {
                return prompt ? `${prompt}\n\n${block}` : block;
            }
            const before = prompt.slice(0, prompt.indexOf(START));
            const after = prompt.slice(prompt.indexOf(END) + END.length);
            return `${before}${block}${after}`;
        } catch {
            return String(systemPrompt || '');
        }
    }

    // ---- Unified MCP plan contract (§6) + degraded-set truthfulness --------
    // There is exactly ONE authoritative capability source: the
    // policy-exposed MCP schemas for the current request. This pure
    // derivation (not a new pipeline) turns existing selection state into
    // the structured plan { intent, requiredCapabilities, selectedMcpTools,
    // requiredMcpTools, clarificationNeeded, executable } used for backend
    // diagnostics, fail-closed assertions, and the per-turn debug bundle.
    // A request with a matching authorized MCP capability ALWAYS yields
    // executable:true — executable:false with an exposed match is a hard
    // invariant violation (logged, never user prose).
    buildMcpPlanSummary({ intentCaps, requiredNames, selectedTools, suppressed = false, exposedCount = 0, blockedCount = 0, failureCount = 0, pendingTool = null } = {}) {
        try {
            const intent = [...(intentCaps instanceof Set ? intentCaps : [])].sort();
            const required = (Array.isArray(requiredNames) ? requiredNames : []).filter((n) => typeof n === 'string');
            const selected = (Array.isArray(selectedTools) ? selectedTools : [])
                .map((s) => s?.function?.name).filter((n) => typeof n === 'string' && McpToolSource.isMcpToolName(n));
            const needsMcp = intent.length > 0;
            // executable:false is truthful ONLY when no authorized match
            // exists (degraded/denied/empty) — never when required tools do.
            const executable = suppressed
                ? false
                : (required.length > 0 || !needsMcp);
            return {
                intent,
                requiredCapabilities: intent,
                selectedMcpTools: selected,
                requiredMcpTools: required,
                clarificationNeeded: Boolean(pendingTool),
                executable,
                suppressed: Boolean(suppressed),
                exposedCount: Number(exposedCount) || 0,
                blockedCount: Number(blockedCount) || 0,
                failureCount: Number(failureCount) || 0
            };
        } catch {
            return {
                intent: [], requiredCapabilities: [], selectedMcpTools: [],
                requiredMcpTools: [], clarificationNeeded: false, executable: false,
                suppressed: Boolean(suppressed), exposedCount: 0, blockedCount: 0, failureCount: 0
            };
        }
    }

    // Degraded-set notice (generic truthfulness, no vendor names): the
    // request maps to MCP capabilities but capability/entity SELECTION
    // pinned nothing (partial discovery, reconnect race, scope change —
    // never a policy denial, which has its own notice and suppresses
    // selection first). Without this, the model confabulates specifics
    // ("only comments") plus manual API/token/UI walkthroughs. With it,
    // the model reports the degraded state briefly, points at
    // connection/refresh in Settings, and never substitutes a manual
    // integration. Keyed off the selection outcome (same gate as
    // execution), never raw declaration overlap. Returns '' when
    // inapplicable.
    mcpDegradedNotice({ intentCaps, capabilityNames, mcpSchemas, mcpBlocked, suppressed = false } = {}) {
        try {
            if (suppressed) return '';
            const intent = intentCaps instanceof Set ? intentCaps : new Set();
            if (!intent.size) return '';
            const exposed = Array.isArray(mcpSchemas) ? mcpSchemas : [];
            if (!exposed.length) return '';
            const picked = Array.isArray(capabilityNames) ? capabilityNames.filter((n) => typeof n === 'string') : [];
            if (picked.length) return '';
            const blocked = Array.isArray(mcpBlocked) ? mcpBlocked.length : 0;
            if (blocked > 0) return '';
            return '\n\nAVAILABILITY NOTICE: the connected integration does not currently expose a tool for the requested capability. '
                + 'Say briefly that the capability is unavailable right now and suggest checking the connection or refreshing it in Settings. '
                + 'Do not describe a manual API workflow, do not ask for a personal token or key, do not tell the user to open any vendor UI or dashboard, '
                + 'and do not claim knowledge of which tools exist beyond what is listed above.';
        } catch {
            return '';
        }
    }

    // Capability-miss diagnostic (read-only, names/counts only): when a
    // MUTATION intent cap (CREATE/UPDATE/…) ends the turn with zero
    // capability picks, record WHY — the exact evidence the next
    // investigation needs instead of another blind round. For each missed
    // cap it lists exposed tools whose target entity matches the request
    // (with their declared caps + server keys), so a filtered-out mutation
    // (scope fragmentation, discovery gap) or a hostile schema
    // (readOnlyHint stripping a save_* tool) is visible immediately.
    // Generic capability/entity evidence only, no vendors. Returns the
    // miss list ([]) when everything is covered. Never throws.
    logMcpCapabilityMiss({ intentCaps, capabilityNames, mcpSchemas, scopedSchemas, serverScope, queryText } = {}) {
        const misses = [];
        try {
            const intent = intentCaps instanceof Set ? intentCaps : new Set();
            if (!intent.size) return misses;
            const MUTATION_CAPS = new Set(['CREATE', 'UPDATE', 'DELETE', 'SEND', 'COMMENT', 'UPLOAD', 'DOWNLOAD', 'EXECUTE', 'MOVE', 'DUPLICATE', 'ARCHIVE', 'RESTORE']);
            const wanted = [...intent].filter((c) => MUTATION_CAPS.has(c));
            if (!wanted.length) return misses;
            const pool = Array.isArray(scopedSchemas) && scopedSchemas.length
                ? scopedSchemas : (Array.isArray(mcpSchemas) ? mcpSchemas : []);
            const byName = new Map(pool.map((s) => [s?.function?.name, s]).filter(([n]) => typeof n === 'string'));
            const picked = new Set((Array.isArray(capabilityNames) ? capabilityNames : []).filter((n) => typeof n === 'string'));
            const stem = (t) => {
                const s = String(t || '').toLowerCase();
                return (s.length > 4 && s.endsWith('s') && !s.endsWith('ss')) ? s.slice(0, -1) : s;
            };
            const queryStems = new Set(
                (String(queryText || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).map(stem)
            );
            for (const cap of wanted) {
                let covered = false;
                for (const n of picked) {
                    try { if (declareToolCapabilities(byName.get(n))?.has(cap)) { covered = true; break; } } catch { /* ignore */ }
                }
                if (covered) continue;
                const entityCandidates = [];
                for (const s of pool) {
                    const name = s?.function?.name;
                    if (typeof name !== 'string' || !name) continue;
                    let te = '';
                    try { te = String(toolEntityStem(s) || '').toLowerCase(); } catch { te = ''; }
                    if (!te) continue;
                    const teStem = stem(te);
                    let match = false;
                    for (const q of queryStems) {
                        if (q === teStem || `${q}s` === teStem || q === `${teStem}s`) { match = true; break; }
                    }
                    if (!match) continue;
                    let declared = [];
                    try { declared = [...(declareToolCapabilities(s) || [])]; } catch { declared = []; }
                    let key = '';
                    try { key = mcpServerKeyOf(s); } catch { key = ''; }
                    entityCandidates.push({ tool: name, entity: te, declared, serverKey: key });
                    if (entityCandidates.length >= 8) break;
                }
                misses.push({ cap, entityCandidates });
            }
            if (misses.length) {
                try {
                    console.error('[AIService] mcpCapability.miss', {
                        misses: misses.map((m) => ({ cap: m.cap, entityCandidates: m.entityCandidates })),
                        exposedMcp: Array.isArray(mcpSchemas) ? mcpSchemas.length : 0,
                        scopedMcp: pool.length,
                        serverScope: Array.isArray(serverScope) ? serverScope.slice(0, 8) : []
                    });
                } catch { /* diagnostics only */ }
            }
        } catch { /* diagnostics must never break the path */ }
        return misses;
    }

    // Stale-snapshot diagnostic (read-only): when a required capability has
    // no exposed match, compare the exposed per-server counts against the
    // registry-known tool counts. A gap means the turn ran on a partial
    // snapshot (reconnect race, list_changed lag) — the discovery/transport
    // layers own the fix; this turn only records the evidence (names and
    // counts, never secrets) so the degraded notice above is trusted.
    // Returns [{ serverId, exposed, registered }] mismatches, [] when clean.
    diagnoseMcpSnapshot({ mcpSchemas, metadata } = {}) {
        const gaps = [];
        try {
            const exposed = Array.isArray(mcpSchemas) ? mcpSchemas : [];
            const meta = metadata instanceof Map ? metadata : null;
            const byServer = new Map();
            for (const s of exposed) {
                let sid = null;
                try {
                    const m = meta ? meta.get(s?.function?.name) : null;
                    sid = m && (m.serverId || m.slug) ? String(m.serverId || m.slug) : null;
                } catch { sid = null; }
                if (!sid) continue;
                byServer.set(sid, (byServer.get(sid) || 0) + 1);
            }
            let registry = null;
            try { registry = McpToolSource.registry; } catch { registry = null; }
            if (!registry || typeof registry.toolCount !== 'function') return gaps;
            const seen = new Set();
            for (const [sid, count] of byServer) {
                seen.add(sid);
                let known = null;
                try { known = registry.toolCount(sid); } catch { known = null; }
                if (typeof known === 'number' && known !== count) {
                    gaps.push({ serverId: sid, exposed: count, registered: known });
                }
            }
            // Configs known to the registry but entirely absent from this
            // turn's exposed set are the strongest stale signal — but the
            // registry is workspace-agnostic here, so report conservatively:
            // only when NOTHING was exposed at all.
            if (exposed.length === 0) {
                try {
                    const total = typeof registry.count === 'number' ? registry.count : null;
                    if (typeof total === 'number' && total > 0) gaps.push({ serverId: '*', exposed: 0, registered: total });
                } catch { /* conservative: skip */ }
            }
        } catch {
            // Diagnostics must never break the request path.
        }
        return gaps;
    }

    // Provider tool-mismatch failsafe (final defense only): the provider
    // reports "attempted to call tool X which was not in request.tools".
    // Returns { name, schema } when X is an exposed, permitted MCP tool
    // whose exact schema can be added once — or null when X is unknown,
    // denied, or unresolvable (caller then fails truthfully). Generic:
    // name extraction + exposed-set lookup only. Never fabricates.
    missingToolRetrySpec(err, tools, mcpSchemas, protectedNames) {
        try {
            const name = extractMissingToolName(err);
            if (!name) return null;
            const offered = new Set(
                (Array.isArray(tools) ? tools : []).map((s) => s?.function?.name).filter(Boolean)
            );
            if (offered.has(name)) return null;
            const exposed = Array.isArray(mcpSchemas) ? mcpSchemas : [];
            const schema = exposed.find((s) => s?.function?.name === name);
            if (!schema) return null;
            if (!this.isPendingPermitted(name, exposed)) return null;
            const shielded = new Set(
                (Array.isArray(protectedNames) ? protectedNames : []).filter((n) => typeof n === 'string')
            );
            shielded.add(name);
            // The 6-tool cap never grows: evict the last non-shielded tool
            // to make room. Only when every slot is shielded (already a
            // provider error in progress) is the final slot replaced — the
            // missing tool the model actually tried to call outranks it.
            const rest = (Array.isArray(tools) ? tools : []).filter((s) => {
                const n = s?.function?.name;
                return typeof n === 'string' && n && n !== name;
            });
            while (rest.length + 1 > 6) {
                let victim = -1;
                for (let i = rest.length - 1; i >= 0; i -= 1) {
                    if (!shielded.has(rest[i]?.function?.name)) { victim = i; break; }
                }
                rest.splice(victim >= 0 ? victim : rest.length - 1, 1);
            }
            return { name, schema, tools: [schema, ...rest], protectedNames: [...shielded] };
        } catch {
            return null;
        }
    }

    // ---- Deterministic MCP action enforcement --------------------------------
    // When the request carries REQUIRED_FOR_EXECUTION MCP capabilities
    // (policy-filtered + intent-classified + entity-matched + budgeted) and
    // the provider emits zero tool calls, the turn must not end in prose.
    // One bounded recovery pass runs instead: a constrained retry over the
    // required schemas (single unambiguous tool → provider-forced), then
    // normal execution/synthesis. Never loops, never forces denied,
    // unauthorized, or unavailable capabilities (those yield no required
    // schemas by construction), never executes a tool twice.
    //
    // Clarification shape (generic English): the model is gathering missing
    // information ("Which team?", "could you specify…"). That is legitimate
    // — the pending flow collects the answer — so ordinary clarifying prose
    // never triggers enforcement. False-unavailable / manual-API prose is
    // classified earlier and ALWAYS recovers.
    looksLikeClarification(prose) {
        try {
            const text = String(prose || '');
            if (!text.trim()) return false;
            if (/\?/.test(text)) return true;
            return /\b(which|what|where|when|who|whom|how\s+(many|much)|let me know|could you|can you\s+(tell|share|provide|specify|confirm)|i need|need to know|need more|missing|specify|specifies|clarify|tell me)\b/i.test(text);
        } catch {
            return false;
        }
    }

    // Pure decision unit (DB-free, testable): returns
    // { retryTools, forcedTool } or null when no recovery is warranted.
    // Generic: capability/entity evidence only, no vendors.
    planMcpRecovery({ requiredSchemas, suppressed = false, proseBad = false, emptyAnswer = false, proseText = '' }) {
        try {
            if (suppressed) return null;
            const required = (Array.isArray(requiredSchemas) ? requiredSchemas : [])
                .filter((s) => s && typeof s?.function?.name === 'string');
            if (!required.length) return null;
            if (!proseBad && !emptyAnswer && this.looksLikeClarification(proseText)) return null;
            const retryTools = required.slice(0, 6);
            if (!retryTools.length) return null;
            const forcedTool = retryTools.length === 1 ? retryTools[0].function.name : null;
            return { retryTools, forcedTool };
        } catch {
            return null;
        }
    }

    // Entity-id value check (generic, never vendors): whether the supplied
    // args carry the target's own reference — the bare `id` param or any
    // identifier-shaped param that is NOT creation context (`issueId`,
    // `pageId`, …). Scope values (`team`, `project`) never count, so a
    // present team never flips a create into an update.
    hasEntityIdValue(schema, args) {
        try {
            const bag = (args && typeof args === 'object') ? args : {};
            let entity = '';
            try { entity = toolEntityStem(schema); } catch { entity = ''; }
            for (const [name, value] of Object.entries(bag)) {
                if (typeof name !== 'string' || !name) continue;
                if (value === undefined || value === null) continue;
                if (typeof value === 'string' && !value.trim()) continue;
                if (!isIdentifierParam(name)) continue;
                let kind = '';
                try { kind = this.classifyMissingParam(name, entity).kind; } catch { kind = ''; }
                if (kind === 'context') continue;
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    // Upsert mode decision (generic, never vendors): a mutation schema is
    // in UPDATE mode when the request asks to modify without creating —
    // UPDATE intent without CREATE intent — or when the entity's own id
    // value is already present (pasted identifier or supplied args).
    // Otherwise (pure CREATE, or mixed save wording with no id) it is in
    // CREATE mode, where conditional "required when creating" params apply.
    upsertUpdateMode(schema, { intentCaps = null, text = '', args = null } = {}) {
        try {
            const intent = intentCaps instanceof Set ? intentCaps : new Set();
            if (intent.has('UPDATE') && !intent.has('CREATE')) return true;
            if (this.hasEntityIdValue(schema, args)) return true;
            let pasted;
            try { pasted = extractIdentifierValue(text, 'id'); } catch { pasted = undefined; }
            return pasted !== undefined;
        } catch {
            return false;
        }
    }

    // Strict argument resolution for enforcement and preflight (generic, no
    // vendors). The shared extractor echo-fills single slots with the whole
    // command ("Create an issue" → title="Create an issue"), which must
    // NEVER count as resolved — direct execution with an echoed title would
    // fabricate junk. A required string counts resolved only when it is
    // quoted verbatim in the user text or a proper substring of it.
    // Identifier params resolve by pattern only (UUID/URL); a lone
    // remaining open string takes the first quote ("comment on <uuid>
    // saying 'hi'" → body='hi'; "called 'X'" → title=X). Non-strings trust
    // the schema validator. Returns { ok, args } — args always
    // validator-coerced, never invented.
    resolveEnforcementArgs(schema, text, { updateMode = false } = {}) {
        try {
            const params = effectiveRequiredParams(schema, { updateMode });
            if (!params || !params.length) return { ok: true, args: {} };
            const flat = String(text || '').trim();
            if (!flat) return { ok: false, args: {} };
            const quotes = [];
            for (const m of flat.matchAll(/"([^"]+)"|'([^']+)'/g)) {
                const q = m[1] !== undefined ? m[1] : m[2];
                if (q && q.trim()) quotes.push(q.trim());
            }
            const isOpenString = (p) => {
                const d = (p && typeof p.def === 'object') ? p.def : {};
                return !isIdentifierParam(p.name)
                    && !(Array.isArray(d.enum) && d.enum.length)
                    && !['boolean', 'bool', 'integer', 'number'].includes(String(d.type || 'string').toLowerCase());
            };
            const opens = params.filter(isOpenString);
            const found = extractArgValues(text, params);
            // Schema-declared defaults fill what the user omits (the server
            // sanctions the omission); user evidence always wins. Defaulted
            // names skip the quoted/proper-substring rule below — the
            // validator still type-checks them.
            const extracted = applyParamDefaults(schema, found);
            const defaultedNames = Object.keys(extracted).filter((k) => {
                const f = found[k];
                return f === undefined || f === null || (typeof f === 'string' && !f.trim());
            });
            let check = validateArgs(schema, extracted);
            if (check.ok !== true && quotes.length) {
                const unresolvedOpens = missingRequired(schema, extracted)
                    .filter((n) => opens.some((p) => p.name === n));
                if (unresolvedOpens.length === 1) {
                    check = validateArgs(schema, { ...extracted, [unresolvedOpens[0]]: quotes[0] });
                }
            }
            const verify = (coerced, base) => {
                const valueOf = (name) => (coerced && coerced[name] !== undefined)
                    ? coerced[name] : base[name];
                for (const p of params) {
                    if (defaultedNames.includes(p.name)) continue;
                    const v = valueOf(p.name);
                    // Effective-required slots must be PRESENT: a missing
                    // conditional requirement (team/title "required when
                    // creating") is never strict-resolved — the live
                    // creation-context assist owns it.
                    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return false;
                    if (typeof v !== 'string') continue;
                    if (quotes.includes(v.trim())) continue;
                    if (flat.includes(v) && v.length < flat.length) continue;
                    return false;
                }
                return true;
            };
            if (check.ok === true && verify(check.coerced, extracted)) {
                return { ok: true, args: check.coerced };
            }
            // Single-open rescue: an echo-filled (or missing) lone open
            // string takes the first quote ("called 'X'" → title=X).
            if (opens.length === 1 && quotes.length) {
                const trial = validateArgs(schema, { ...extracted, [opens[0].name]: quotes[0] });
                if (trial.ok === true && verify(trial.coerced, extracted)) {
                    return { ok: true, args: trial.coerced };
                }
            }
            return { ok: false, args: {} };
        } catch {
            return { ok: false, args: {} };
        }
    }

    // One-shot recovery orchestration. `generate` defaults to the live
    // router; tests inject a stub. `execFn` defaults to a live
    // TaskExecutor-bound executor (tests inject or pass execCtx for the
    // real one with charge control). Returns an adoption record the caller
    // merges into the normal execution/continuation machinery. Never throws
    // for control flow — a failed recovery yields { recovered: false } and
    // the caller falls back to the original answer truthfully.
    //
    // Final stage: when the constrained retry ALSO yields zero calls, the
    // required calls are constructed deterministically and adopted for
    // normal execution — a silent provider cannot veto an executable MCP
    // request. Text-resolvable args first; mutations then get ONE bounded
    // live context assist (list_teams → team_id, …). All-or-nothing when a
    // required mutation is involved (a lone list must not masquerade as a
    // completed create); reads-only sets force directly. Unresolved
    // mutations are reported for the caller's clarification fallback —
    // never invented IDs. Bounded, each tool at most once, never loops.
    // Mutation test shared by recovery and preflight (generic capability
    // evidence, never names): a schema declaring any mutating capability.
    // Reads/lists/searches are side-effect-free and independently useful;
    // mutations need complete intent. Pure.
    isMutationSchema(s) {
        try {
            const c = declareToolCapabilities(s);
            return !!(c && (c.has('CREATE') || c.has('UPDATE') || c.has('DELETE') || c.has('SEND') || c.has('COMMENT') || c.has('UPLOAD')));
        } catch {
            return false;
        }
    }

    async runMcpRecovery({ plan, messages, systemPrompt, maxTokens, temperature, userContext, attachments, signal, metadata, generate, baseText, mcpSchemas, execFn, serverScope = [] }) {
        const fail = (extra = {}) => ({ recovered: false, toolCalls: [], text: '', response: null, unresolved: [], ...extra });
        const isMutationSchema = (s) => this.isMutationSchema(s);
        const scope = Array.isArray(serverScope) ? serverScope.filter((s) => typeof s === 'string' && s) : [];
        try {
            if (!plan || !Array.isArray(plan.retryTools) || !plan.retryTools.length) return fail();
            // Irrelevant-tool gate (mirrors preflight): retrying — or worse,
            // deterministically constructing — an entity/intent-mismatched
            // tool (save_comment for CREATE(ISSUE)) can only produce a
            // wrong-entity execution or a confabulated answer. Gate the
            // retry set first; gated tools are reported, never retried,
            // never constructed.
            let retryIntent = null;
            try { retryIntent = classifyIntentCapabilities(baseText); } catch { retryIntent = new Set(); }
            const retryTools = [];
            const gatedOut = [];
            try {
                for (const schema of (plan.retryTools || [])) {
                    const check = this.gatePreflightCandidate(schema, retryIntent, baseText);
                    if (check.ok) {
                        retryTools.push(schema);
                    } else {
                        try { console.error('[AIService] mcpRecovery.irrelevantRejected', { tool: check.name, reason: check.reason }); } catch { /* diagnostics only */ }
                        gatedOut.push({ tool: check.name || schema?.function?.name, missing: [], options: {}, reason: 'capability-mismatch' });
                    }
                }
            } catch { for (const s of (plan.retryTools || [])) if (!retryTools.includes(s)) retryTools.push(s); }
            if (!retryTools.length) {
                return fail({ capabilityMismatch: gatedOut.length > 0, unresolved: gatedOut });
            }
            const retryNames = new Set(retryTools.map((s) => s?.function?.name).filter(Boolean));
            const forcedName = (typeof plan.forcedTool === 'string' && retryNames.has(plan.forcedTool))
                ? plan.forcedTool
                : null;
            const retryPrompt = this.refreshInventoryPrompt(
                systemPrompt,
                this.mcpInventoryBlockForTools(retryTools, { metadata: metadata || null, failures: [] })
            );
            const gen = typeof generate === 'function' ? generate : ((req) => this.llmRouter.generate(req));
            const retry = await gen({
                messages,
                systemPrompt: retryPrompt,
                tools: retryTools,
                forcedTool: forcedName || undefined,
                stream: false,
                maxTokens,
                temperature,
                userContext,
                attachments,
                signal
            });
            const calls = Array.isArray(retry?.toolCalls) ? retry.toolCalls : [];
            let exposure = { exposedCalls: calls, unexposedNames: [] };
            try { exposure = partitionToolCallsByExposure(calls, retryTools); } catch { /* fail open */ }
            if (exposure.unexposedNames.length) {
                console.error('[AIService] recovery tool-call exposure violation', { unexposed: exposure.unexposedNames });
            }
            // Each required tool executes at most once: drop identical
            // (name + args) duplicates the model may have stuttered.
            const seen = new Set();
            const deduped = [];
            for (const tc of exposure.exposedCalls) {
                let argsKey = '';
                try {
                    argsKey = typeof tc?.function?.arguments === 'string'
                        ? tc.function.arguments : JSON.stringify(tc?.function?.arguments || {});
                } catch { argsKey = ''; }
                const key = `${tc?.function?.name || tc?.name}::${argsKey}`;
                if (seen.has(key)) continue;
                seen.add(key);
                deduped.push(tc);
            }
            if (!deduped.length) {
                // The constrained retry stayed silent too. Deterministic
                // final stage (all-or-nothing when a required mutation is
                // involved): resolve every required schema — strict text
                // args first, then ONE bounded live context assist for
                // mutations (list_teams → team_id, …). Adopted into normal
                // execution below; unresolvable mutations are reported for
                // the caller's clarification fallback. Never invented IDs.
                const forced = [];
                const unresolved = [];
                let burn = CREATION_RESOLVER_BUDGET;
                try {
                    for (const schema of retryTools) {
                        if (forced.length >= 4) break;
                        const name = schema?.function?.name;
                        if (typeof name !== 'string' || !name) continue;
                        if (forced.some((c) => c?.function?.name === name)) continue;
                        // Scope + callability assertion before construction:
                        // out-of-scope or not-in-request.tools schemas are
                        // rejected here, never executed (diagnostic, not
                        // silent drop — the unresolved entry explains why).
                        if (scope.length) {
                            let key = '';
                            try { key = mcpServerKeyOf(name); } catch { key = ''; }
                            let inScope = false;
                            try { inScope = scope.some((s) => mcpScopeMatches(s, key)); } catch { inScope = false; }
                            if (!key || !inScope) {
                                try {
                                    console.error('[AIService] mcpRecovery.scopeRejected', { tool: name, scope });
                                } catch { /* diagnostics only */ }
                                continue;
                            }
                        }
                        let resolved = null;
                        const updateMode = this.upsertUpdateMode(schema, { intentCaps: retryIntent, text: baseText });
                        try { resolved = this.resolveEnforcementArgs(schema, baseText, { updateMode }); } catch { resolved = null; }
                        if ((!resolved || !resolved.ok) && typeof execFn === 'function'
                            && Array.isArray(mcpSchemas) && mcpSchemas.length && burn > 0) {
                            try {
                                const live = await this.resolveMutationContextLive({
                                    argSchema: schema, execName: name, baseArgs: {},
                                    userText: baseText, mcpSchemas, execFn, budget: burn,
                                    updateMode
                                });
                                burn -= Number(live.used) || 0;
                                if (live.ok) resolved = { ok: true, args: live.args };
                                else if (live.missing && live.missing.length) {
                                    unresolved.push({ tool: name, missing: live.missing, options: live.options || {} });
                                }
                            } catch { /* live assist must never throw */ }
                        }
                        if (!resolved || !resolved.ok) {
                            if (!unresolved.some((u) => u.tool === name)) {
                                let missing = [];
                                try {
                                    const v = validateArgs(schema, {});
                                    const extra = missingEffective(schema, {}, { updateMode });
                                    missing = [...new Set([...v.errors.map((e) => e.name), ...extra])];
                                } catch { missing = []; }
                                if (missing.length) unresolved.push({ tool: name, missing, options: {} });
                            }
                            continue;
                        }
                        forced.push({
                            id: `enforced-${name.replace(/[^a-z0-9]+/gi, '').slice(0, 32)}-${Date.now().toString(36)}`,
                            function: { name, arguments: resolved.args }
                        });
                    }
                } catch { /* deterministic construction must never throw */ }
                const mutations = retryTools.filter(isMutationSchema);
                const forcedNames = new Set(forced.map((c) => c?.function?.name));
                const allMutationsResolved = mutations.every((s) => forcedNames.has(s?.function?.name));
                if (forced.length && (mutations.length === 0 || allMutationsResolved)) {
                    try {
                        console.log('[AIService] mcpRecovery.enforced', {
                            tools: forced.map((c) => c?.function?.name).filter(Boolean)
                        });
                    } catch { /* diagnostics only */ }
                    return {
                        recovered: true,
                        enforced: true,
                        toolCalls: forced,
                        text: '',
                        response: retry,
                        tools: retryTools,
                        systemPrompt: retryPrompt
                    };
                }
                return fail({
                    text: typeof retry?.text === 'string' ? retry.text : '',
                    response: retry,
                    tools: retryTools,
                    systemPrompt: retryPrompt,
                    unresolved: [...unresolved, ...gatedOut]
                });
            }
            try {
                const executedNames = deduped.map((t) => t?.function?.name || t?.name).filter(Boolean);
                console.log('[AIService] mcpRecovery.executed', { tools: executedNames });
            } catch { /* diagnostics only */ }
            return {
                recovered: true,
                toolCalls: deduped,
                text: typeof retry?.text === 'string' ? retry.text : '',
                response: retry,
                tools: retryTools,
                systemPrompt: retryPrompt
            };
        } catch (err) {
            console.log('[AIService] mcpRecovery.failed', { reason: err?.message || 'error' });
            return fail();
        }
    }

    // Intent/capability + entity gate (§CREATE correctness, shared by
    // preflight and recovery): a candidate must declare a requested
    // capability AND — for entity-bound write intents — target a requested
    // entity. A READ(COMMENT)/READ(LABEL)/READ(TEMPLATE) tool can never
    // satisfy CREATE(ISSUE): lexical overlap alone ("issue" mentioned in
    // passing) is not evidence. Generic capability/entity evidence only,
    // no vendors. Returns { ok, reason } — reason is null when ok, else
    // 'no-declared-capability' | 'intent-mismatch' | 'entity-mismatch'.
    // Pure (never logs, never throws).
    gatePreflightCandidate(schema, intentCaps, baseText) {
        try {
            const intent = intentCaps instanceof Set ? intentCaps : new Set();
            const name = schema?.function?.name;
            let declared = null;
            try { declared = declareToolCapabilities(schema); } catch { declared = null; }
            if (!declared) return { ok: false, reason: 'no-declared-capability', name };
            const sharesIntent = intent.size === 0
                ? true
                : [...declared].some((c) => intent.has(c)
                    // READ ↔ LIST bridge (mirrors selection): a listing
                    // satisfies a read and vice versa.
                    || (c === 'READ' && intent.has('LIST'))
                    || (c === 'LIST' && intent.has('READ')));
            if (!sharesIntent) return { ok: false, reason: 'intent-mismatch', name };
            // Entity check for entity-bound write intents (mirrors
            // selection: CREATE/UPDATE/DELETE/COMMENT only — generic action
            // verbs name processes, not objects). The tool's target entity
            // must match a request token (or the tool must be entity-blind
            // with no whole entity to contradict). Read-only requests keep
            // the looser selection behavior.
            try {
                const wantsStrictMutation = [...intent].some((c) =>
                    ['CREATE', 'UPDATE', 'DELETE', 'COMMENT'].includes(c));
                if (wantsStrictMutation) {
                    const te = String(toolEntityStem(schema) || '').toLowerCase();
                    if (te) {
                        const stem = (t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
                        const teStem = stem(te);
                        const queryStems = new Set(
                            String(baseText || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []
                        );
                        const entityOk = [...queryStems].some((q) => {
                            const qs = stem(q);
                            return qs === teStem || `${qs}s` === teStem || qs === `${teStem}s`;
                        });
                        if (!entityOk) return { ok: false, reason: 'entity-mismatch', name };
                    }
                }
            } catch { /* entity evidence is advisory */ }
            return { ok: true, reason: null, name };
        } catch {
            return { ok: false, reason: 'no-declared-capability', name: schema?.function?.name };
        }
    }

    // ---- Authoritative MCP preflight (single path) ---------------------------
    // USER MESSAGE → MCP PREFLIGHT → native/LLM as needed → MCP EXECUTION
    // → LLM SYNTHESIS. For qualifying requests the required MCP tools
    // execute BEFORE any free provider round: the model synthesizes real
    // results but can never veto an authorized capability ("only comments"
    // confabulation becomes structurally impossible — there is no model
    // decision point before execution). Qualification uses the existing
    // strict resolver (reads with no required params, quoted /
    // proper-substring values, schema defaults): a set with NO required
    // mutation forces every resolvable member (id-requiring single-getters
    // that share nothing resolvable simply stay for continuation); a set
    // WITH a required mutation is all-or-nothing, so a lone list can never
    // masquerade as a completed create. Anything less falls through to the
    // normal model-driven path untouched.
    // Lifecycle mirrors the existing execution.* socket channel so the
    // realtime panel renders PLAN → EXECUTING → COMPLETED from the same
    // events. Bounded (≤4 calls), each tool at most once, signal-aware.
    // Returns { plan, executed, toolCalls } — executed entries carry
    // { toolCallId, name, content } ready for continuation synthesis.
    async runMcpPreflight({ requiredSchemas, tools, baseText, intentCaps, execFn, socket, workspaceId, signal, title, serverScope = [], mcpSchemas = [] } = {}) {
        const scope = Array.isArray(serverScope) ? serverScope.filter((s) => typeof s === 'string' && s) : [];
        const emptyPlan = (executable, needsClarification) => ({
            source: 'mcp',
            executable: Boolean(executable),
            capabilities: [],
            tools: [],
            serverScope: [...scope],
            needsClarification: Boolean(needsClarification)
        });
        const done = (plan, executed, toolCalls) => ({ plan, executed, toolCalls });
        try {
            const required = (Array.isArray(requiredSchemas) ? requiredSchemas : [])
                .filter((s) => s && typeof s?.function?.name === 'string');
            const intent = intentCaps instanceof Set ? intentCaps : new Set();
            if (!required.length) {
                return done(emptyPlan(false, false), [], []);
            }
            // Pre-execution assertions (§7): each forced call must belong to
            // the requested server scope (when scoped) and to the final
            // request.tools set — otherwise it is rejected here, before
            // TaskExecutor, with a diagnostic (never silently dropped, never
            // executed cross-scope).
            const offeredNames = new Set(
                (Array.isArray(tools) ? tools : []).map((s) => s?.function?.name).filter(Boolean)
            );
            const scoped = [];
            for (const schema of required) {
                const name = schema?.function?.name;
                if (typeof name !== 'string' || !name) continue;
                if (!offeredNames.has(name)) {
                    try {
                        console.error('[AIService] mcpPreflight.notCallable', { tool: name });
                    } catch { /* diagnostics only */ }
                    continue;
                }
                if (scope.length) {
                    let key = '';
                    try { key = mcpServerKeyOf(name); } catch { key = ''; }
                    let inScope = false;
                    try { inScope = scope.some((s) => mcpScopeMatches(s, key)); } catch { inScope = false; }
                    if (!key || !inScope) {
                        try {
                            console.error('[AIService] mcpPreflight.scopeRejected', { tool: name, scope });
                        } catch { /* diagnostics only */ }
                        continue;
                    }
                }
                scoped.push(schema);
            }
            if (!scoped.length) {
                return done(emptyPlan(false, false), [], []);
            }
            // Intent/capability + entity gate (§CREATE correctness): every
            // preflight candidate must declare a requested capability AND
            // target a requested entity. A READ(COMMENT)/READ(LABEL)/
            // READ(TEMPLATE) tool can never satisfy CREATE(ISSUE) — lexical
            // overlap alone ("issue" mentioned in passing) is not evidence.
            // Candidates failing the gate are rejected here, before
            // TaskExecutor, with a diagnostic — never executed "because
            // callable". Generic capability/entity evidence only, no vendors.
            const gated = [];
            try {
                for (const schema of scoped) {
                    const name = schema?.function?.name;
                    const check = this.gatePreflightCandidate(schema, intent, baseText);
                    if (!check.ok) {
                        try { console.error('[AIService] mcpPreflight.irrelevantRejected', { tool: name, reason: check.reason }); } catch { /* diagnostics only */ }
                        continue;
                    }
                    gated.push(schema);
                }
            } catch { for (const s of scoped) if (!gated.includes(s)) gated.push(s); }
            if (!gated.length) {
                try {
                    console.log('[AIService] mcpPreflight.skip', {
                        tools: scoped.map((s) => s?.function?.name),
                        resolved: []
                    });
                } catch { /* diagnostics only */ }
                const plan = emptyPlan(true, false);
                plan.capabilities = [];
                return done(plan, [], []);
            }
            // Capability labels CAP(ENTITY) from schema declarations ∩
            // intent, entity from the bare tool name. Generic only.
            const capabilities = [];
            try {
                const { CAPABILITY_PICK_ORDER } = require('../lib/llm/toolSelection');
                for (const schema of gated) {
                    let declared = null;
                    try { declared = declareToolCapabilities(schema); } catch { declared = null; }
                    if (!declared) continue;
                    const cap = (Array.isArray(CAPABILITY_PICK_ORDER) ? CAPABILITY_PICK_ORDER : [])
                        .find((c) => intent.has(c) && declared.has(c)) || null;
                    if (!cap) continue;
                    let entity = '';
                    try { entity = String(toolEntityStem(schema) || '').toUpperCase(); } catch { entity = ''; }
                    const label = entity ? `${cap}(${entity})` : cap;
                    if (!capabilities.includes(label)) capabilities.push(label);
                }
            } catch { /* labels are advisory */ }
            // Partition: mutations execute as the plan; non-mutation members
            // are creation-context resolver candidates (same-server LIST/READ
            // pool), never independent preflight steps beside a mutation —
            // otherwise a lone list masquerades as a completed create.
            // Intent-scoped: a schema is a mutation FOR THIS TURN only when
            // it declares a mutating capability the request actually asks
            // for. A description-incidental declaration ("label records can
            // be created…") must not promote a reader into the mutation set
            // on a pure LIST turn and crowd out the real reads.
            const MUTATION_CAPS = new Set(['CREATE', 'UPDATE', 'DELETE', 'SEND', 'COMMENT', 'UPLOAD', 'DOWNLOAD', 'EXECUTE', 'MOVE', 'DUPLICATE', 'ARCHIVE', 'RESTORE']);
            const isMutationForTurn = (s) => {
                if (!this.isMutationSchema(s)) return false;
                try {
                    const declared = declareToolCapabilities(s);
                    if (!declared) return false;
                    for (const c of declared) {
                        if (MUTATION_CAPS.has(c) && intent.has(c)) return true;
                    }
                    return false;
                } catch { return false; }
            };
            const mutations = gated.filter((s) => isMutationForTurn(s));
            const mutationNames = new Set(mutations.map((s) => s?.function?.name));
            const planSchemas = mutations.length ? mutations : gated;
            const wireNames = planSchemas.map((s) => s.function.name);
            const plan = {
                source: 'mcp',
                executable: true,
                capabilities,
                tools: [...wireNames],
                serverScope: [...scope],
                needsClarification: false
            };
            // Strict resolution from the user text, then ONE bounded live
            // creation-context assist per unresolved mutation (same-server
            // LIST/READ resolvers: single candidate auto-fills, named
            // candidate fills, several unnamed → clarification options, never
            // invented IDs). Resolver pool: the full scoped exposed set when
            // provided, else the request tools.
            const pool = Array.isArray(mcpSchemas) && mcpSchemas.length
                ? mcpSchemas
                : (Array.isArray(tools) ? tools : []);
            const resolved = [];
            let resolverBurn = CREATION_RESOLVER_BUDGET;
            const unresolved = [];
            for (const schema of planSchemas) {
                if (resolved.length >= 4) break;
                const name = schema?.function?.name;
                if (typeof name !== 'string' || !name) continue;
                if (resolved.some((r) => r.name === name)) continue;
                // Upsert mode for this candidate: UPDATE-without-CREATE
                // intent (or a pasted entity id) selects update semantics —
                // conditional creation requirements then do not apply.
                const updateMode = this.upsertUpdateMode(schema, { intentCaps: intent, text: baseText });
                let r = null;
                try { r = this.resolveEnforcementArgs(schema, baseText, { updateMode }); } catch { r = null; }
                if (r && r.ok) {
                    // Update mode without a resolved entity id must NOT
                    // preflight: the target has to be searched first, which
                    // is the model-driven target-resolution path's job — a
                    // bare update call would fail truthfully at best.
                    if (updateMode && mutationNames.has(name)) {
                        let hasId = false;
                        try { hasId = this.hasEntityIdValue(schema, r.args || {}); } catch { hasId = false; }
                        if (!hasId) continue;
                    }
                    resolved.push({ schema, name, args: r.args });
                    continue;
                }
                // Mutations get live context assist; pure lookups keep the
                // legacy strict-only behavior (unresolvable id-gated getters
                // stay for continuation).
                if (mutationNames.has(name) && typeof execFn === 'function' && resolverBurn > 0) {
                    try {
                        const live = await this.resolveMutationContextLive({
                            argSchema: schema, execName: name, baseArgs: {},
                            userText: baseText, mcpSchemas: pool, execFn,
                            budget: resolverBurn, updateMode
                        });
                        resolverBurn -= Number(live.used) || 0;
                        if (live.ok) {
                            try { console.log('[AIService] mcpPreflight.contextResolved', { tool: name }); } catch { /* diagnostics only */ }
                            resolved.push({ schema, name, args: live.args });
                            continue;
                        }
                        if (live.missing && live.missing.length) {
                            unresolved.push({ tool: name, missing: live.missing, options: live.options || {} });
                        }
                    } catch { /* live assist must never throw */ }
                }
            }
            const resolvedNames = new Set(resolved.map((r) => r.name));
            const mutationsOk = planSchemas
                .filter((s) => isMutationForTurn(s))
                .every((s) => resolvedNames.has(s?.function?.name));
            // All-or-nothing when a mutation is involved: a lone list must
            // never masquerade as a completed create. Either the mutation
            // resolves and executes, or nothing executes and the plan asks
            // for the missing creation context.
            if (!resolved.length || !mutationsOk) {
                plan.needsClarification = true;
                if (unresolved.length) {
                    plan.unresolved = unresolved;
                    try {
                        const options = {};
                        for (const u of unresolved) {
                            for (const [pname, items] of Object.entries(u.options || {})) {
                                if (Array.isArray(items) && items.length) options[pname] = items.slice(0, 5);
                            }
                        }
                        if (Object.keys(options).length) plan.options = options;
                    } catch { /* options are advisory */ }
                }
                try {
                    console.log('[AIService] mcpPreflight.skip', {
                        tools: wireNames,
                        resolved: resolved.map((r) => r.name)
                    });
                } catch { /* diagnostics only */ }
                return done(plan, [], []);
            }
            try {
                console.log('[AIService] mcpPreflight.plan', {
                    tools: wireNames,
                    capabilities
                });
            } catch { /* diagnostics only */ }
            if (typeof execFn !== 'function') {
                return done(plan, [], []);
            }
            const executionId = `mcp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
            const emit = (event, payload) => {
                try {
                    if (socket && !socket.isInterrupted) {
                        socket.emit(event, { ...(payload || {}), workspaceId: workspaceId != null ? String(workspaceId) : null });
                    }
                } catch { /* status must never break execution */ }
            };
            const planTitle = String(title || baseText || '').slice(0, 120) || 'MCP execution';
            const stepIds = resolved.map((_, i) => `${executionId}-step-${i}`);
            emit('execution.created', {
                executionId,
                title: planTitle,
                steps: resolved.map((r, i) => ({ id: stepIds[i], tool: r.name, status: 'PLANNED' }))
            });
            emit('execution.started', { executionId, status: 'RUNNING' });
            const executed = [];
            const toolCalls = [];
            let cancelled = false;
            for (let i = 0; i < resolved.length; i += 1) {
                const { schema, name, args } = resolved[i];
                void schema;
                if ((socket && socket.isInterrupted) || (signal && signal.aborted)) {
                    cancelled = true;
                    break;
                }
                const callId = `preflight-${stepIds[i]}`;
                emit('execution.step.started', { executionId, stepId: stepIds[i], tool: name });
                let content = null;
                try {
                    content = await execFn(name, args);
                } catch (execErr) {
                    content = { success: false, error: execErr?.message || 'Tool execution failed.' };
                }
                if (content && typeof content === 'object' && content.clientAction && socket && !socket.isInterrupted) {
                    try { socket.emit('ai:client:action', content.clientAction); } catch { /* advisory */ }
                }
                const ok = Boolean(content && content.success);
                emit('execution.step.completed', {
                    executionId,
                    stepId: stepIds[i],
                    status: ok ? 'COMPLETED' : 'FAILED',
                    result: content,
                    tool: name
                });
                executed.push({ toolCallId: callId, name, content });
                toolCalls.push({ id: callId, function: { name, arguments: args } });
            }
            emit('execution.completed', { executionId, status: cancelled ? 'CANCELLED' : (executed.length ? 'COMPLETED' : 'FAILED') });
            try {
                console.log('[AIService] mcpPreflight.executed', {
                    tools: executed.map((e) => e.name),
                    cancelled
                });
            } catch { /* diagnostics only */ }
            return done(plan, executed, toolCalls);
        } catch (err) {
            console.log('[AIService] mcpPreflight.failed', { reason: err?.message || 'error' });
            return done(emptyPlan(false, false), [], []);
        }
    }

    // Required MCP schemas for a turn: capability picks + supporting
    // creation-context resolvers, intersected with the final
    // provider-visible tools (visibility invariant holds everywhere).
    // Pure over caller state. Generic, no vendors.
    requiredMcpSchemas(toolPick, supportingMcp, tools) {
        try {
            const names = [
                ...(Array.isArray(toolPick?.mcpCapability) ? toolPick.mcpCapability : []),
                ...(Array.isArray(supportingMcp) ? supportingMcp : [])
            ];
            const seen = new Set();
            const out = [];
            const pool = Array.isArray(tools) ? tools : [];
            for (const n of names) {
                if (typeof n !== 'string' || !n || seen.has(n)) continue;
                seen.add(n);
                const hit = pool.find((s) => s?.function?.name === n);
                if (hit) out.push(hit);
            }
            return out;
        } catch {
            return [];
        }
    }

    // Deny-wins gate for pending state: native tools resolve via the local
    // registry; MCP tools ONLY via the currently exposed (policy-permitted)
    // set — a denied or allowlisted-out tool can never enter or resume a
    // pending execution, even if the user explicitly names it.
    isPendingPermitted(toolName, mcpSchemas) {
        if (!toolName) return false;
        try {
            if (toolRegistry.getTool(toolName)) return true;
        } catch {
            // fall through to the MCP check below
        }
        return (Array.isArray(mcpSchemas) ? mcpSchemas : []).some((s) => s?.function?.name === toolName);
    }

    async emitAssistantText(socket, text) {
        await this.streamingRuntime.emitText(socket, text);
    }

    // ---- Generic creation-context resolution (save/upsert CREATE fix) ----
    // A mutation tool (save_issue and friends) may REQUIRE creation context
    // the user never types: team_id, project_id, … The user must never be
    // asked for raw internal IDs when the integration itself can enumerate
    // them. These helpers are generic — parameter-name stems, bare tool-name
    // tokens, and id/name result fields only; never tool names or vendors.
    //
    // Flow for a pure-CREATE call with missing required params:
    //   content params (title/description/…) → quoted-span mapping, else ask
    //   context params (team_id/…) → list via exposed LIST/READ tools:
    //     exactly one candidate → fill automatically
    //     several + user named one → fill the named one
    //     several + unnamed → concise clarification WITH options (pending)
    //     none/unparseable → leave missing (truthful ask, never invent IDs)

    // Classify one missing required param against the tool's own entity:
    // { kind: 'context', stem } (resolvable scope) |
    // { kind: 'entityId', stem } (the object's own reference — never enumerate) |
    // { kind: 'content' } (user-supplied text).
    classifyMissingParam(paramName, toolEntity) {
        try {
            const raw = String(paramName || '').trim();
            if (!raw) return { kind: 'content', stem: '' };
            // Strip identifier suffixes with boundary discipline (mirrors
            // pendingArgs: 'valid'/'invalid' must NOT match): snake_case
            // `team_id` → team, camelCase `teamId` → team, bare `id` stays.
            let stem = raw;
            const snake = stem.match(/^(.*)_(id|uuid|url|uri|urn|guid|handle|slug|key)$/i);
            if (snake && snake[1]) {
                stem = snake[1];
            } else {
                const camel = stem.match(/^(.*[a-z])(Id|Uuid|Url|Uri|Urn|Guid|Handle|Slug|Key)$/);
                if (camel && camel[1]) stem = camel[1];
            }
            stem = stem.toLowerCase();
            const entity = String(toolEntity || '').toLowerCase();
            if (entity && (stem === entity || `${stem}s` === entity || stem === `${entity}s`)) {
                return { kind: 'entityId', stem };
            }
            if (stem && CREATION_CONTEXT_NOUNS.has(stem)) return { kind: 'context', stem };
            return { kind: 'content', stem };
        } catch {
            return { kind: 'content', stem: '' };
        }
    }

    // Exposed LIST/READ schemas whose bare tool name mentions the entity
    // stem (list_teams ← team), ranked LIST-first then most specific.
    // Policy-permitted only (callers pass the exposed set) — deny-wins.
    findContextResolvers(entityStem, mcpSchemas, excludeName = null) {
        const out = [];
        try {
            const stem = String(entityStem || '').toLowerCase();
            if (!stem) return out;
            for (const s of (Array.isArray(mcpSchemas) ? mcpSchemas : []).slice(0, 64)) {
                const name = s?.function?.name;
                if (typeof name !== 'string' || !name || name === excludeName) continue;
                let caps = null;
                try { caps = declareToolCapabilities(s); } catch { caps = null; }
                if (!caps || (!caps.has('LIST') && !caps.has('READ') && !caps.has('SEARCH'))) continue;
                let bare = '';
                try {
                    const { bareToolNameOf } = require('../lib/llm/toolSelection');
                    bare = String(bareToolNameOf(s) || '').toLowerCase();
                } catch { bare = String(name || '').toLowerCase(); }
                const tokens = bare.split(/[^a-z0-9]+/).filter(Boolean);
                const sameEntity = (t, s) => t === s || `${t}s` === s || t === `${s}s`;
                const hit = tokens.some((t) => sameEntity(t, stem)
                    || (t.length > 4 && stem.length > 4 && (t.startsWith(stem) || stem.startsWith(t))));
                if (!hit) continue;
                out.push({ schema: s, name, listFirst: caps.has('LIST') ? 0 : 1, capCount: caps.size });
                if (out.length >= 6) break;
            }
        } catch {
            return [];
        }
        out.sort((a, b) => (a.listFirst - b.listFirst) || (a.capCount - b.capCount) || (a.name < b.name ? -1 : 1));
        return out.slice(0, 3).map((e) => e.schema);
    }

    // Normalize one tool-result payload into [{ id, name }] candidates.
    // Accepts TaskExecutor shapes ({ success, result: jsonText }) and raw
    // arrays / { items|results|data } envelopes. Unparseable → []. Pure.
    extractResultItems(result) {
        try {
            let payload = result;
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch { return []; }
            } else if (payload && typeof payload === 'object' && typeof payload.result === 'string') {
                try { payload = JSON.parse(payload.result); } catch { return []; }
            }
            let arr = null;
            if (Array.isArray(payload)) arr = payload;
            else if (payload && typeof payload === 'object') {
                for (const k of ['items', 'results', 'data', 'teams', 'projects']) {
                    if (Array.isArray(payload[k])) { arr = payload[k]; break; }
                }
            }
            if (!arr) return [];
            return arr.slice(0, 25).map((it) => {
                if (it && typeof it === 'object') {
                    const id = it.id ?? it.uuid ?? it.key ?? it.identifier ?? it.value ?? null;
                    const name = it.name ?? it.title ?? it.label ?? null;
                    return {
                        id: id == null ? null : String(id),
                        name: name == null ? null : String(name)
                    };
                }
                return { id: null, name: String(it ?? '') };
            }).filter((e) => e.id || e.name);
        } catch {
            return [];
        }
    }

    // Unique name hit of user text against candidates (case-insensitive).
    // Ambiguous or absent → null (caller asks instead of guessing). Pure.
    matchCandidateByName(items, text) {
        try {
            const lowered = String(text || '').toLowerCase();
            if (!lowered.trim()) return null;
            const hits = (Array.isArray(items) ? items : []).filter((it) => {
                const n = String(it?.name || '').toLowerCase().trim();
                return n.length >= 3 && lowered.includes(n);
            });
            if (hits.length !== 1) return null;
            return hits[0];
        } catch {
            return null;
        }
    }

    // Name-anchored quote mapping (generic, never vendors): a quoted span
    // immediately following an open-content param's NAME ("description
    // '...'", "title: 'X'") belongs to that param — the only unambiguous
    // evidence for OPTIONAL content slots, which positional mapping must
    // never guess. Returns { mapping, usedIndices }. Pure, never throws.
    mapNamedQuotes(text, candidates) {
        const mapping = {};
        const usedIndices = new Set();
        try {
            const flat = String(text || '');
            if (!flat.trim()) return { mapping, usedIndices };
            const quotes = [];
            for (const m of flat.matchAll(/"([^"]+)"|'([^']+)'/g)) {
                const q = (m[1] !== undefined ? m[1] : m[2] || '').trim();
                if (q && flat.includes(q) && q.length < flat.length) quotes.push({ text: q, index: m.index });
            }
            if (!quotes.length) return { mapping, usedIndices };
            const esc = (s) => String(s || '').replace(/[^a-z0-9]+/gi, ' ').trim().replace(/\s+/g, '\\s+');
            (Array.isArray(candidates) ? candidates : []).forEach((name, ci) => {
                if (typeof name !== 'string' || !name || mapping[name] !== undefined) return;
                const pattern = esc(name);
                if (!pattern) return;
                const re = new RegExp(`\\b${pattern}\\b\\s*[:=]?\\s*("([^"]+)"|'([^']+)')`, 'i');
                const m = flat.match(re);
                if (!m) return;
                const q = ((m[2] !== undefined ? m[2] : m[3]) || '').trim();
                if (!q) return;
                const qi = quotes.findIndex((qq, idx) => !usedIndices.has(idx) && qq.text === q);
                if (qi === -1) return;
                // Lowest unused matching index wins; ties prefer schema order
                // via the candidates iteration (first claimant keeps it).
                mapping[name] = q;
                usedIndices.add(qi);
                void ci;
            });
        } catch { /* mapping must never throw */ }
        return { mapping, usedIndices };
    }

    // Live mutation-context fill shared by the in-turn creation path and
    // the enforcement direct stage. Starts from model- or text-supplied
    // baseArgs, maps quoted spans onto missing content strings, then fills
    // creation-CONTEXT params (team_id, …) through the integration's own
    // LIST/READ tools: single candidate → automatic; named candidate →
    // automatic; several unnamed → options (caller clarifies, never
    // invents IDs); none → left missing. Bounded live reads (budget).
    // Returns { ok, args, merged, missing, options, used }. Pure except the
    // injected execFn (defaults to nobody — callers always pass one).
    async resolveMutationContextLive({ argSchema, execName, baseArgs = {}, userText = '', mcpSchemas = [], execFn = null, budget = CREATION_RESOLVER_BUDGET, updateMode = null } = {}) {
        const empty = { ok: false, args: {}, merged: {}, missing: [], options: {}, used: 0 };
        try {
            if (!argSchema) return empty;
            // Same-server resolvers only: an id from another integration is
            // never a valid fill (Linear team_id must come from Linear
            // tools). Derived from the caller's own wire identity; unknown
            // callers keep the caller-supplied pool untouched.
            let pool = Array.isArray(mcpSchemas) ? mcpSchemas : [];
            try {
                const callerKey = mcpServerKeyOf({ function: { name: execName } });
                if (callerKey) {
                    const same = pool.filter((s) => {
                        try { return mcpServerKeyOf(s) === callerKey; }
                        catch { return false; }
                    });
                    if (same.length) pool = same;
                }
            } catch { /* fail open to the supplied pool */ }
            // Mode-aware requirements: conditional "required when creating"
            // params join the set in create mode. Explicit caller mode wins;
            // otherwise a pasted entity id selects update mode.
            let mode = updateMode;
            if (typeof mode !== 'boolean') {
                try { mode = extractIdentifierValue(userText, 'id') !== undefined; } catch { mode = false; }
            }
            const params = effectiveRequiredParams(argSchema, { updateMode: mode });
            if (!params.length) return { ok: true, args: {}, merged: {}, missing: [], options: {}, used: 0 };
            const entity = toolEntityStem(argSchema);
            const byName = new Map(params.map((p) => [p.name, p]));
            let merged = {};
            try { merged = applyParamDefaults(argSchema, extractArgValues(userText, params)); } catch { merged = {}; }
            if (baseArgs && typeof baseArgs === 'object') {
                for (const [k, v] of Object.entries(baseArgs)) {
                    if (v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())) merged[k] = v;
                }
            }
            const missingNow = () => missingEffective(argSchema, merged, { updateMode: mode });
            // Quoted-span mapping, strict precedence (generic, never vendors):
            //   1. name-anchored spans ("description '…'") fill their param —
            //      required or optional — unambiguously;
            //   2. remaining quotes fill missing REQUIRED content strings
            //      (single → first quote; several → exact-count positional);
            //   3. creation-CONTEXT params (team, project, …) NEVER take
            //      quoted spans — their values come from same-server
            //      resolvers, so a description quote can never land in `team`.
            const isOpenContent = ({ name, def }) => {
                const d = (def && typeof def === 'object') ? def : {};
                if (isIdentifierParam(name)) return false;
                if (Array.isArray(d.enum) && d.enum.length) return false;
                if (['boolean', 'bool', 'integer', 'number'].includes(String(d.type || 'string').toLowerCase())) return false;
                return true;
            };
            const isContextName = (n) => {
                try { return this.classifyMissingParam(n, entity).kind === 'context'; } catch { return false; }
            };
            const flatQuotes = (() => {
                const out = [];
                try {
                    const flat = String(userText || '');
                    for (const m of flat.matchAll(/"([^"]+)"|'([^']+)'/g)) {
                        const q = (m[1] !== undefined ? m[1] : m[2] || '').trim();
                        if (q && flat.includes(q) && q.length < flat.length) out.push(q);
                    }
                } catch { /* quotes stay empty */ }
                return out;
            })();
            const schemaProps = (() => {
                try { return argSchema?.function?.parameters?.properties || {}; }
                catch { return {}; }
            })();
            const optionalContent = Object.entries(schemaProps)
                .filter(([n, d]) => typeof n === 'string' && n && !byName.has(n) && isOpenContent({ name: n, def: d }) && !isContextName(n))
                .map(([n]) => n);
            // 0. Anti-echo scrub FIRST: echo-filled values are not evidence —
            // clear them so they retake mapping/resolution below as missing.
            for (const n of [...byName.keys(), ...optionalContent]) {
                const v = merged[n];
                if (typeof v !== 'string' || !v.trim()) continue;
                const t = v.trim();
                if (flatQuotes.includes(t)) continue;
                const flat = String(userText || '').trim();
                if (flat && flat.includes(t) && t.length < flat.length) continue;
                delete merged[n];
            }
            // 1. Name-anchored spans.
            const named = this.mapNamedQuotes(userText, [...byName.keys(), ...optionalContent].filter((n) => {
                const d = byName.get(n)?.def;
                if (d !== undefined) return isOpenContent({ name: n, def: d }) && !isContextName(n);
                return optionalContent.includes(n);
            }));
            for (const [n, q] of Object.entries(named.mapping)) merged[n] = q;
            // 2. Required content spans (context excluded).
            const needy = params
                .filter((p) => isOpenContent(p) && !isContextName(p.name) && missingNow().includes(p.name))
                .map((p) => p.name);
            const freeQuotes = flatQuotes.filter((_, i) => !named.usedIndices.has(i));
            if (needy.length === 1 && freeQuotes.length) {
                merged[needy[0]] = freeQuotes[0];
            } else if (needy.length > 1 && freeQuotes.length === needy.length) {
                needy.forEach((n, i) => { merged[n] = freeQuotes[i]; });
            }
            // 3. Optional leftovers only on exact count equality (conservative:
            // never guess across several open slots).
            const stillFree = flatQuotes.filter((_, i) => !named.usedIndices.has(i))
                .filter((q) => !Object.values(merged).includes(q));
            const needyOptional = optionalContent.filter((n) => merged[n] === undefined);
            if (needyOptional.length && stillFree.length === needyOptional.length) {
                needyOptional.forEach((n, i) => { merged[n] = stillFree[i]; });
            }
            // Mode-aware revalidation: base schema validation PLUS
            // conditional creation requirements (a bare validateArgs passes
            // `{}` for schemas with empty `required`, which must never
            // count as a resolved create).
            const recheck = () => {
                const v = validateArgs(argSchema, merged);
                let extra = [];
                try { extra = missingEffective(argSchema, (v && v.coerced) || merged, { updateMode: mode }); } catch { extra = []; }
                const seen = new Set((v.errors || []).map((e) => e.name));
                const errors = [...(v.errors || []),
                    ...extra.filter((n) => !seen.has(n)).map((name) => ({ name, reason: 'required' }))];
                return { ok: errors.length === 0, errors, coerced: v.coerced };
            };
            let check = recheck();
            let missing = check.errors.map((e) => e.name);
            let used = 0;
            const options = {};
            const maxBurn = Math.max(0, Number(budget) || 0);
            for (const { name: pname } of params) {
                if (!missing.includes(pname)) continue;
                if (used >= maxBurn || typeof execFn !== 'function') break;
                const cls = this.classifyMissingParam(pname, entity);
                if (cls.kind !== 'context' || !cls.stem) continue;
                let pasted;
                try { pasted = extractIdentifierValue(userText, pname); } catch { pasted = undefined; }
                if (pasted !== undefined) {
                    merged[pname] = pasted;
                    check = recheck();
                    missing = check.errors.map((e) => e.name);
                    continue;
                }
                const resolvers = this.findContextResolvers(cls.stem, pool, execName);
                if (!resolvers.length) continue;
                let result = null;
                try { result = await execFn(resolvers[0]?.function?.name, {}); } catch { result = null; }
                used += 1;
                const items = this.extractResultItems(result);
                if (items.length === 1 && items[0]) {
                    const one = items[0];
                    const v = isIdentifierParam(pname) ? (one.id ?? one.name) : (one.name ?? one.id);
                    if (v) merged[pname] = v;
                } else if (items.length > 1) {
                    const hit = this.matchCandidateByName(items, userText);
                    if (hit) {
                        const v = isIdentifierParam(pname) ? (hit.id ?? hit.name) : (hit.name ?? hit.id);
                        if (v) merged[pname] = v;
                    } else {
                        options[pname] = items.slice(0, 5).map((i) => i.name || i.id).filter(Boolean);
                    }
                }
                check = recheck();
                missing = check.errors.map((e) => e.name);
            }
            check = recheck();
            return {
                ok: check.ok === true,
                args: check.coerced,
                merged,
                missing: check.errors.map((e) => e.name),
                options,
                used
            };
        } catch {
            return empty;
        }
    }

    // In-turn creation path for a pure-CREATE single tool call with missing
    // required args. Deterministic, no extra model round: resolve content +
    // context via resolveMutationContextLive, adopt the completed call, or
    // ask a concise clarification (with enumerated options) through the
    // normal pending flow. Returns { toolCalls } | { ask, pendingArgs,
    // options } | null (caller falls back to the generic ask flow).
    async tryCreationContext({ originalCall, execName, argSchema, intentCaps, userText = '', mcpSchemas = [], execFn = null } = {}) {
        try {
            if (!originalCall || !execName || !argSchema) return null;
            const pureCreate = intentCaps && intentCaps.has('CREATE')
                && !intentCaps.has('UPDATE') && !intentCaps.has('DELETE');
            if (!pureCreate) return null;
            let baseArgs = {};
            try {
                baseArgs = typeof originalCall?.function?.arguments === 'string'
                    ? JSON.parse(originalCall.function.arguments)
                    : { ...(originalCall?.function?.arguments || {}) };
            } catch { baseArgs = {}; }
            const live = await this.resolveMutationContextLive({
                argSchema, execName, baseArgs, userText, mcpSchemas, execFn,
                budget: CREATION_RESOLVER_BUDGET, updateMode: false
            });
            if (live.ok) {
                console.log('[AIService] creationContext.resolved', { tool: execName });
                return {
                    toolCalls: [{
                        id: originalCall?.id || `created-${Date.now().toString(36)}`,
                        function: { name: execName, arguments: live.args }
                    }],
                    text: ''
                };
            }
            if (live.missing && live.missing.length) {
                // Concise options for ambiguous scope ("team_id: A, B") so
                // the clarification names real candidates, never raw IDs.
                let optionsNote = '';
                try {
                    const bits = [];
                    for (const [pname, items] of Object.entries(live.options || {})) {
                        const list = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, 5);
                        if (list.length) bits.push(`Possible ${pname}: ${list.join(', ')}`);
                    }
                    if (bits.length) optionsNote = bits.join(' ');
                } catch { optionsNote = ''; }
                return { ask: true, pendingArgs: live.merged, options: live.options, optionsNote };
            }
            return null;
        } catch {
            return null;
        }
    }

    // Pending-resume candidate matching: the user is answering a pending
    // clarification for THIS tool. A context/entity id answered by NAME
    // ("Engineering") or resolved automatically (single candidate) fills
    // the slot; anything else falls through to the normal merge. Bounded
    // live reads over the pending tool's OWN server only (an id from
    // another integration is never a valid fill). Returns { param: value }.
    async matchPendingCandidateIds(text, pendingState, schema, mcpSchemas, execFn) {
        const fills = {};
        try {
            const missing = Array.isArray(pendingState?.missing) ? pendingState.missing : [];
            if (!missing.length || typeof execFn !== 'function') return fills;
            let pool = Array.isArray(mcpSchemas) ? mcpSchemas : [];
            try {
                const ownerKey = mcpServerKeyOf({ function: { name: pendingState?.toolName } });
                if (ownerKey) {
                    const same = pool.filter((s) => {
                        try { return mcpServerKeyOf(s) === ownerKey; }
                        catch { return false; }
                    });
                    if (same.length) pool = same;
                }
            } catch { /* fail open to the supplied pool */ }
            const entity = toolEntityStem(schema);
            let burn = 2;
            for (const name of missing) {
                if (burn <= 0) break;
                if (Object.prototype.hasOwnProperty.call(fills, name)) continue;
                const cls = this.classifyMissingParam(name, entity);
                if ((cls.kind !== 'context' && cls.kind !== 'entityId') || !cls.stem) continue;
                const resolvers = this.findContextResolvers(cls.stem, pool, pendingState?.toolName);
                if (!resolvers.length) continue;
                let result = null;
                try { result = await execFn(resolvers[0]?.function?.name, {}); } catch { result = null; }
                burn -= 1;
                const items = this.extractResultItems(result);
                if (items.length === 1 && items[0]) {
                    const one = items[0];
                    const v = isIdentifierParam(name) ? (one.id ?? one.name) : (one.name ?? one.id);
                    if (v) fills[name] = v;
                } else if (items.length > 1) {
                    const hit = this.matchCandidateByName(items, text);
                    if (hit) {
                        const v = isIdentifierParam(name) ? (hit.id ?? hit.name) : (hit.name ?? hit.id);
                        if (v) fills[name] = v;
                    }
                }
            }
        } catch {
            // Candidate matching must never break the pending flow.
        }
        return fills;
    }

    // Map quoted spans onto missing open-string params, under strict
    // preconditions so values are never misassigned. Single missing string
    // takes the first quote ("called 'X' with description 'Y'" with only
    // title missing → title=X). Several take quotes positionally only on
    // exact count equality. Every quote must be a proper substring.
    // Otherwise {} — the caller asks instead of misassigning. Pure.
    mapQuotedToMissingStrings(text, missingStringNames) {
        try {
            const flat = String(text || '').trim();
            const names = Array.isArray(missingStringNames) ? missingStringNames : [];
            if (!flat || !names.length) return {};
            const quotes = [];
            for (const m of flat.matchAll(/"([^"]+)"|'([^']+)'/g)) {
                const q = (m[1] !== undefined ? m[1] : m[2] || '').trim();
                if (q && flat.includes(q) && q.length < flat.length) quotes.push(q);
            }
            if (!quotes.length) return {};
            if (names.length === 1) return { [names[0]]: quotes[0] };
            if (quotes.length !== names.length) return {};
            const out = {};
            names.forEach((n, i) => { out[n] = quotes[i]; });
            return out;
        } catch {
            return {};
        }
    }

    // ---- Target-resolution chaining (generic MCP write fix) ----
    // Failure shape: the model calls an MCP write/update tool with the
    // target reference missing (no page ID yet — the user named a TITLE).
    // The required-arg gate below would previously end the turn by asking
    // the user for an internal ID. When the exposed (policy-permitted) set
    // contains SEARCH/READ-capable MCP tools, the agent resolves the target
    // ITSELF in-turn instead: one bounded resolve round (search/read), then
    // one retry round for the original call. Generic over all MCP servers:
    // capability declarations + identifier-shaped param names only, never
    // tool names, vendors, or URL shapes. Deny-wins preserved: resolvers
    // come solely from the exposed set, and a denied tool can never enter
    // or be retried here. Returns { toolCalls, text } on success, null when
    // resolution is inapplicable or fails (caller falls back to asking).
    findResolverSchemas(mcpSchemas, excludeName = null) {
        const out = [];
        try {
            const pool = Array.isArray(mcpSchemas) ? mcpSchemas : [];
            // Same-server resolvers first: resolving an id through another
            // integration's search would fill a foreign id (never valid).
            // Falls back to the full pool when the owner server exposes no
            // resolver, preserving existing behavior.
            let ordered = pool;
            try {
                const ownerKey = mcpServerKeyOf({ function: { name: excludeName } });
                if (ownerKey) {
                    const same = pool.filter((s) => {
                        try { return mcpServerKeyOf(s) === ownerKey; }
                        catch { return false; }
                    });
                    if (same.length) ordered = [...same, ...pool.filter((s) => {
                        try { return mcpServerKeyOf(s) !== ownerKey; }
                        catch { return true; }
                    })];
                }
            } catch { /* fail open to pool order */ }
            for (const s of ordered.slice(0, 24)) {
                const name = s?.function?.name;
                if (typeof name !== 'string' || !name || name === excludeName) continue;
                let caps = null;
                try { caps = declareToolCapabilities(s); } catch { caps = null; }
                if (caps && (caps.has('SEARCH') || caps.has('READ'))) out.push(s);
                if (out.length >= 4) break;
            }
        } catch {
            return [];
        }
        return out;
    }

    async tryTargetResolution({
        originalCall, execName, argSchema, missing, intentCaps,
        messages, systemPrompt, mcpSchemas,
        maxTokens, userId, isGuest, calendarIntent, requestKey,
        signal, conversationId, workspaceId, socket
    }) {
        try {
            if (!originalCall || !execName || !argSchema) return null;
            const missed = Array.isArray(missing) ? missing : [];
            // Only identifier-shaped gaps are self-resolvable ("which page").
            // Anything else (missing content/body/payload) genuinely needs
            // the user or the model — never burn resolve rounds on it.
            if (!missed.length || !missed.every((n) => isIdentifierParam(n))) return null;
            // Action gate (§4 rule): resolution operates ON EXISTING
            // resources only (UPDATE/DELETE …). A CREATE request ("create a
            // new page") must NEVER be reinterpreted as update-an-existing-
            // target: a missing parent is a DESTINATION choice (often
            // optional/draftable per the tool's own schema), not a target to
            // hunt down. Without this, a create missing a parent identifier
            // gets diverted into search-existing-pages + "give me a parent
            // ID" instead of creating directly. The caps come from the
            // generic intent classifier — no tool/vendor names involved.
            // Absent caps (direct API use) fail open to preserve behavior.
            if (intentCaps && !intentCaps.has('UPDATE') && !intentCaps.has('DELETE')) return null;
            const resolvers = this.findResolverSchemas(mcpSchemas, execName);
            if (!resolvers.length) return null;

            const callId = originalCall?.id || `resolve-${Date.now().toString(36)}`;
            let originalArgs = {};
            try {
                originalArgs = typeof originalCall?.function?.arguments === 'string'
                    ? JSON.parse(originalCall.function.arguments)
                    : { ...(originalCall?.function?.arguments || {}) };
            } catch { originalArgs = {}; }
            const resolverNames = resolvers.map((s) => s?.function?.name).filter(Boolean);
            console.log('[AIService] targetResolution.start', { tool: execName, missing: missed, resolvers: resolverNames });

            const assistantAttempt = {
                role: 'assistant',
                content: '',
                toolCalls: [{
                    id: callId,
                    function: { name: originalCall?.function?.name, arguments: originalCall?.function?.arguments || {} }
                }]
            };
            const hintToolMessage = {
                role: 'tool',
                name: execName,
                toolCallId: callId,
                content: JSON.stringify({
                    success: false,
                    error: `Missing required arguments: ${missed.join(', ')}.`,
                    hint: `Resolve the target with one of [${resolverNames.join(', ')}] first (search by title or fetch by reference), then call ${execName} again with the resolved identifier. Do not ask the user for IDs you can look up yourself.`
                })
            };
            const baseUserContext = {
                userId, isGuest, calendarIntent, requestKey, taskMode: 'text'
            };
            // Round 1: resolve. Resolvers + the original schema (the model
            // may already know the ID and retry immediately). Inventory is
            // refreshed to this round's exact tool set (visibility invariant).
            const round1Tools = [...resolvers, argSchema].slice(0, 6);
            const round1Prompt = this.refreshInventoryPrompt(
                systemPrompt, this.mcpInventoryBlockForTools(round1Tools, {})
            );
            const round1 = await this.llmRouter.generate({
                messages: [...messages, assistantAttempt, hintToolMessage],
                systemPrompt: round1Prompt,
                tools: round1Tools,
                stream: false,
                maxTokens,
                temperature: 0.3,
                userContext: baseUserContext,
                attachments: [],
                signal
            });
            const round1Calls = Array.isArray(round1?.toolCalls) ? round1.toolCalls : [];
            // Immediate retry with complete args — no second round needed.
            const directRetry = round1Calls.find((c) => (c?.function?.name || c?.name) === execName);
            if (directRetry) {
                let parsed = {};
                try {
                    parsed = typeof directRetry.function.arguments === 'string'
                        ? JSON.parse(directRetry.function.arguments) : { ...(directRetry.function.arguments || {}) };
                } catch { parsed = {}; }
                const check = validateArgs(argSchema, { ...originalArgs, ...parsed });
                if (check.ok) {
                    console.log('[AIService] targetResolution.direct-retry', { tool: execName });
                    await this.clearPendingToolCall(conversationId, userId);
                    return {
                        toolCalls: [{
                            id: directRetry?.id || `resolved-${Date.now().toString(36)}`,
                            function: { name: execName, arguments: check.coerced }
                        }],
                        text: round1?.text || ''
                    };
                }
            }
            // Execute resolver calls only (never the original with bad args).
            const resolverCalls = round1Calls.filter((c) => {
                const n = c?.function?.name || c?.name;
                return n && n !== execName && resolverNames.includes(n);
            }).slice(0, 3);
            if (!resolverCalls.length) {
                console.log('[AIService] targetResolution.no-resolver-call', { tool: execName });
                return null;
            }
            const resolverResults = [];
            for (const tc of resolverCalls) {
                const fname = tc?.function?.name || tc?.name;
                let args = {};
                try {
                    args = typeof tc.function.arguments === 'string'
                        ? JSON.parse(tc.function.arguments) : tc.function.arguments || {};
                } catch { args = {}; }
                console.log('[AIService] targetResolution.resolve', { tool: fname });
                let result = null;
                try {
                    result = await TaskExecutor.executeTool(fname, args, userId, socket, { signal, conversationId, workspaceId });
                } catch (execErr) {
                    result = { success: false, error: execErr?.message || 'Tool execution failed.' };
                }
                if (result?.clientAction && socket) socket.emit('ai:client:action', result.clientAction);
                resolverResults.push({ toolCallId: tc.id, name: fname, content: result });
            }
            // Round 2: retry the original with resolver evidence in context.
            const round1Assistant = {
                role: 'assistant',
                content: round1?.text || '',
                toolCalls: resolverCalls.map((tc) => ({
                    id: tc.id,
                    function: { name: tc?.function?.name || tc?.name, arguments: tc?.function?.arguments || {} }
                }))
            };
            const round2Prompt = this.refreshInventoryPrompt(
                systemPrompt, this.mcpInventoryBlockForTools([argSchema], {})
            );
            const round2 = await this.llmRouter.generate({
                messages: [
                    ...messages, assistantAttempt, hintToolMessage, round1Assistant,
                    ...resolverResults.map((r) => ({
                        role: 'tool', name: r.name, toolCallId: r.toolCallId,
                        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? {})
                    }))
                ],
                systemPrompt: round2Prompt,
                tools: [argSchema],
                stream: false,
                maxTokens,
                temperature: 0.3,
                userContext: baseUserContext,
                attachments: [],
                signal
            });
            const round2Calls = Array.isArray(round2?.toolCalls) ? round2.toolCalls : [];
            const retry = round2Calls.find((c) => (c?.function?.name || c?.name) === execName);
            if (!retry) {
                console.log('[AIService] targetResolution.no-retry', { tool: execName });
                return null;
            }
            let parsed = {};
            try {
                parsed = typeof retry.function.arguments === 'string'
                    ? JSON.parse(retry.function.arguments) : { ...(retry.function.arguments || {}) };
            } catch { parsed = {}; }
            const check = validateArgs(argSchema, { ...originalArgs, ...parsed });
            if (!check.ok) {
                console.log('[AIService] targetResolution.retry-invalid', { tool: execName, missing: check.errors.map((e) => e.name) });
                return null;
            }
            console.log('[AIService] targetResolution.resolved', { tool: execName });
            await this.clearPendingToolCall(conversationId, userId);
            return {
                toolCalls: [{
                    id: retry?.id || `resolved-${Date.now().toString(36)}`,
                    function: { name: execName, arguments: check.coerced }
                }],
                text: round2?.text || ''
            };
        } catch (err) {
            console.log('[AIService] targetResolution.failed', { tool: execName, reason: err?.message || 'error' });
            return null;
        }
    }

    // ---- Recent conversation context + working/agent state ----
    // CORE continuity fix: every processQuery turn is otherwise stateless
    // (provider messages carried only the current user turn), so "its",
    // "that", "the second one" had nothing to resolve against. These helpers
    // are generic — no pronoun/one-off handling anywhere: the model simply
    // receives a bounded recent window + compact structured refs and resolves
    // references naturally. All failure-silent: absence degrades to the old
    // single-turn shape, never an error.
    //
    // Display history (paginated UI reads) and provider context stay
    // separate: this window is capped (MAX_RECENT_TURNS / per-turn chars) no
    // matter how many messages the conversation visually holds.
    async loadRecentTurns(conversationId, userId, limit = 10) {
        if (isGuestActorId(userId) || !conversationId) return [];
        try {
            // Newest-first fetch, then chronological. Excludes nothing: the
            // just-saved current user message is appended by the budget
            // pipeline itself, so fetching limit+1 and dropping a trailing
            // duplicate keeps exactly `limit` PRIOR turns.
            const docs = await Message.find({ conversationId })
                .sort({ createdAt: -1, _id: -1 })
                .limit(Math.max(1, limit + 1))
                .select('role content createdAt')
                .lean();
            const chronological = (Array.isArray(docs) ? docs : []).reverse();
            const turns = [];
            for (const d of chronological) {
                const content = String(d?.content || '').trim();
                if (!content) continue;
                turns.push({
                    role: d?.role === 'ai' ? 'assistant' : 'user',
                    // Per-turn bound: a giant single turn can never evict the
                    // rest of the window; the budget pipeline enforces the
                    // final cap. 1500 chars mirrors PER_TURN_CHAR_CAP.
                    content: content.length > 1500 ? content.slice(0, 1500) : content
                });
            }
            // Drop the just-saved current user message if present at the end.
            if (turns.length > limit) return turns.slice(-limit);
            if (turns.length && turns[turns.length - 1].role === 'user') {
                return turns.slice(0, -1).slice(-limit);
            }
            return turns.slice(-limit);
        } catch {
            return [];
        }
    }

    async loadWorkingState(conversationId, userId) {
        if (isGuestActorId(userId) || !conversationId) return null;
        try {
            const doc = await Conversation.findById(conversationId)
                .select('workingState conversationSummary pendingToolCall')
                .lean();
            return doc || null;
        } catch {
            return null;
        }
    }

    async saveWorkingState(conversationId, userId, workingState, summary = undefined) {
        if (isGuestActorId(userId) || !conversationId || !workingState) return;
        try {
            const update = { workingState };
            if (typeof summary === 'string' && summary) update.conversationSummary = summary.slice(0, 1200);
            await Conversation.findByIdAndUpdate(conversationId, update);
        } catch {
            // Persistence must never break the request path.
        }
    }

    // Derive compact working-state refs from recent tool activity stored on
    // Message.toolCalls ({ toolName, input, output }). Bounded references
    // only — titles/ids/queries, max 3 search results — never full outputs.
    // Merged UNDER any persisted workingState (fresh activity wins per slot).
    buildWorkingStateFromMessages(recentMessageDocs, persisted = null, pendingState = null) {
        const state = {};
        if (persisted && typeof persisted === 'object') {
            for (const k of ['activeMedia', 'activeSearch', 'activeResource', 'activeTask']) {
                if (persisted[k] != null) state[k] = persisted[k];
            }
        }
        const compactStr = (v, cap = 140) => {
            let s = '';
            try { s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); }
            catch { s = ''; }
            s = String(s || '').replace(/\s+/g, ' ').trim();
            return s.length > cap ? s.slice(0, cap) : s;
        };
        try {
            const docs = Array.isArray(recentMessageDocs) ? recentMessageDocs : [];
            for (const doc of docs) {
                const calls = Array.isArray(doc?.toolCalls) ? doc.toolCalls : [];
                for (const call of calls) {
                    const name = String(call?.toolName || '');
                    if (!name) continue;
                    const input = call?.input && typeof call.input === 'object' ? call.input : {};
                    const output = call?.output;
                    if (['playMedia', 'stopMedia'].includes(name)) {
                        const title = compactStr(input.searchQuery || input.query || output?.title || output?.message);
                        if (title) state.activeMedia = { tool: name, title: title.slice(0, 140) };
                    } else if (['webSearch', 'scrapeWebsite', 'getTopNews'].includes(name)) {
                        const query = compactStr(input.query || input.q || input.url || input.topic);
                        let refs = [];
                        try {
                            const results = output?.results || output?.articles || output?.items;
                            if (Array.isArray(results)) {
                                refs = results.slice(0, 3).map((r) => compactStr(r?.title || r?.url || r, 100)).filter(Boolean);
                            }
                        } catch { refs = []; }
                        if (query || refs.length) state.activeSearch = { tool: name, query: query.slice(0, 140), results: refs };
                    } else if (['openWebsite', 'scheduleMeeting', 'checkCalendar', 'sendEmail', 'sendWhatsAppMessage', 'executeCode', 'copyToClipboard'].includes(name)) {
                        const ref = compactStr(input.url || input.summary || input.to || input.code || input.text || output?.message || output?.title);
                        if (ref) state.activeResource = { tool: name, ref: ref.slice(0, 140) };
                    } else if (name.startsWith('mcp_')) {
                        // Generic MCP activity: wire name + compact input refs so
                        // "update that page" / "open the second one" resolve.
                        const ref = compactStr(input.page_id || input.pageId || input.id || input.title || input.query || input.url || Object.values(input)[0]);
                        if (ref || output) {
                            state.activeResource = {
                                tool: name.slice(0, 80),
                                ref: ref.slice(0, 140)
                            };
                        }
                    }
                }
            }
        } catch {
            // Derivation must never throw; persisted state still applies.
        }
        if (pendingState && typeof pendingState.toolName === 'string') {
            state.pendingTool = { tool: pendingState.toolName, missing: pendingState.missing || [] };
        }
        return Object.keys(state).length ? state : null;
    }

    // Context-aware tool selection query: the CURRENT text decides, but the
    // last two user turns ride along as background so follow-ups without an
    // explicit capability verb ("make it slower", "summarize the second
    // result", "do it again") still surface the prior turn's tools. Bounded
    // (2 x 300 chars) and generic — no pronoun/entity special-casing.
    buildToolSelectionQuery(currentText, recentTurns) {
        const current = String(currentText || '');
        try {
            const priorUsers = (Array.isArray(recentTurns) ? recentTurns : [])
                .filter((t) => t && t.role === 'user' && String(t.content || '').trim())
                .slice(-2)
                .map((t) => String(t.content).slice(0, 300));
            if (!priorUsers.length) return current;
            return `${priorUsers.join('\n')}\n${current}`.slice(0, 900);
        } catch {
            return current;
        }
    }

    // Refresh persisted working state after tool executions (inline + planner
    // paths share this): extracts compact refs from executed tool results and
    // merges them over the stored state. Bounded inputs, failure-silent.
    async refreshWorkingStateFromResults(conversationId, userId, executedResults, pendingState = null) {
        if (isGuestActorId(userId) || !conversationId || !Array.isArray(executedResults) || !executedResults.length) return null;
        try {
            const convo = await this.loadWorkingState(conversationId, userId);
            const base = (convo && convo.workingState && typeof convo.workingState === 'object') ? { ...convo.workingState } : {};
            const compactStr = (v, cap = 140) => {
                let s = '';
                try { s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); }
                catch { s = ''; }
                s = String(s || '').replace(/\s+/g, ' ').trim();
                return s.length > cap ? s.slice(0, cap) : s;
            };
            for (const entry of executedResults) {
                const name = String(entry?.name || '');
                let content = entry?.content;
                if (typeof content === 'string') {
                    try { content = JSON.parse(content); } catch { content = { message: String(entry.content).slice(0, 300) }; }
                }
                const payload = content && typeof content === 'object' ? content : {};
                if (!name) continue;
                if (['playMedia', 'stopMedia'].includes(name)) {
                    const title = compactStr(payload?.clientAction?.title || payload?.message || payload?.title);
                    if (title) base.activeMedia = { tool: name, title };
                } else if (['webSearch', 'scrapeWebsite', 'getTopNews'].includes(name)) {
                    let refs = [];
                    try {
                        const results = payload?.results || payload?.articles || payload?.items;
                        if (Array.isArray(results)) refs = results.slice(0, 3).map((r) => compactStr(r?.title || r?.url || r, 100)).filter(Boolean);
                    } catch { refs = []; }
                    base.activeSearch = { tool: name, results: refs };
                } else if (name.startsWith('mcp_')) {
                    const ref = compactStr(payload?.title || payload?.id || payload?.message);
                    if (ref) base.activeResource = { tool: name.slice(0, 80), ref };
                } else {
                    const ref = compactStr(payload?.message || payload?.title || payload?.summary);
                    if (ref) base.activeTask = { tool: name, ref };
                }
            }
            if (pendingState && typeof pendingState.toolName === 'string') {
                base.pendingTool = { tool: pendingState.toolName };
            } else if (base.pendingTool && executedResults.length) {
                delete base.pendingTool;
            }
            if (!Object.keys(base).length) return null;
            await this.saveWorkingState(conversationId, userId, base);
            return base;
        } catch {
            return null;
        }
    }

    async executeSchedulingPipeline(userId, rawText, socket, signal = null) {
        const userCommand = String(rawText || '').trim();
        console.log(`[Planner] Incoming user command: ${userCommand}`);

        const startDate = parseStartDate(userCommand);
        const start = parseTimeOnDate(userCommand, startDate);
        const durationMinutes = parseDurationMinutes(userCommand);
        const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
        const summary = parseMeetingTitle(userCommand);
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

        // Helper: Format local time as ISO string WITHOUT Z suffix
        // This allows Google Calendar API to interpret it in the specified timezone
        const formatLocalTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
        };

        const checkArgs = {
            timeMin: new Date(start.getTime() - 15 * 60 * 1000).toISOString(),
            timeMax: new Date(end.getTime() + 15 * 60 * 1000).toISOString(),
            maxResults: 20
        };
        const scheduleArgs = {
            summary,
            startDateTime: formatLocalTime(start),
            endDateTime: formatLocalTime(end),
            timeZone
        };

        const plannedTools = ['checkCalendar', 'scheduleMeeting'];
        console.log(`[Planner] Chosen tools (in order): ${plannedTools.join(' -> ')}`);

        console.log('[Planner] Before tool execution:', { tool: 'checkCalendar', args: checkArgs });
        const checkResult = await TaskExecutor.executeTool('checkCalendar', checkArgs, userId, socket, { signal });
        console.log('[Planner] After tool execution payload:', { tool: 'checkCalendar', payload: checkResult });

        let hasConflict = false;
        if (checkResult?.success && Array.isArray(checkResult.events)) {
            const overlaps = checkResult.events.filter((event) => {
                const eventStart = new Date(event.start);
                const eventEnd = new Date(event.end);
                if (Number.isNaN(eventStart.getTime()) || Number.isNaN(eventEnd.getTime())) return false;
                return eventStart < end && eventEnd > start;
            });
            hasConflict = overlaps.length > 0;
        }

        if (hasConflict) {
            return `I found a conflict around ${start.toLocaleString()}. I did not create the meeting. Please share another time.`;
        }

        let scheduleResult;
        try {
            console.log('[Planner] Before tool execution:', { tool: 'scheduleMeeting', args: scheduleArgs });
            scheduleResult = await TaskExecutor.executeTool('scheduleMeeting', scheduleArgs, userId, socket, { signal });
            console.log('[Planner] After tool execution payload:', { tool: 'scheduleMeeting', payload: scheduleResult });
        } catch (error) {
            console.error('[Planner] scheduleMeeting pipeline error:', error?.stack || error);
            return 'Meeting request processed but confirmation pending.';
        }

        if (!scheduleResult?.success) {
            return scheduleResult?.error || 'Unable to schedule the meeting right now.';
        }

        // Security: Don't expose event IDs in chat responses
        return `Meeting "${scheduleResult.title}" successfully scheduled for ${scheduleResult.start} to ${scheduleResult.end}.`;
    }

    async processQuery(userId, text, socket = null, imageBase64 = null, document = null, conversationId = null, workspaceId = null) {
        const creditCharge = await consumeCredits(userId, 1, 'ai request');
        if (!creditCharge.success) {
            if (socket) {
                socket.emit('bot_error', creditCharge.error);
                socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
            }
            return creditCharge.error;
        }

        if (socket) {
            socket.emit('ai:credits:update', {
                creditsRemaining: creditCharge.creditsRemaining,
                reason: 'ai request'
            });
        }

        // Resolve active workspace early so conversation/messages can be attributed
        let resolvedWorkspace = null;
        try {
            resolvedWorkspace = await this.workspaceRuntime.resolveWorkspace({ userId, workspaceId });
            console.info('[AIService] workspace resolved for incoming request:', resolvedWorkspace?._id || null, 'namespace:', resolvedWorkspace?.vectorNamespace || null);
        } catch (err) {
            console.warn('[AIService] workspace resolution failed (pre-conversation):', err?.message || err);
        }
        const workspaceContext = this.workspaceRuntime.injectWorkspaceContext(resolvedWorkspace);

        // Handle conversation lifecycle
        if (!isGuestActorId(userId)) {
            try {
                if (!conversationId) {
                    // Create a new conversation
                    const newConversation = new Conversation({
                        userId,
                        workspaceId: workspaceContext.workspaceId || null,
                        title: 'New Conversation'
                    });
                    await newConversation.save();
                    conversationId = newConversation._id;
                    
                    // Notify frontend of new conversation ID
                    if (socket) {
                        socket.emit('ai:conversation:created', {
                            conversationId: conversationId.toString(),
                            workspaceId: workspaceContext.workspaceId ? String(workspaceContext.workspaceId) : null
                        });
                    }
                }

                // Save user message
                await Message.create({
                    conversationId,
                    workspaceId: workspaceContext.workspaceId || null,
                    role: 'user',
                    content: text || (document ? `Attached document: ${document.name}` : ''),
                    attachments: imageBase64 ? [{ type: 'image' }] : (document ? [{ type: 'document', name: document.name }] : []),
                    metadata: {
                        streaming: false
                    }
                });
            } catch (err) {
                console.error('[AIService] Error handling conversation:', err);
                // Don't block query on conversation error
            }
        }
        const { key, controller } = this.beginRequest(socket, userId);
        // Declared outside try: the catch handler below reads these for abort
        // persistence and diagnostics, and try-block-scoped let/const are in
        // TDZ there — referencing them threw a secondary ReferenceError that
        // swallowed the real error and left the client generating forever.
        const assistantResponseMeta = {
            provider: null,
            model: null,
            tokens: { input: 0, output: 0 }
        };
        // Delivery timing diagnostics (elapsed ms only — never message text,
        // keys, or tokens). Anchored at provider generation start.
        const deliveryTiming = {
            providerStartAt: null,
            providerDoneAt: null,
            firstChunkAt: null,
            deliveryDoneAt: null,
            persistenceDoneAt: null
        };
        const deliveryHooks = {
            onFirstChunk: () => {
                if (deliveryTiming.firstChunkAt == null) {
                    deliveryTiming.firstChunkAt = Date.now();
                    console.log('[AIService] delivery.firstChunk', {
                        elapsedMs: deliveryTiming.firstChunkAt - deliveryTiming.providerStartAt,
                        provider: assistantResponseMeta.provider || null
                    });
                }
            },
            onLastChunk: () => {
                if (deliveryTiming.deliveryDoneAt == null) {
                    deliveryTiming.deliveryDoneAt = Date.now();
                }
            }
        };
        // Server TTS buffer handle. Declared here (not inside try) so the
        // abort path below can stop audio even when generation is cancelled.
        // Null unless server TTS is active for this request.
        let ttsBuffer = null;
        let assistantDraftMessageId = null;
        let assistantDraftContent = '';
        let finalOutputText = '';
        try {
            console.log(`[Planner] Incoming user command: ${String(text || '').trim()}`);
            const now = new Date();
            const currentDateString = now.toLocaleString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', 
                day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            const calendarIntent = classifyCalendarIntent(text);
            const isGuest = isGuestActorId(userId);
            const user = isGuest ? null : await User.findById(userId).select('preferences.memoryLearningEnabled preferences.voice preferences.accentColor').lean();
            const memoryLearningEnabled = user?.preferences?.memoryLearningEnabled !== false;

            const persistAssistantDraft = async (nextContent, { interrupted = false, state = 'streaming' } = {}) => {
                if (isGuestActorId(userId) || !conversationId) return;

                const normalizedContent = String(nextContent || '');
                assistantDraftContent = normalizedContent;

                console.log('[AIService] assistant draft persist requested', {
                    conversationId: String(conversationId),
                    hasDraftMessage: Boolean(assistantDraftMessageId),
                    interrupted,
                    state,
                    contentLength: normalizedContent.length
                });

                if (!assistantDraftMessageId) {
                    const draftMessage = await Message.create({
                        conversationId,
                        workspaceId: workspaceContext.workspaceId || null,
                        role: 'ai',
                        content: normalizedContent,
                        provider: assistantResponseMeta.provider,
                        model: assistantResponseMeta.model,
                        metadata: {
                            tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                            streaming: true,
                            interrupted,
                            partial: true,
                            state
                        }
                    });
                    assistantDraftMessageId = draftMessage._id;

                    console.log('[AIService] assistant draft created', {
                        conversationId: String(conversationId),
                        messageId: String(draftMessage._id),
                        interrupted,
                        state,
                        contentLength: normalizedContent.length
                    });

                    await Conversation.findByIdAndUpdate(conversationId, {
                        lastMessage: {
                            content: normalizedContent.substring(0, 100),
                            role: 'ai',
                            timestamp: new Date()
                        }
                    });
                    return;
                }

                await Message.findByIdAndUpdate(assistantDraftMessageId, {
                    content: normalizedContent,
                    provider: assistantResponseMeta.provider,
                    model: assistantResponseMeta.model,
                    metadata: {
                        tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                        streaming: !interrupted,
                        interrupted,
                        partial: true,
                        state
                    }
                });

                console.log('[AIService] assistant draft updated', {
                    conversationId: String(conversationId),
                    messageId: String(assistantDraftMessageId),
                    interrupted,
                    state,
                    contentLength: normalizedContent.length
                });

                await Conversation.findByIdAndUpdate(conversationId, {
                    lastMessage: {
                        content: normalizedContent.substring(0, 100),
                        role: 'ai',
                        timestamp: new Date()
                    }
                });
            };

            if (calendarIntent.type !== 'none') {
                console.log(
                    `[Planner] Calendar intent classified as "${calendarIntent.type}" (${calendarIntent.reason || 'rule match'}).`
                );
            }

            if (calendarIntent.type === 'schedule' && !imageBase64 && !document) {
                const scheduleResponse = await Promise.race([
                    this.executeSchedulingPipeline(userId, text, socket, controller.signal),
                    new Promise((resolve) => {
                        setTimeout(() => resolve('Meeting request processed but confirmation pending.'), 5000);
                    })
                ]);

                if (socket && !socket.isInterrupted) {
                    await this.emitAssistantText(socket, scheduleResponse);
                }

                if (!isGuestActorId(userId) && memoryLearningEnabled) {
                    const newMemory = new AIMemory({
                        userId,
                        query: text || 'Schedule meeting request',
                        response: scheduleResponse,
                        source: 'conversation'
                    });
                    await newMemory.save();
                }

                return scheduleResponse;
            }

            if (socket) {
                socket.emit('ai:agent:status', {
                    status: 'searching history',
                    detail: 'Looking through conversations, memories, and facts.'
                });
            }

            // Candidate pools for the budget pipeline: fetched wider than the
            // old fixed top-N so ranking (pinned > relevance > recency) can
            // choose by value instead of recency alone. The pipeline caps
            // what is actually sent; memories are never injected verbatim.
            const memoryDocs = isGuest ? [] : await AIMemory.find({ userId, workspaceId: workspaceContext.workspaceId || null }).sort({ pinned: -1, timestamp: -1 }).limit(20).lean();

            const baseMessageContent = text || (document ? `Please analyze the attached document: ${document.name}` : 'Hello');

                        const factDocs = isGuest ? [] : await UserFact.find({ userId, workspaceId: workspaceContext.workspaceId || null }).sort({ pinned: -1, createdAt: -1 }).limit(20).lean();

                        let retrievalItems = [];
                        if (!isGuest) {
                            try {
                                const ctx = await WorkspaceContextManager.getActiveContext({ userId, conversationId, query: baseMessageContent, limit: 10, workspaceId });
                                retrievalItems = ctx?.items || [];
                                this.wsLog.retrievalExecuted(userId, workspaceId, 'WorkspaceContextManager', retrievalItems.length);
                            } catch (err) {
                                console.warn('[AIService] WorkspaceContextManager failed, falling back to buildMemoryContext', err?.message || err);
                                retrievalItems = await buildMemoryContext({ userId, query: baseMessageContent, limit: 10, workspaceId });
                                this.wsLog.retrievalExecuted(userId, workspaceId, 'buildMemoryContext', retrievalItems.length);
                            }
                        }

            // Memory/fact/RAG prose is rendered by the budget pipeline below
            // (compactMemories/compactFacts/compactRag) — the raw candidate
            // pools above are ranked and capped there, never injected raw.

            if (socket) {
                socket.emit('ai:agent:status', {
                    status: retrievalItems.length > 0 ? 'retrieving memory' : 'thinking',
                    detail: retrievalItems.length > 0 ? `${retrievalItems.length} relevant workspace items prepared.` : 'No strong memory matches found.'
                });
            }

            let documentContext = "";
            if (document) {
                try {
                    console.log(`[Agent Router] Reading attached document: ${document.name}`);
                    let parsedText = "";

                    if (document.type === 'application/pdf') {
                        const buffer = Buffer.from(document.base64, 'base64');
                        
                        // 🚀 Clean, simple, and guaranteed to work
                        const pdfData = await pdfExtract(buffer);
                        parsedText = pdfData.text;
                        
                        if (!parsedText || parsedText.trim() === '') {
                            throw new Error("EMPTY_SCANNED_PDF");
                        }
                    } else {
                        parsedText = Buffer.from(document.base64, 'base64').toString('utf-8');
                    }

                    // Initial document cap: the budget pipeline may shrink this
                    // further; the truncation notice pattern is preserved.
                    if (parsedText.length > DOC_CHARS_INITIAL) {
                        parsedText = parsedText.substring(0, DOC_CHARS_INITIAL) + "\n... [Document truncated due to length limits]";
                    }

                    documentContext = `\n\n--- ATTACHED FILE CONTEXT (${document.name}) ---\nThe user has attached a file for you to read. Here is the text extracted from it:\n\n${parsedText}\n-----------------------------------\n`;
                } catch (err) {
                    console.error("[Agent Router] Document parse error:", err.message || err);
                    
                    if (err.message === "EMPTY_SCANNED_PDF") {
                        documentContext = `\n\n[System Note: The attached PDF '${document.name}' appears to be an image-based or scanned PDF. No readable text could be extracted. Please inform the user.]`;
                    } else {
                        documentContext = `\n\n[System Note: Failed to read attached document '${document.name}' due to a backend parsing error. Please apologize to the user.]`;
                    }
                }
            }

            // ---- Budgeted request assembly (contextBudget pipeline) ----
            // Memories are compacted to short bullets (never verbatim
            // messages[] turns), facts/RAG are capped, tools are the
            // intent-matched subset (never all 22), and output is explicit.
            // Provider messages[] carry a BOUNDED recent window (prior turns
            // verbatim, most-recent-first) + the current user turn, so
            // follow-ups ("its", "that", "the second one") resolve against
            // real conversation context. Display history (pagination) and
            // provider context stay separate: the window is capped no matter
            // how many messages the UI shows.
            // MCP tools ride the same budget pipeline: their schemas are
            // keyword-scored below and then held to the SAME 6-tool cap and
            // the 7K context budget (unknown-group rank → dropped first).
            // ---- Recent conversation window + working state (core continuity) ----
            // Loaded BEFORE any MCP work so the decision gate can see
            // follow-up context, active working state, and pending tool state.
            // Bounded (10 turns x ~1500 chars) and failure-silent: [] / null
            // degrades to the old single-turn shape, never an error. Guests
            // have no conversation record, so both stay empty for them.
            let recentTurns = [];
            let persistedWorkingState = null;
            let persistedSummary = '';
            try {
                recentTurns = await this.loadRecentTurns(conversationId, userId, 10);
            } catch { recentTurns = []; }
            try {
                const convoState = await this.loadWorkingState(conversationId, userId);
                persistedWorkingState = (convoState && convoState.workingState && typeof convoState.workingState === 'object')
                    ? convoState.workingState : null;
                persistedSummary = String(convoState?.conversationSummary || '');
            } catch { persistedWorkingState = null; persistedSummary = ''; }
            // Tool-selection background: last two user turns ride along so
            // "make it slower" / "summarize the second result" / "do it
            // again" resurface the prior turn's capability. Generic — no
            // pronoun or entity special-casing.
            const toolSelectionQuery = this.buildToolSelectionQuery(baseMessageContent, recentTurns);
            // Pending tool-call state (single load, shared by the decision
            // gate, the working-state assembly, and the pending resume block).
            let pendingForGate = null;
            try { pendingForGate = await this.loadPendingToolCall(conversationId, userId); } catch { pendingForGate = null; }
            // Working state for this turn: persisted refs (previous tool
            // activity) merged with pending-tool state. Fresh tool results
            // below refresh the stored copy via refreshWorkingStateFromResults.
            let turnWorkingState = persistedWorkingState;
            try {
                if (pendingForGate || persistedWorkingState) {
                    turnWorkingState = {
                        ...(persistedWorkingState && typeof persistedWorkingState === 'object' ? persistedWorkingState : {}),
                        ...(pendingForGate && typeof pendingForGate.toolName === 'string'
                            ? { pendingTool: { tool: pendingForGate.toolName, missing: pendingForGate.missing || [] } }
                            : {})
                    };
                    if (!Object.keys(turnWorkingState).length) turnWorkingState = null;
                }
            } catch { turnWorkingState = persistedWorkingState; }

            // ---- Jev System One decision gate ----------------------------------
            // The ONLY behavioral change introduced by the decision layer:
            // when DecisionEngine confidently classifies the request as needing
            // no external capability/tool, the entire MCP machinery below
            // (inventory, discovery, candidate selection, feasibility,
            // execution) is skipped and the request proceeds straight to the
            // normal Groq path. High-confidence tool requests and
            // low-confidence (legacy) results enter the existing pipeline
            // UNCHANGED. Jev never executes a tool — deterministic ARC code
            // remains authoritative for authorization, selection, arguments,
            // policy, and execution. Jev failures degrade to legacy routing.
            let decisionGate = null;
            let skipMcpGate = false;
            try {
                decisionGate = await this.decisionEngine.decide({
                    request: baseMessageContent,
                    query: toolSelectionQuery,
                    recentContext: recentTurns,
                    workingState: turnWorkingState,
                    pendingTool: pendingForGate,
                    hasAttachment: Boolean(imageBase64 || document),
                    signal: controller.signal
                });
                skipMcpGate = decisionPolicy.shouldSkipMcp(decisionGate, {
                    policy: this.decisionEngine.policy,
                    hasAttachments: Boolean(imageBase64 || document),
                    hasPendingTool: Boolean(pendingForGate && pendingForGate.toolName),
                    workingState: turnWorkingState
                });
            } catch {
                decisionGate = null;
                skipMcpGate = false;
            }
            if (skipMcpGate) {
                console.log('[AIService] decisionGate.skipMcp', {
                    provider: decisionGate?.provider || null,
                    command: String(baseMessageContent || '').slice(0, 120)
                });
            }

            // ---- MCP schemas (policy-exposed only) -----------------------------
            // Skipped entirely when the decision gate confidently classified
            // the request as conversational: no inventory, no discovery, no
            // connection/connect work, no candidate generation. Everything
            // else still passes through this unchanged authoritative source.
            let mcpSchemas = [];
            let mcpBlocked = [];
            let mcpMetadata = null;
            let mcpFailures = [];
            if (!skipMcpGate) {
                try {
                    const mcpPick = await McpToolSource.schemasForRequest({
                        workspaceId: workspaceContext?.workspaceId || null,
                        isGuest,
                        // Automatic reconnects need the silent OAuth provider:
                        // after a restart the live connection is gone while
                        // stored credentials survive. Same behavior as /connect
                        // and /refresh; never interactive.
                        userId
                    });
                    mcpSchemas = mcpPick?.schemas || [];
                    // Server-side only: policy-removed tools, used solely for
                    // no-substitution detection below (never sent to any provider).
                    mcpBlocked = mcpPick?.blocked || [];
                    mcpMetadata = mcpPick?.metadata || null;
                    mcpFailures = mcpPick?.failures || [];
                } catch {
                    mcpSchemas = [];
                    mcpBlocked = [];
                    mcpMetadata = null;
                    mcpFailures = [];
                }
            }
            // Shared MCP executor for deterministic in-turn resolution
            // (creation context, pending candidate matching). Same
            // TaskExecutor path as normal tool calls — real charges,
            // real policy gates, bounded by each caller.
            const mcpExec = (wireName, args) => TaskExecutor.executeTool(
                wireName, args, userId, socket,
                { signal: controller.signal, conversationId, workspaceId: workspaceContext.workspaceId }
            );
            // Explicit server scope (user named the integration): every
            // SELECTION input below uses the scoped pool, so no
            // foreign-server tool can satisfy, substitute, or crowd out this
            // request. Empty scope keeps every server eligible. Execution,
            // continuation, permission, and metadata always use the full
            // exposed set (deny-wins preserved; validated names resolve).
            let mcpServerScope = [];
            let scopedMcpSchemas = mcpSchemas;
            let scopedMcpBlocked = mcpBlocked;
            try {
                mcpServerScope = detectMcpServerScope(toolSelectionQuery, mcpSchemas);
                if (mcpServerScope.length) {
                    const inScope = (s) => {
                        try {
                            const key = mcpServerKeyOf(s);
                            return mcpServerScope.some((t) => mcpScopeMatches(t, key));
                        }
                        catch { return true; }
                    };
                    const subSchemas = (mcpSchemas || []).filter(inScope);
                    if (subSchemas.length) {
                        scopedMcpSchemas = subSchemas;
                        scopedMcpBlocked = (mcpBlocked || []).filter(inScope);
                    } else {
                        mcpServerScope = [];
                    }
                }
            } catch {
                mcpServerScope = [];
                scopedMcpSchemas = mcpSchemas;
                scopedMcpBlocked = mcpBlocked;
            }
            // Tool selection is skipped entirely for confident conversational
            // requests (decision gate): no native selection, no MCP candidate
            // generation, no inventory — the request goes straight to the Groq
            // path. High-confidence tool requests and legacy fallbacks run the
            // full selection below unchanged.
            let toolPick = {
                tools: [],
                groups: [],
                matchedGroups: [],
                defaulted: true,
                totalAvailable: 0,
                mcpAvailable: 0,
                mcpMatched: 0,
                mcpSuppressed: false,
                mcpBlockedNames: [],
                mcpExplicit: [],
                mcpCapability: []
            };
            let supportingMcp = [];
            let mcpInventoryText = '';
            let mcpPolicyNote = '';
            let mcpDegradedNote = '';
            let toolIntentCaps = null;
            if (!skipMcpGate) {
                toolPick = selectToolSchemas(toolSelectionQuery, () => toolRegistry.getSchemas(), { mcpSchemas: scopedMcpSchemas, mcpBlocked: scopedMcpBlocked, serverScope: mcpServerScope });
                // Availability coverage (§6): if the request maps to a capability
                // declared by an exposed (policy-permitted) tool that selection
                // missed, force it in deterministically (once, within the cap).
                // Never fabricates, never touches denied names (absent from
                // `mcpSchemas` by construction), never bypasses required args.
                try {
                    const forced = reselectMcpCapabilities(toolSelectionQuery, scopedMcpSchemas, toolPick.tools, 6);
                    for (const schema of forced) {
                        if (toolPick.tools.length >= 6) break;
                        if (!toolPick.tools.includes(schema)) {
                            toolPick.tools.push(schema);
                            const fname = schema?.function?.name;
                            if (fname && Array.isArray(toolPick.mcpCapability) && !toolPick.mcpCapability.includes(fname)) {
                                toolPick.mcpCapability.push(fname);
                            }
                        }
                    }
                    if (forced.length) console.log('[AIService] mcpCoverage.forced', { tools: forced.map((s) => s?.function?.name).filter(Boolean) });
                } catch { /* coverage must never break selection */ }
                // Supporting creation-context resolvers (§7 multi-step create):
                // a CREATE capability pick with required CONTEXT params
                // (team_id, …) unresolvable from the user text pulls its
                // entity-matched LIST/READ tool into the request (cap-bounded)
                // so the model — or recovery — can resolve scope first and then
                // call the mutation in the same turn. Supporting only: never a
                // capability pick, never forced, deny-wins via exposed set.
                supportingMcp = [];
                try {
                    let createCaps = null;
                    try { createCaps = classifyIntentCapabilities(toolSelectionQuery); } catch { createCaps = null; }
                    if (createCaps && createCaps.has('CREATE')) {
                        const seen = new Set(toolPick.tools.map((s) => s?.function?.name).filter(Boolean));
                        for (const cname of (toolPick.mcpCapability || [])) {
                            if (toolPick.tools.length >= 6) break;
                            const schema = (mcpSchemas || []).find((s) => s?.function?.name === cname);
                            if (!schema) continue;
                            const entity = toolEntityStem(schema);
                            for (const { name: pname } of effectiveRequiredParams(schema)) {
                                if (toolPick.tools.length >= 6) break;
                                const cls = this.classifyMissingParam(pname, entity);
                                if (cls.kind !== 'context' || !cls.stem) continue;
                                let pasted;
                                try { pasted = extractIdentifierValue(toolSelectionQuery, pname); } catch { pasted = undefined; }
                                if (pasted !== undefined) continue;
                                const resolver = this.findContextResolvers(cls.stem, scopedMcpSchemas, cname)[0];
                                const rname = resolver?.function?.name;
                                if (typeof rname !== 'string' || !rname || seen.has(rname)) continue;
                                toolPick.tools.push(resolver);
                                seen.add(rname);
                                supportingMcp.push(rname);
                            }
                        }
                        if (supportingMcp.length) console.log('[AIService] mcpCoverage.supporting', { tools: supportingMcp });
                    }
                } catch { /* supporting resolvers must never break selection */ }
                // Capability-miss evidence (read-only): a mutation intent with
                // zero picks means the next failure investigation starts blind
                // ("no create tool" with no record of why). Log the
                // entity-matching exposed candidates now, while the pool is
                // still in hand.
                try {
                    let missCaps = null;
                    try { missCaps = classifyIntentCapabilities(toolSelectionQuery); } catch { missCaps = null; }
                    this.logMcpCapabilityMiss({
                        intentCaps: missCaps,
                        capabilityNames: [...(toolPick.mcpCapability || []), ...supportingMcp],
                        mcpSchemas,
                        scopedSchemas: scopedMcpSchemas,
                        serverScope: mcpServerScope,
                        queryText: toolSelectionQuery
                    });
                } catch { /* diagnostics must never break selection */ }
                // Preliminary MCP inventory (§9 step order): bounded metadata
                // from the SELECTED tools only. The FINAL inventory is rebuilt
                // after budget assembly from the exact provider-visible set, so
                // the model never sees a tool it cannot call. A denied or
                // undiscovered tool is absent here exactly as in selection.
                mcpInventoryText = '';
                try {
                    mcpInventoryText = this.mcpInventoryBlockForTools(toolPick.tools, { metadata: mcpMetadata, failures: [] });
                } catch { mcpInventoryText = ''; }
                // No-substitution truthfulness: the request targets an MCP
                // capability removed by workspace policy. No MCP tool was
                // offered, so guide the model to say so instead of substituting
                // an unrelated tool or fabricating a result. Generic: names the
                // blocked wires the user already knows (Settings shows them).
                mcpPolicyNote = '';
                if (toolPick?.mcpSuppressed && Array.isArray(toolPick?.mcpBlockedNames) && toolPick.mcpBlockedNames.length) {
                    const named = toolPick.mcpBlockedNames.slice(0, 3).join(', ');
                    mcpPolicyNote = `\n\nPOLICY NOTICE: the MCP capability requested here (${named}) is currently unavailable in this workspace due to the workspace's MCP tool policy. Do not substitute another tool for it, do not execute an unrelated tool in its place, and do not fabricate its result. Briefly tell the user it is unavailable or blocked by policy.`;
                }
                // Degraded-set truthfulness (NOT a policy denial): the request
                // maps to MCP capabilities but the current exposed set declares
                // none of them — partial discovery, reconnect race, or scope
                // change. Without this notice the model confabulates specifics
                // ("only comments") plus manual API/token/UI walkthroughs.
                // Generic: capability evidence only, no tool or vendor names.
                mcpDegradedNote = '';
                toolIntentCaps = null;
                try {
                    toolIntentCaps = classifyIntentCapabilities(toolSelectionQuery);
                } catch { toolIntentCaps = null; }
                try {
                    mcpDegradedNote = this.mcpDegradedNotice({
                        intentCaps: toolIntentCaps,
                        capabilityNames: toolPick.mcpCapability,
                        mcpSchemas, mcpBlocked, suppressed: Boolean(toolPick?.mcpSuppressed)
                    });
                } catch { mcpDegradedNote = ''; }
            }
            const outputIntent = detectOutputIntent(baseMessageContent);
            const outputBudget = outputIntent === 'extended' ? OUTPUT_BUDGET_EXTENDED : OUTPUT_BUDGET_DEFAULT;

            // ---- Pending tool-call resume (multi-turn argument collection) ----
            // Each turn is otherwise stateless: provider messages carry only
            // the current user turn, so fragmentary follow-ups ("success",
            // then "true") reselect zero tools and previously supplied values
            // live nowhere. A pending record preserves the SAME tool call and
            // merges answers deterministically — never via model recall.
            // Structured diagnostics log names/rounds only, never values.
            let syntheticResponse = null;
            {
                let pendingState = await this.loadPendingToolCall(conversationId, userId);
                const failClosed = async (reason, extra = {}) => {
                    console.log('[AIService] pendingTool.abandoned', { reason, ...extra });
                    await this.clearPendingToolCall(conversationId, userId);
                    pendingState = null;
                };
                if (pendingState) {
                    const pTool = pendingState.toolName;
                    if (!this.isPendingPermitted(pTool, mcpSchemas)) {
                        console.error('[AIService] pendingTool.denied', { tool: pTool });
                        await failClosed('denied', { tool: pTool });
                    } else if (isCancelText(baseMessageContent)) {
                        await failClosed('cancelled', { tool: pTool });
                    } else if (Array.isArray(toolPick.mcpExplicit) && toolPick.mcpExplicit.length > 0
                        && !toolPick.mcpExplicit.includes(pTool)) {
                        // User pivoted to a different explicit tool — replace.
                        console.log('[AIService] pendingTool.replaced', { from: pTool, to: toolPick.mcpExplicit[0] });
                        await failClosed('replaced', { from: pTool, to: toolPick.mcpExplicit[0] });
                    } else {
                        const schema = this.resolvePendingSchema(pTool, toolPick.tools, mcpSchemas);
                        if (!schema) {
                            await failClosed('schema-unavailable', { tool: pTool });
                        } else {
                            // Pending candidate matching: the user is answering
                            // THIS tool's clarification. A context/entity id
                            // answered by NAME ("Engineering") or resolved
                            // automatically (single candidate) fills the slot;
                            // anything else falls through to the normal merge.
                            // Bounded live reads, exposed set only.
                            try {
                                const fills = await this.matchPendingCandidateIds(
                                    baseMessageContent, pendingState, schema, scopedMcpSchemas, mcpExec
                                );
                                if (fills && Object.keys(fills).length) {
                                    pendingState = {
                                        ...pendingState,
                                        args: { ...(pendingState.args || {}), ...fills }
                                    };
                                }
                            } catch { /* candidate matching must never break pending */ }
                            const advanced = advancePending(pendingState, baseMessageContent, schema);
                            if (advanced.action === 'execute') {
                                console.log('[AIService] pendingTool.execute', { tool: pTool, missing: [] });
                                await this.clearPendingToolCall(conversationId, userId);
                                pendingState = null;
                                // Issue the SAME tool call through the normal
                                // execution/continuation machinery below.
                                syntheticResponse = {
                                    text: '',
                                    toolCalls: [{
                                        id: `pending-${Date.now().toString(36)}`,
                                        function: { name: pTool, arguments: advanced.args }
                                    }],
                                    provider: null,
                                    model: null,
                                    tokens: { input: 0, output: 0 }
                                };
                            } else if (advanced.action === 'ask') {
                                console.log('[AIService] pendingTool.ask', { tool: pTool, missing: advanced.missing });
                                await this.savePendingToolCall(conversationId, userId, advanced.pending);
                                if (socket && !socket.isInterrupted) {
                                    await this.emitAssistantText(socket, advanced.question);
                                }
                                return advanced.question;
                            } else {
                                await failClosed(advanced.reason || 'abandoned', { tool: pTool });
                            }
                        }
                    }
                }
                // Silent pending creation: a single explicitly requested tool
                // whose required args are missing from the user text. Records
                // state so the model's prose clarification can be answered
                // incrementally; if the text already supplies everything, the
                // call is issued deterministically right away.
                if (!pendingState && !syntheticResponse
                    && Array.isArray(toolPick.mcpExplicit) && toolPick.mcpExplicit.length === 1) {
                    const target = toolPick.mcpExplicit[0];
                    const schema = this.resolvePendingSchema(target, toolPick.tools, mcpSchemas);
                    const explicitUpdateMode = this.upsertUpdateMode(schema, { intentCaps: toolIntentCaps, text: baseMessageContent });
                    const explicitParams = effectiveRequiredParams(schema, { updateMode: explicitUpdateMode });
                    if (schema && explicitParams.length > 0 && this.isPendingPermitted(target, mcpSchemas)) {
                        const params = explicitParams;
                        const extracted = extractArgValues(baseMessageContent, params);
                        const explicitCheck = (() => {
                            try {
                                const v = validateArgs(schema, extracted);
                                const extra = missingEffective(schema, (v && v.coerced) || extracted, { updateMode: explicitUpdateMode });
                                if (!extra.length) return v;
                                const seen = new Set((v.errors || []).map((e) => e.name));
                                return { ok: false, errors: [...(v.errors || []), ...extra.filter((n) => !seen.has(n)).map((name) => ({ name, reason: 'required' }))], coerced: v.coerced };
                            } catch { return validateArgs(schema, extracted); }
                        })();
                        const check = explicitCheck;
                        if (!check.ok) {
                            const created = createPending(target, extracted, schema, Date.now(), { updateMode: explicitUpdateMode });
                            console.log('[AIService] pendingTool.created', { tool: target, missing: created.missing });
                            await this.savePendingToolCall(conversationId, userId, created);
                        } else {
                            console.log('[AIService] pendingTool.execute-immediate', { tool: target, missing: [] });
                            syntheticResponse = {
                                text: '',
                                toolCalls: [{
                                    id: `pending-${Date.now().toString(36)}`,
                                    function: { name: target, arguments: check.coerced }
                                }],
                                provider: null,
                                model: null,
                                tokens: { input: 0, output: 0 }
                            };
                        }
                    }
                }
            }

            const systemTemplate = `You are ARC-AI, an advanced, highly intelligent autonomous agent.
                    The current system date and time is: ${currentDateString}.
                    
                    CORE DIRECTIVES:
                    1. BE PROACTIVE: Use tools when necessary.
                    2. LONG-TERM MEMORY: Use 'storeUserFact' tool to remember personal facts.
                    3. UI CONTROL: Use 'openWebsite' or 'changeTheme' to control the user's system.
                    4. VISION & FILES: Analyze provided images or document text thoroughly and accurately.
                    5. COMPUTATION: Use 'executeCode' for exact math, logic, iteration, parsing, or verification instead of guessing.
                    6. CALENDAR: Use 'checkCalendar' to inspect availability and 'scheduleMeeting' to create or update meetings when the user asks to manage Google Calendar.
                    7. WHATSAPP: Use 'sendWhatsAppMessage' only when the user explicitly asks to send, message, text, forward, or deliver content on WhatsApp. Do not trigger the WhatsApp tool for vague references, questions, contact checks, or phrases like 'can you see', 'is Mummy there', or similar unless the user clearly wants a message sent. Ask a follow-up if the recipient is ambiguous or the request is not an explicit send action.

                    RESPONSE FORMATTING:
                    Format answers with GitHub-flavored markdown so they render cleanly: short paragraphs, \`##\` headings for sections of longer answers, bullet lists for collections, numbered lists for procedures, tables for comparisons, and fenced code blocks with a language tag for code. Keep short answers concise without unnecessary headings. Never emit raw markdown partially inside a sentence; keep constructs (fences, tables, lists) complete and well-formed.

                    RESPONSE STYLE CONTRACT:
                    Answer the user's actual question directly first, then support it. Be concise by default and expand only when the question needs depth. Match structure to intent: short factual question -> short answer; explanation -> concise prose; comparison -> table; procedure or tutorial -> numbered steps; debugging -> cause, fix, code, brief verification; code request -> code-first answer. Never repeat the same information in multiple forms, never restate the introduction as a conclusion, and skip generic offers or next steps unless genuinely useful.

                    MEMORY DIRECTIVE:
                    Use the ranked retrieval context below only when it is relevant. Prefer the most recent and semantically matching items. Ignore duplicates.

                    CONVERSATION CONTINUITY:
                    The recent conversation turns below are the live dialogue — resolve follow-up references ("it", "its", "that", "the previous one", "the second result", "do it again", "same song") against them and the WORKING STATE block. Never ask the user to repeat information already present in the recent turns or working state.

                    CONNECTED INTEGRATIONS (GENERIC RULE):
                    The MCP INTEGRATIONS block below lists already-authorized external integrations and the exact tools they expose for this request. When a listed tool can fulfill the user's request: call that tool. Do not describe a manual API workflow, do not ask the user for a personal API token or key, do not tell the user to open the vendor's UI/dashboard to do the work themselves, and do not claim the capability is unavailable. An authorized integration is a first-class tool source. Only when NO listed tool declares the needed capability — or a POLICY NOTICE marks it blocked — may you say so truthfully and briefly.

                    __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__

                    IDENTITY DIRECTIVE:
                    If a user asks "who created you", "who made you", or similar identity/creator questions, reply exactly with:

                    "I am ARC-AI, an autonomous multimodal AI platform created by Aashutosh Bairagi — an AI systems engineer focused on realtime architectures, autonomous agents, and next-generation intelligent software systems."
                    ${mcpPolicyNote}${mcpDegradedNote}`;

            // Working state for this turn: recomputed AFTER the pending
            // tool-call machinery above so a pending record it resolved or
            // cleared is reflected in the prompt. The decision gate above ran
            // on the same merged shape (single pre-gate load).
            turnWorkingState = persistedWorkingState;
            try {
                const pendingForState = await this.loadPendingToolCall(conversationId, userId);
                if (pendingForState || persistedWorkingState) {
                    turnWorkingState = {
                        ...(persistedWorkingState && typeof persistedWorkingState === 'object' ? persistedWorkingState : {}),
                        ...(pendingForState && typeof pendingForState.toolName === 'string'
                            ? { pendingTool: { tool: pendingForState.toolName, missing: pendingForState.missing || [] } }
                            : {})
                    };
                    if (!Object.keys(turnWorkingState).length) turnWorkingState = null;
                }
            } catch { turnWorkingState = persistedWorkingState; }
            // Active native tool continuity: the working state's live tool
            // survives budget trimming so "make it slower" keeps playMedia
            // even when the follow-up text alone selects nothing.
            const activeStateTool = turnWorkingState?.activeMedia?.tool
                || turnWorkingState?.activeSearch?.tool
                || turnWorkingState?.activeResource?.tool
                || null;

            const budgeted = assembleBudgetedRequest({
                systemTemplate,
                baseUserText: baseMessageContent,
                docText: documentContext,
                memoryDocs,
                factDocs,
                ragItems: retrievalItems,
                selectedTools: toolPick.tools,
                outputBudget,
                query: baseMessageContent,
                recentTurns,
                workingState: turnWorkingState,
                conversationSummary: persistedSummary,
                mcpInventoryText,
                // Explicitly requested and capability-driven MCP tools must
                // survive context budgeting: dropping a tool the model is
                // about to call makes the provider reject the request ("not
                // in request.tools").
                protectedToolNames: [
                    ...(toolPick.mcpExplicit || []),
                    ...(toolPick.mcpCapability || []),
                    ...(activeStateTool ? [activeStateTool] : [])
                ]
            });

            if (!budgeted.ok) {
                // Even the minimal profile overflows (gigantic user input):
                // refuse WITHOUT calling the provider — same terminal
                // contract as a provider error, truthful message.
                console.error('[AIService] contextBudget refusal', {
                    ...budgeted.report,
                    toolGroups: toolPick.groups,
                    outputIntent
                });
                if (socket) socket.emit('bot_error', CONTEXT_BUDGET_USER_MESSAGE);
                if (socket) socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
                return "Error";
            }

            const messages = budgeted.messages;
            const maxTokens = budgeted.maxTokens;
            // FINAL inventory (§1/§9): rebuilt from the exact budgeted
            // provider-visible tool set. Preliminary (pre-budget) text only
            // sized the budget; this replacement only ever shrinks it, so
            // the token estimate stays conservative. request.tools and the
            // advertised inventory are now identical by construction.
            let tools = budgeted.tools;
            let systemPrompt = budgeted.systemPrompt;
            let mcpProtectedNames = [
                ...(toolPick.mcpExplicit || []),
                ...(toolPick.mcpCapability || []),
                ...(activeStateTool ? [activeStateTool] : [])
            ];
            try {
                const finalBlock = this.mcpInventoryBlockForTools(tools, { metadata: mcpMetadata, failures: mcpFailures });
                systemPrompt = this.refreshInventoryPrompt(systemPrompt, finalBlock);
            } catch { /* inventory refresh must never break the path */ }
            // Unified MCP plan contract + fail-closed assertions (§6/§9/§12).
            // ONE authoritative source (policy-exposed schemas) feeds
            // selection, inventory, planner, recovery, and provider tools;
            // this bundle logs exactly what the turn will execute with.
            // Names/counts/flags only — never secrets, values, or content.
            let mcpPlan = null;
            try {
                const requiredNames = [
                    ...(Array.isArray(toolPick.mcpCapability) ? toolPick.mcpCapability : []),
                    ...(Array.isArray(supportingMcp) ? supportingMcp : [])
                ].filter((n, i, a) => typeof n === 'string' && a.indexOf(n) === i)
                    .filter((n) => (Array.isArray(tools) ? tools : []).some((s) => s?.function?.name === n));
                mcpPlan = this.buildMcpPlanSummary({
                    intentCaps: toolIntentCaps,
                    requiredNames,
                    selectedTools: tools,
                    suppressed: Boolean(toolPick?.mcpSuppressed),
                    exposedCount: Array.isArray(mcpSchemas) ? mcpSchemas.length : 0,
                    blockedCount: Array.isArray(mcpBlocked) ? mcpBlocked.length : 0,
                    failureCount: Array.isArray(mcpFailures) ? mcpFailures.length : 0,
                    pendingTool: null
                });
                const serverIds = [];
                try {
                    const meta = mcpMetadata instanceof Map ? mcpMetadata : null;
                    if (meta) {
                        for (const v of meta.values()) {
                            const sid = v && (v.serverId || v.slug) ? String(v.serverId || v.slug) : null;
                            if (sid && !serverIds.includes(sid)) serverIds.push(sid);
                        }
                    }
                } catch { /* ids are advisory */ }
                console.log('[AIService] mcpTurn', {
                    command: String(baseMessageContent || '').slice(0, 120),
                    workspace: workspaceContext.workspaceId ? String(workspaceContext.workspaceId) : null,
                    mcpServers: serverIds.slice(0, 8),
                    serverScope: Array.isArray(mcpServerScope) ? mcpServerScope.slice(0, 8) : [],
                    exposedMcp: mcpPlan.exposedCount,
                    blockedMcp: mcpPlan.blockedCount,
                    mcpFailures: mcpPlan.failureCount,
                    intent: mcpPlan.intent,
                    selectedMcpTools: mcpPlan.selectedMcpTools,
                    requiredMcpTools: mcpPlan.requiredMcpTools,
                    executable: mcpPlan.executable,
                    suppressed: mcpPlan.suppressed,
                    finalTools: (Array.isArray(tools) ? tools : []).map((s) => s?.function?.name).filter(Boolean)
                });
                // ASSERT-1: every MCP tool named in inventory exists in final
                // request.tools (visibility invariant, checked not assumed).
                try {
                    const block = this.mcpInventoryBlockForTools(tools, { metadata: mcpMetadata, failures: [] });
                    const advertised = [...block.matchAll(/\bmcp_[a-z0-9_]+\b/g)].map((m) => m[0]);
                    const offered = new Set((Array.isArray(tools) ? tools : []).map((s) => s?.function?.name).filter(Boolean));
                    const leaked = [...new Set(advertised)].filter((n) => !offered.has(n));
                    if (leaked.length) {
                        console.error('[AIService] ASSERT-1 inventory/request.tools mismatch', { leaked });
                    }
                } catch { /* assertions must never break the path */ }
                // ASSERT-2/3: required capabilities without an exposed match,
                // or executable:false despite an exposed match, are logged
                // with a read-only snapshot comparison (stale ownership
                // evidence for discovery/transport — never acted on here).
                if (mcpPlan.intent.length && !mcpPlan.requiredMcpTools.length && !mcpPlan.suppressed) {
                    console.error('[AIService] ASSERT-2 required capability without exposed match', {
                        intent: mcpPlan.intent,
                        exposedMcp: mcpPlan.exposedCount
                    });
                    try {
                        const gaps = this.diagnoseMcpSnapshot({ mcpSchemas, metadata: mcpMetadata });
                        if (gaps.length) console.error('[AIService] mcpSnapshot.stale', { gaps });
                    } catch { /* diagnostics only */ }
                }
            } catch { /* plan diagnostics must never break the path */ }

            if (socket) {
                socket.emit('ai:agent:status', {
                    status: retrievalItems.length > 0 ? 'retrieving memory' : 'thinking',
                    detail: retrievalItems.length > 0 ? `${retrievalItems.length} relevant workspace items prepared.` : 'No strong memory matches found.'
                });
            }

            const attachments = imageBase64
                ? [{ type: 'image', data: imageBase64, mimeType: 'image/jpeg' }]
                : [];

            if (socket) {
                socket.emit('ai:agent:status', {
                    status: 'thinking',
                    detail: 'Generating the response with the best available provider.'
                });
            }

            deliveryTiming.providerStartAt = Date.now();
            // Budget preflight diagnostic (sizes/counts ONLY — never content,
            // keys, or credentials). §13 shape: per-category estimates plus
            // the enforced budgets and any compaction applied. Diagnostics
            // must never break the request path.
            try {
                console.log('[AIService] contextBudget', {
                    ...budgeted.report,
                    toolGroups: toolPick.groups,
                    outputIntent,
                    hasAttachments: attachments.length > 0
                });
            } catch {
                // Diagnostics must never break the request path.
            }
            // Authoritative MCP preflight (single path): when the required
            // MCP schemas all resolve safely from the user text, they
            // execute BEFORE any free provider round — the model then
            // synthesizes real results but can never veto an authorized
            // capability. Otherwise the normal model-driven flow below runs
            // untouched (model acts → creation-context → one-shot recovery).
            let preflightResult = null;
            const preflightExecutedById = new Map();
            if (!syntheticResponse) {
                try {
                    preflightResult = await this.runMcpPreflight({
                        requiredSchemas: this.requiredMcpSchemas(toolPick, supportingMcp, tools),
                        tools,
                        baseText: baseMessageContent,
                        intentCaps: toolIntentCaps,
                        execFn: (wireName, args) => mcpExec(wireName, args),
                        socket,
                        workspaceId: workspaceContext.workspaceId,
                        signal: controller.signal,
                        title: baseMessageContent,
                        serverScope: mcpServerScope,
                        mcpSchemas: scopedMcpSchemas
                    });
                } catch { preflightResult = null; }
                if (preflightResult && Array.isArray(preflightResult.executed) && preflightResult.executed.length) {
                    for (const e of preflightResult.executed) {
                        if (e && e.toolCallId) preflightExecutedById.set(e.toolCallId, e);
                    }
                }
            }
            // Initial provider call with tool-mismatch failsafe (§8, final
            // defense only): if the provider rejects the request because the
            // model attempted a tool absent from request.tools, verify that
            // tool against the policy-exposed set, add its exact schema once
            // (cap respected, inventory refreshed to match), and retry ONCE.
            // Denied/unknown tools are never added — the error propagates
            // truthfully. The inventory/request.tools invariant above must
            // make this path rare, never load-bearing.
            // Preflight-adopted turns skip the free round entirely below.
            const generateInitial = (useTools, usePrompt) => this.llmRouter.generate({
                messages,
                systemPrompt: usePrompt,
                tools: useTools,
                stream: false,
                maxTokens,
                temperature: imageBase64 ? 0.2 : 0.3,
                userContext: {
                    userId,
                    isGuest,
                    calendarIntent,
                    requestKey: key,
                    taskMode: imageBase64 ? 'multimodal' : 'text'
                },
                attachments,
                signal: controller.signal
            });
            let response = syntheticResponse;
            // Preflight adopted: authoritative calls already executed — skip
            // the free provider round AND its guards entirely, falling
            // through to normal execution/synthesis below. No model veto.
            let toolCalls = [];
            if (preflightExecutedById.size > 0 && preflightResult && Array.isArray(preflightResult.toolCalls)) {
                toolCalls = preflightResult.toolCalls;
                finalOutputText = '';
            } else {
            if (!response) {
                try {
                    response = await generateInitial(tools, systemPrompt);
                } catch (genErr) {
                    const retrySpec = this.missingToolRetrySpec(genErr, tools, mcpSchemas, mcpProtectedNames);
                    if (!retrySpec) throw genErr;
                    console.log('[AIService] toolMismatch.retry', { tool: retrySpec.name });
                    tools = retrySpec.tools;
                    mcpProtectedNames = retrySpec.protectedNames;
                    try {
                        systemPrompt = this.refreshInventoryPrompt(
                            systemPrompt,
                            this.mcpInventoryBlockForTools(tools, { metadata: mcpMetadata, failures: mcpFailures })
                        );
                    } catch { /* inventory refresh must never break the path */ }
                    response = await generateInitial(tools, systemPrompt);
                }
            }
            deliveryTiming.providerDoneAt = Date.now();
            console.log('[AIService] provider.completed', {
                elapsedMs: deliveryTiming.providerDoneAt - deliveryTiming.providerStartAt,
                provider: response?.provider || null,
                model: response?.model || null,
                fallbackUsed: Boolean(response?.fallbackUsed)
            });

            if (socket) {
                socket.emit('ai:provider:info', {
                    provider: response?.provider || null,
                    fallbackUsed: Boolean(response?.fallbackUsed),
                    route: response?.route || null,
                    detail: response?.fallbackUsed
                        ? `Falling back to ${response?.provider || 'a backup provider'} for this request.`
                        : `Using ${response?.provider || 'the selected'} provider for this request.`
                });
            }

            assistantResponseMeta.provider = response?.provider || null;
            assistantResponseMeta.model = response?.model || null;
            assistantResponseMeta.tokens = response?.tokens || { input: 0, output: 0 };

            // Server TTS mode announcement (additive event). When server TTS
            // is active the client suppresses browser speechSynthesis for this
            // response and plays `ai:tts:audio` segments instead. Text delivery
            // below is unaffected either way.
            const serverTtsActive = Boolean(socket) && ttsService.isServerTtsActive();
            ttsBuffer = serverTtsActive
                ? new ttsService.TtsStreamBuffer({ socket, signal: controller.signal })
                : null;
            if (socket) {
                socket.emit('ai:tts:mode', { mode: serverTtsActive ? 'server' : 'browser' });
            }

            finalOutputText = response?.text || "";
            // Mutable: a target-resolution retry below may REPLACE this
            // turn's tool transaction with the resolved retry.
            // (Preflight-adopted turns already set toolCalls above.)
            toolCalls = response?.toolCalls || [];
            // ---- Initial-request exposure invariant (§7) ----
            // Every model-emitted MCP tool call must correspond to a
            // request.tools schema + an exposed policy-approved schema +
            // a resolvable registry tool. Violations fail closed with a
            // diagnostic — never a fabricated response.
            if (!syntheticResponse && Array.isArray(toolCalls) && toolCalls.length) {
                try {
                    const exposure = partitionToolCallsByExposure(toolCalls, tools);
                    if (exposure.unexposedNames.length) {
                        console.error('[AIService] initial tool-call exposure violation', {
                            unexposed: exposure.unexposedNames,
                            requestTools: (tools || []).map((t) => t?.function?.name).filter(Boolean)
                        });
                        toolCalls = exposure.exposedCalls;
                    }
                } catch { /* diagnostics must never break the path */ }
            }
            // ---- Deterministic MCP action enforcement ----
            // Pre-provider the turn marked REQUIRED_FOR_EXECUTION MCP
            // capabilities (policy-filtered + intent/entity-selected +
            // budgeted survivors in toolPick.mcpCapability). If the provider
            // emits ZERO tool calls, the turn must not end in prose while
            // required capabilities are unresolved: one bounded recovery pass
            // runs a constrained retry over the required schemas (single
            // unambiguous tool → provider-forced), then execution continues
            // through the normal machinery below. False-unavailable or
            // manual-API prose always recovers; ordinary prose recovers
            // unless it is a legitimate clarifying question (which the
            // pending flow collects). Never forces denied/unauthorized/
            // unavailable capabilities (no required schemas exist for them).
            // Never loops: exactly one recovery pass per turn.
            // Names of still-unresolved required tools ride along for
            // continuation (§9): round 1 executes one, continuation the rest.
            let recoveryRequiredNames = [];
            if (!syntheticResponse && (!Array.isArray(toolCalls) || !toolCalls.length)) {
                try {
                    const proseBad = isNoToolAvailableProse(finalOutputText) || isManualApiFallbackProse(finalOutputText);
                    const emptyAnswer = !String(finalOutputText || '').trim();
                    // Required = capability picks + supporting creation-context
                    // resolvers, intersected with the final provider-visible
                    // tools (visibility invariant holds for recovery too).
                    const requiredNames = [
                        ...(Array.isArray(toolPick.mcpCapability) ? toolPick.mcpCapability : []),
                        ...(Array.isArray(supportingMcp) ? supportingMcp : [])
                    ];
                    const seenRequired = new Set();
                    const requiredSchemas = [];
                    for (const n of requiredNames) {
                        if (seenRequired.has(n)) continue;
                        seenRequired.add(n);
                        const hit = (Array.isArray(tools) ? tools : []).find((s) => s?.function?.name === n);
                        if (hit) requiredSchemas.push(hit);
                    }
                    const plan = this.planMcpRecovery({
                        requiredSchemas,
                        suppressed: Boolean(toolPick?.mcpSuppressed),
                        proseBad,
                        emptyAnswer,
                        proseText: finalOutputText
                    });
                    if (plan) {
                        console.log('[AIService] mcpEnforcement.recovery', {
                            tools: plan.retryTools.map((s) => s?.function?.name).filter(Boolean),
                            forcedTool: plan.forcedTool || null,
                            reason: proseBad ? 'false-unavailable-prose' : (emptyAnswer ? 'empty-answer' : 'ordinary-prose-skip')
                        });
                        const outcome = await this.runMcpRecovery({
                            plan,
                            messages,
                            systemPrompt,
                            maxTokens,
                            temperature: imageBase64 ? 0.2 : 0.3,
                            userContext: {
                                userId,
                                isGuest,
                                calendarIntent,
                                requestKey: key,
                                taskMode: imageBase64 ? 'multimodal' : 'text'
                            },
                            attachments,
                            signal: controller.signal,
                            metadata: mcpMetadata,
                            baseText: baseMessageContent,
                            mcpSchemas: scopedMcpSchemas,
                            serverScope: mcpServerScope,
                            execFn: (wireName, args) => mcpExec(wireName, args)
                        });
                        if (outcome.recovered && outcome.toolCalls.length) {
                            toolCalls = outcome.toolCalls;
                            tools = outcome.tools;
                            systemPrompt = outcome.systemPrompt;
                            for (const s of outcome.tools) {
                                const n = s?.function?.name;
                                if (typeof n === 'string' && n && !mcpProtectedNames.includes(n)) mcpProtectedNames.push(n);
                            }
                            recoveryRequiredNames = plan.retryTools
                                .map((s) => s?.function?.name).filter(Boolean);
                            if (typeof outcome.text === 'string' && outcome.text) finalOutputText = outcome.text;
                            if (outcome.response) {
                                assistantResponseMeta.provider = outcome.response.provider || assistantResponseMeta.provider;
                                assistantResponseMeta.model = outcome.response.model || assistantResponseMeta.model;
                                assistantResponseMeta.tokens = outcome.response.tokens || assistantResponseMeta.tokens;
                            }
                        } else if (proseBad && typeof outcome.text === 'string' && outcome.text
                            && !isNoToolAvailableProse(outcome.text) && !isManualApiFallbackProse(outcome.text)) {
                            // Recovery still tool-less but the retry dropped
                            // the false claim: keep the cleaner text.
                            finalOutputText = outcome.text;
                        } else if (proseBad && outcome.capabilityMismatch) {
                            // Every required tool was rejected as
                            // entity/intent-mismatched (e.g. a comment tool
                            // for a create request): the model's prose is a
                            // false claim built on a mismatched toolset, and
                            // no clarification question applies. Replace it
                            // with one short truthful message — never a
                            // fabricated manual workflow, never a "no tool"
                            // claim about tools beyond the offered set.
                            // Nothing executes; the AI request is not
                            // retried; indexing/synthesis are untouched.
                            try {
                                const mismatchText = 'I couldn\u2019t complete that request with the tools available to me \u2014 none of them matched what was asked for, so nothing was created or changed. Please try again or rephrase the request.';
                                console.error('[AIService] mcpRecovery.capabilityMismatch', {
                                    tools: (Array.isArray(outcome.unresolved) ? outcome.unresolved : []).map((u) => u?.tool).filter(Boolean)
                                });
                                if (socket && !socket.isInterrupted) {
                                    await this.emitAssistantText(socket, mismatchText);
                                }
                                return mismatchText;
                            } catch { /* fallback must never throw */ }
                        } else if (proseBad && Array.isArray(outcome.unresolved) && outcome.unresolved.length
                            && outcome.unresolved.some((u) => Array.isArray(u.missing) && u.missing.length)) {
                            // Recovery failed on genuinely missing creation
                            // context (multi-team ambiguity, no listable
                            // scope): ask ONE concise clarification through
                            // the pending flow instead of the false prose.
                            // Never invents IDs; never a manual-API fallback.
                            try {
                                const first = outcome.unresolved.find((u) => Array.isArray(u.missing) && u.missing.length);
                                const schema = this.resolvePendingSchema(first.tool, tools, mcpSchemas)
                                    || (mcpSchemas || []).find((s) => s?.function?.name === first.tool)
                                    || null;
                                if (schema && this.isPendingPermitted(first.tool, mcpSchemas)) {
                                    const clarifyUpdateMode = this.upsertUpdateMode(schema, { intentCaps: toolIntentCaps, text: baseMessageContent });
                                    const pend = createPending(first.tool, {}, schema, Date.now(), { updateMode: clarifyUpdateMode });
                                    await this.savePendingToolCall(conversationId, userId, pend);
                                    const effectiveParams = effectiveRequiredParams(schema, { updateMode: clarifyUpdateMode });
                                    const params = effectiveParams.filter((p) => first.missing.includes(p.name));
                                    let question = buildClarification(first.tool, params.length ? params : effectiveParams.slice(0, 2), {});
                                    const optBits = [];
                                    for (const u of outcome.unresolved) {
                                        for (const [pname, items] of Object.entries(u.options || {})) {
                                            const list = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, 5);
                                            if (list.length) optBits.push(`Possible ${pname}: ${list.join(', ')}`);
                                        }
                                    }
                                    if (optBits.length) question += ` ${optBits.join(' ')}`;
                                    if (socket && !socket.isInterrupted) {
                                        await this.emitAssistantText(socket, question);
                                    }
                                    return question;
                                }
                            } catch { /* clarification fallback must never throw */ }
                        }
                    }
                } catch { /* enforcement must never break the request path */ }
                // ASSERT-5: required MCP capabilities with zero calls and
                // false-unavailable/manual prose reaching the user is a hard
                // truthfulness violation — fail closed with a diagnostic.
                // (Recovery above should have prevented this; the log is the
                // fail-closed record, never user prose.)
                try {
                    const stillRequired = (Array.isArray(toolPick.mcpCapability) ? toolPick.mcpCapability : [])
                        .filter((n) => (Array.isArray(tools) ? tools : []).some((s) => s?.function?.name === n));
                    if ((!Array.isArray(toolCalls) || !toolCalls.length) && stillRequired.length
                        && (isNoToolAvailableProse(finalOutputText) || isManualApiFallbackProse(finalOutputText))) {
                        console.error('[AIService] ASSERT-5 false-unavailable prose with required MCP capability', {
                            required: stillRequired
                        });
                    }
                } catch { /* assertions must never break the path */ }
            }
            } // end else: normal model-driven flow (preflight-adopted turns skip it entirely)
            const assistantToolMessage = {
                role: 'assistant',
                content: finalOutputText || '',
                toolCalls: toolCalls.map((toolCall) => ({
                    id: toolCall?.id,
                    function: {
                        name: toolCall?.function?.name,
                        arguments: toolCall?.function?.arguments || {}
                    }
                }))
            };

            const makeContinuationGeneration = async ({ assistantMessage, toolResults }) => {
                const continuationMessages = buildProviderContinuationMessages({
                    messages,
                    assistantMessage,
                    toolResults,
                    provider: response?.provider || 'groq'
                });

                // Continuation of the SAME tool-use transaction (not a new
                // intent): the tools referenced by the active tool calls are
                // mandatory. Sending tools=[] here makes providers reject the
                // request ("tool choice is none, but model called a tool").
                // MCP schemas ride along so an active `mcp_...` tool absent
                // from the previous set (scoring miss, cap, budget trim) is
                // still resolved — otherwise the continuation references a
                // tool missing from its own request.tools and Groq 400s.
                // mcpSchemas are already policy-filtered (exposed only), so
                // deny-wins is preserved.
                const activeContinuationNames = activeToolNamesFromCalls(assistantMessage?.toolCalls);
                // Enforcement remainder: required tools not yet executed stay
                // callable through continuation (round 1 executes one, the
                // continuation the rest), then final synthesis.
                let remainingRequired = [];
                try {
                    const done = new Set(
                        (Array.isArray(toolResults) ? toolResults : [])
                            .map((r) => r?.name).filter(Boolean)
                    );
                    for (const n of activeContinuationNames) done.add(n);
                    remainingRequired = (Array.isArray(recoveryRequiredNames) ? recoveryRequiredNames : [])
                        .filter((n) => !done.has(n));
                } catch { remainingRequired = []; }
                const continuationPick = selectContinuationTools(
                    tools,
                    activeContinuationNames,
                    () => toolRegistry.getSchemas(),
                    { mcpSchemas, requiredNames: remainingRequired }
                );

                console.log('[AIService] provider continuation payload', continuationMessages.map((message) => ({
                    role: message.role,
                    toolCallIds: Array.isArray(message.toolCalls)
                      ? message.toolCalls.map((toolCall) => toolCall?.id).filter(Boolean)
                      : message.toolCallId || message.tool_call_id || null
                })), {
                    continuationTools: continuationPick.tools.map((t) => t?.function?.name).filter(Boolean),
                    mandatoryCount: continuationPick.mandatoryCount
                });

                // Continuation visibility invariant (§11): the advertised
                // inventory must match the continuation request.tools — the
                // active tool plus any newly required tool, exposed only.
                let continuationPrompt = systemPrompt;
                try {
                    continuationPrompt = this.refreshInventoryPrompt(
                        systemPrompt,
                        this.mcpInventoryBlockForTools(continuationPick.tools, { metadata: mcpMetadata, failures: [] })
                    );
                } catch { /* inventory refresh must never break the path */ }

                // Hard invariant (Groq enforces server-side): every tool call
                // referenced by the continuation messages must exist in the
                // continuation request.tools. Resolvable tools are healed by
                // selectContinuationTools above; anything still unexposed here
                // (unknown/denied name the model produced anyway) is logged
                // loudly instead of failing silently downstream.
                try {
                    const exposure = partitionToolCallsByExposure(
                        assistantMessage?.toolCalls || [],
                        continuationPick.tools
                    );
                    if (exposure.unexposedNames.length > 0) {
                        console.error('[AIService] continuation tool-call exposure violation', {
                            unexposed: exposure.unexposedNames,
                            continuationTools: continuationPick.tools.map((t) => t?.function?.name).filter(Boolean)
                        });
                    }
                } catch {
                    // Diagnostics must never break the request path.
                }

                return this.llmRouter.generate({
                    messages: continuationMessages,
                    systemPrompt: continuationPrompt,
                    tools: continuationPick.tools,
                    stream: true,
                    maxTokens,
                    temperature: imageBase64 ? 0.2 : 0.3,
                    userContext: {
                        userId,
                        isGuest,
                        calendarIntent,
                        requestKey: key,
                        taskMode: imageBase64 ? 'multimodal' : 'text'
                    },
                    attachments: [],
                    signal: controller.signal
                });
            };

            // Consume a continuation stream while capturing any FOLLOW-UP
            // tool calls the model emits instead of text (Groq surfaces them
            // as a final textless { toolCalls } chunk). The tap observes every
            // stream chunk — consume() itself skips textless chunks before
            // its callback, so observing at the callback would miss exactly
            // the terminal tool-call chunk. No StreamingRuntime change.
            const consumeContinuation = async (generation, followUp, onChunk) => {
                if (!generation || !generation.stream) {
                    return this.streamingRuntime.consume(
                        generation ? generation.stream : null,
                        socket, controller.signal, onChunk || null, deliveryHooks);
                }
                const tap = async function* tapped() {
                    for await (const chunk of generation.stream) {
                        if (chunk && Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0) {
                            followUp.push(...chunk.toolCalls);
                        }
                        yield chunk;
                    }
                };
                return this.streamingRuntime.consume(tap(), socket, controller.signal, onChunk || null, deliveryHooks);
            };

            // Bounded second tool round: if a continuation answers with more
            // tool calls instead of text, execute them directly (max 4, no
            // planner re-entry) and synthesize once more with the same
            // mandatory-tools continuation path. If THAT still yields calls
            // instead of text, fall back to flattened text-only synthesis
            // (no tool_calls blocks, tools:[]) which always terminates the
            // loop with a natural-language answer.
            const runFollowUpContinuation = async (followUpCalls, siteOnChunk) => {
                const bounded = (Array.isArray(followUpCalls) ? followUpCalls : []).slice(0, 4);
                const toolResults = [];
                for (const tc of bounded) {
                    const fname = tc?.function?.name;
                    if (!fname) continue;
                    let args = {};
                    try {
                        args = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments) : tc.function.arguments || {};
                    } catch { args = {}; }
                    console.log('[AIService] follow-up tool execution', { tool: fname });
                    let result = null;
                    try {
                        result = await TaskExecutor.executeTool(fname, args, userId, socket, { signal: controller.signal, conversationId, workspaceId: workspaceContext.workspaceId });
                    } catch (execErr) {
                        result = { success: false, error: execErr?.message || 'Tool execution failed.' };
                    }
                    if (result?.clientAction && socket) socket.emit('ai:client:action', result.clientAction);
                    toolResults.push({ toolCallId: tc.id, name: fname, content: result });
                }
                const assistantMsg = {
                    role: 'assistant',
                    content: '',
                    toolCalls: bounded.map((tc) => ({
                        id: tc.id,
                        function: { name: tc?.function?.name, arguments: tc?.function?.arguments || {} }
                    }))
                };
                const gen2 = await makeContinuationGeneration({ assistantMessage: assistantMsg, toolResults });
                const followUp2 = [];
                const text2 = await consumeContinuation(gen2, followUp2, siteOnChunk);
                if (text2 && String(text2).trim()) return text2;
                if (followUp2.length === 0) return text2;
                console.log('[AIService] follow-up still tool-calling; flattened text synthesis', {
                    followUpTools: followUp2.map((t) => t?.function?.name).filter(Boolean)
                });
                const flatContext = toolResults
                    .map((r) => {
                        let body = '';
                        try {
                            body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
                        } catch { body = '[unserializable tool result]'; }
                        if (body.length > 6000) body = `${body.slice(0, 6000)}\n... [truncated]`;
                        return `[${r.name}] ${body}`;
                    })
                    .join('\n');
                // Flattened text-only synthesis carries NO tools, so its
                // inventory block must say exactly that (visibility
                // invariant holds for tool-less requests too).
                const flatPrompt = this.refreshInventoryPrompt(
                    systemPrompt,
                    this.mcpInventoryBlockForTools([], { metadata: null, failures: [] })
                );
                const flat = await this.llmRouter.generate({
                    messages: [{
                        role: 'user',
                        content: `${baseMessageContent}\n\nTool results:\n${flatContext}\n\nAnswer the user's request directly using these results.`
                    }],
                    systemPrompt: flatPrompt,
                    tools: [],
                    stream: true,
                    maxTokens,
                    temperature: imageBase64 ? 0.2 : 0.3,
                    userContext: {
                        userId,
                        isGuest,
                        calendarIntent,
                        requestKey: key,
                        taskMode: imageBase64 ? 'multimodal' : 'text'
                    },
                    attachments: [],
                    signal: controller.signal
                });
                return consumeContinuation(flat, [], siteOnChunk);
            };

            if (toolCalls && toolCalls.length > 0) {
                console.log(`[Agent Router] AI requested ${toolCalls.length} tool(s).`);
                // Required-argument gate (generic, native + MCP): a tool call
                // with missing/invalid required args is NEVER executed. A
                // single partial call enters the pending flow with one
                // deterministic question — previously it failed remotely and
                // degraded into an ask-again loop with no preserved state.
                // Any fresh tool transaction supersedes a stored pending one.
                await this.clearPendingToolCall(conversationId, userId);
                if (toolCalls.length === 1 && !syntheticResponse) {
                    const rawName = toolCalls[0]?.function?.name;
                    const execName = this.mapCalendarToolName(rawName, calendarIntent);
                    const argSchema = this.resolvePendingSchema(execName, tools, mcpSchemas)
                        || this.resolvePendingSchema(rawName, tools, mcpSchemas);
                    const permitted = this.isPendingPermitted(execName, mcpSchemas)
                        || this.isPendingPermitted(rawName, mcpSchemas);
                    if (argSchema && permitted && requiredParams(argSchema).length > 0) {
                        let parsed = {};
                        try {
                            parsed = typeof toolCalls[0].function.arguments === 'string'
                                ? JSON.parse(toolCalls[0].function.arguments)
                                : { ...(toolCalls[0].function.arguments || {}) };
                        } catch { parsed = {}; }
                    // Schema-declared defaults satisfy presence (the
                    // server sanctions the omission); validation then
                    // type-checks the merged call as usual. Mode-aware:
                    // conditional "required when creating" params join the
                    // gate in create mode, so a model-issued save without
                    // team/title cannot slip through to a bare execution.
                    let resolveIntentCaps = null;
                    try { resolveIntentCaps = classifyIntentCapabilities(baseMessageContent); } catch { resolveIntentCaps = null; }
                    let parsedForMode = {};
                    try { parsedForMode = typeof toolCalls[0]?.function?.arguments === 'string' ? JSON.parse(toolCalls[0].function.arguments) : { ...(toolCalls[0]?.function?.arguments || {}) }; } catch { parsedForMode = {}; }
                    const gateUpdateMode = this.upsertUpdateMode(argSchema, { intentCaps: resolveIntentCaps, text: baseMessageContent, args: parsedForMode });
                    const checked = (() => {
                        try {
                            const v = validateArgs(argSchema, applyParamDefaults(argSchema, parsed));
                            const extra = missingEffective(argSchema, (v && v.coerced) || parsed, { updateMode: gateUpdateMode });
                            if (!extra.length) return v;
                            const seen = new Set((v.errors || []).map((e) => e.name));
                            return { ok: false, errors: [...(v.errors || []), ...extra.filter((n) => !seen.has(n)).map((name) => ({ name, reason: 'required' }))], coerced: v.coerced };
                        } catch { return validateArgs(argSchema, applyParamDefaults(argSchema, parsed)); }
                    })();
                    if (!checked.ok) {
                        const params = effectiveRequiredParams(argSchema, { updateMode: gateUpdateMode });
                        const missed = checked.errors.map((e) => e.name);
                            // Target-resolution chaining (generic MCP write
                            // fix): when ONLY identifier-shaped args are
                            // missing (a title was named, no ID yet) and
                            // SEARCH/READ resolvers are exposed, resolve the
                            // target in-turn via those tools instead of
                            // asking the user for an internal ID. Gated on
                            // UPDATE/DELETE intent (existing-resource
                            // actions): pure CREATE requests never resolve —
                            // a missing parent is a destination choice, not
                            // an existing target. Bounded (one resolve + one
                            // retry round); on any miss falls through to the
                            // ask flow below.
                            const pureCreate = resolveIntentCaps && resolveIntentCaps.has('CREATE')
                                && !resolveIntentCaps.has('UPDATE') && !resolveIntentCaps.has('DELETE');
                            // Creation-context path (generic save/upsert fix):
                            // a pure-CREATE call missing required params
                            // resolves content from quoted spans and creation
                            // scope (team_id, …) through the integration's own
                            // LIST/READ tools — single/named candidates fill
                            // automatically, several unnamed produce a
                            // clarification WITH options, never invented IDs.
                            // Non-create requests use target resolution below.
                            let resolved = null;
                            let creationAsked = false;
                            if (pureCreate) {
                                const created = await this.tryCreationContext({
                                    originalCall: toolCalls[0],
                                    execName,
                                    argSchema,
                                    intentCaps: resolveIntentCaps,
                                    userText: baseMessageContent,
                                    mcpSchemas: scopedMcpSchemas,
                                    execFn: mcpExec
                                });
                                if (created && Array.isArray(created.toolCalls) && created.toolCalls.length > 0) {
                                    resolved = created;
                                } else if (created && created.ask) {
                                    creationAsked = true;
                                    const pend = createPending(execName, created.pendingArgs || checked.coerced, argSchema, Date.now(), { updateMode: false });
                                    console.log('[AIService] creationContext.ask', { tool: execName, missing: missed });
                                    await this.savePendingToolCall(conversationId, userId, pend);
                                    let question = buildClarification(
                                        execName,
                                        params.filter((p) => missed.includes(p.name)),
                                        created.pendingArgs || checked.coerced
                                    );
                                    if (created.optionsNote) question += ` ${created.optionsNote}`;
                                    if (socket && !socket.isInterrupted) {
                                        await this.emitAssistantText(socket, question);
                                    }
                                    return question;
                                }
                            }
                            if (!resolved && !creationAsked) {
                            resolved = await this.tryTargetResolution({
                                originalCall: toolCalls[0],
                                execName,
                                argSchema,
                                missing: missed,
                                intentCaps: resolveIntentCaps,
                                messages,
                                systemPrompt,
                                mcpSchemas,
                                maxTokens,
                                userId,
                                isGuest,
                                calendarIntent,
                                requestKey: key,
                                signal: controller.signal,
                                conversationId,
                                workspaceId: workspaceContext.workspaceId,
                                socket
                            });
                            }
                            if (resolved && Array.isArray(resolved.toolCalls) && resolved.toolCalls.length > 0) {
                                toolCalls = resolved.toolCalls;
                                if (typeof resolved.text === 'string' && resolved.text) {
                                    finalOutputText = resolved.text;
                                }
                                assistantToolMessage.toolCalls = toolCalls.map((toolCall) => ({
                                    id: toolCall?.id,
                                    function: {
                                        name: toolCall?.function?.name,
                                        arguments: toolCall?.function?.arguments || {}
                                    }
                                }));
                            } else {
                                const pend = createPending(execName, checked.coerced, argSchema, Date.now(), { updateMode: gateUpdateMode });
                                console.log('[AIService] pendingTool.ask', { tool: execName, missing: missed });
                                await this.savePendingToolCall(conversationId, userId, pend);
                                const question = buildClarification(
                                    execName,
                                    params.filter((p) => missed.includes(p.name)),
                                    checked.coerced
                                );
                                if (socket && !socket.isInterrupted) {
                                    await this.emitAssistantText(socket, question);
                                }
                                return question;
                            }
                        }
                    }
                }
                messages.push({
                    role: 'assistant',
                    content: finalOutputText || '',
                    toolCalls: toolCalls.map((toolCall) => ({
                        id: toolCall?.id,
                        function: {
                            name: toolCall?.function?.name,
                            arguments: toolCall?.function?.arguments || {}
                        }
                    }))
                });

                // Preflight-adopted turns never enter the planner: their calls
                // already executed authoritatively; the inline path below
                // reuses the stored results for synthesis. No re-execution.
                const usePlanner = shouldUsePlanner(toolCalls, finalOutputText) && preflightExecutedById.size === 0;
                if (usePlanner) {
                    // Build plan steps from toolCalls
                    const steps = toolCalls.map((toolCall) => {
                        const fname = this.mapCalendarToolName(toolCall.function.name, calendarIntent);
                        let args = {};
                        try { args = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments || {}; } catch (e) { args = {}; }
                        return { toolCallId: toolCall.id, tool: fname, args };
                    });

                    // Persist plan
                    const planTitle = (text || '').slice(0, 120) || 'Autonomous Plan';
                    const exec = await TaskPlanner.createPlan({ userId, workspaceId: workspaceContext.workspaceId, title: planTitle, prompt: text, steps });
                    if (socket) socket.emit('execution.created', {
                        executionId: exec._id.toString(),
                        title: exec.title,
                        workspaceId: workspaceContext.workspaceId ? String(workspaceContext.workspaceId) : null
                    });

                    // Execute plan (TaskPlanner emits progress events)
                    const execResult = await TaskPlanner.executePlan(exec._id, socket, { controller, workspaceId: workspaceContext.workspaceId, conversationId });

                    const plannerToolResults = (execResult.steps || [])
                        .filter((step) => step.toolCallId)
                        .map((step) => ({
                            toolCallId: step.toolCallId,
                            name: step.tool,
                            content: step.result || {}
                        }));

                        // Persist compact working-state refs so the NEXT turn
                        // can resolve "that"/"it" against this tool activity.
                        // Failure-silent; never blocks synthesis.
                        try {
                            await this.refreshWorkingStateFromResults(conversationId, userId, plannerToolResults);
                        } catch { /* working state is advisory */ }

                        if (execResult.status === 'CANCELLED' || (controller.signal && controller.signal.aborted)) {
                            finalOutputText = assistantDraftContent || finalOutputText || '';
                            if (assistantDraftMessageId && conversationId) {
                                console.log('[AIService] finalizing interrupted assistant draft', {
                                    conversationId: String(conversationId),
                                    messageId: String(assistantDraftMessageId),
                                    contentLength: String(finalOutputText || '').length
                                });
                                await Message.findByIdAndUpdate(assistantDraftMessageId, {
                                    content: finalOutputText,
                                    provider: assistantResponseMeta.provider,
                                    model: assistantResponseMeta.model,
                                    metadata: {
                                        tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                                        streaming: false,
                                        interrupted: true,
                                        partial: true,
                                        state: 'cancelled'
                                    }
                                });
                            }
                        } else {
                            if (execResult.status === 'FAILED' && socket) {
                                socket.emit('ai:agent:status', {
                                    status: 'synthesizing',
                                    detail: 'Synthesizing a partial answer from recovered and failed steps.'
                                });
                            }

                            if (assistantDraftMessageId && assistantDraftContent) {
                                await Message.findByIdAndUpdate(assistantDraftMessageId, {
                                    content: assistantDraftContent,
                                    provider: assistantResponseMeta.provider,
                                    model: assistantResponseMeta.model,
                                    metadata: {
                                        tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                                        streaming: true,
                                        interrupted: false,
                                        partial: true,
                                        state: 'streaming'
                                    }
                                });
                            }

                            const finalGeneration = await makeContinuationGeneration({
                                assistantMessage: assistantToolMessage,
                                toolResults: plannerToolResults
                            });

                            const plannerStreamOnChunk = async (chunkText) => {
                                assistantDraftContent += chunkText;
                                await persistAssistantDraft(assistantDraftContent, { interrupted: false, state: 'streaming' });
                                if (ttsBuffer) ttsBuffer.push(chunkText);
                            };
                            const followUp = [];
                            finalOutputText = await consumeContinuation(finalGeneration, followUp, plannerStreamOnChunk);
                            if (!String(finalOutputText || '').trim() && followUp.length > 0) {
                                console.log('[AIService] continuation requested follow-up tools', {
                                    tools: followUp.map((t) => t?.function?.name).filter(Boolean)
                                });
                                finalOutputText = await runFollowUpContinuation(followUp, plannerStreamOnChunk);
                            }
                        }
                } else {
                    console.log('[Planner] Delegating execution inline (quick tool path)');
                    const plannedTools = toolCalls.map((toolCall) => this.mapCalendarToolName(toolCall.function.name, calendarIntent));
                    console.log(`[Planner] Chosen tools (in order): ${plannedTools.join(' -> ')}`);
                    // Surface inline MCP execution on the existing agent
                    // status channel (the realtime panel renders presence):
                    // an executable MCP request must never look idle.
                    try {
                        const inlineMcp = plannedTools.filter((n) => typeof n === 'string' && n.startsWith('mcp_'));
                        if (inlineMcp.length && socket && !socket.isInterrupted) {
                            socket.emit('ai:agent:status', {
                                status: 'executing tools',
                                detail: `Running ${inlineMcp.slice(0, 4).join(', ')}${inlineMcp.length > 4 ? ', …' : ''}.`
                            });
                        }
                    } catch { /* status must never break execution */ }

                    for (const toolCall of toolCalls) {
                        if (socket && socket.isInterrupted) {
                            break;
                        }

                        // Preflight-adopted calls already executed: reuse the
                        // stored result for synthesis instead of re-executing.
                        // Same tool-message shape as a live execution below.
                        const preExecuted = preflightExecutedById.get(toolCall.id);
                        if (preExecuted) {
                            try {
                                if (preExecuted.content && preExecuted.content.clientAction && socket) {
                                    socket.emit('ai:client:action', preExecuted.content.clientAction);
                                }
                            } catch { /* advisory */ }
                            messages.push({
                                role: 'tool',
                                name: preExecuted.name,
                                content: typeof preExecuted.content === 'string'
                                    ? preExecuted.content
                                    : JSON.stringify(preExecuted.content ?? {}),
                                toolCallId: toolCall.id
                            });
                            continue;
                        }

                        const functionName = this.mapCalendarToolName(toolCall.function.name, calendarIntent);
                        if (functionName !== toolCall.function.name) {
                            console.log(
                                `[Planner] Tool override applied: ${toolCall.function.name} -> ${functionName}`
                            );
                        } else {
                            console.log(`[Planner] Selected tool: ${functionName}`);
                        }

                        const args = typeof toolCall.function.arguments === 'string' 
                            ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;

                        console.log('[Planner] Before tool execution:', { tool: functionName, args });

                        const toolResult = await TaskExecutor.executeTool(functionName, args, userId, socket, { signal: controller.signal, conversationId, workspaceId: workspaceContext.workspaceId });
                        let finalToolResult = toolResult;

                        if (!toolResult?.success) {
                            const recovery = await ToolRecoveryManager.recoverToolResult({
                                toolName: functionName,
                                args,
                                result: toolResult,
                                userId,
                                socket,
                                signal: controller.signal,
                                retryCount: 0
                            });

                            if (recovery?.recovered) {
                                finalToolResult = recovery.result;
                            }

                            if (recovery?.shouldReplan && socket) {
                                socket.emit('execution.replan.suggested', {
                                    executionId: null,
                                    tool: functionName,
                                    reason: recovery.failureReason || 'inline tool failure'
                                });
                            }
                        }

                        console.log('[Planner] After tool execution payload:', { tool: functionName, payload: finalToolResult });

                        if (finalToolResult.clientAction && socket) {
                            socket.emit('ai:client:action', finalToolResult.clientAction);
                        }

                        messages.push({
                            role: 'tool',
                            name: functionName,
                            content: JSON.stringify(finalToolResult),
                            toolCallId: toolCall.id
                        });

                        if (functionName === 'scheduleMeeting' && finalToolResult?.success) {
                            console.log('[Planner] scheduleMeeting succeeded; running optional checkCalendar confirmation.');
                            const createdStart = finalToolResult?.event?.start;
                            const createdEnd = finalToolResult?.event?.end;
                            let confirmationArgs = { maxResults: 5 };

                            if (createdStart && createdEnd) {
                                const start = new Date(createdStart);
                                const end = new Date(createdEnd);
                                if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                                    const timeMin = new Date(start.getTime() - (60 * 60 * 1000));
                                    const timeMax = new Date(end.getTime() + (60 * 60 * 1000));
                                    confirmationArgs = {
                                        timeMin: timeMin.toISOString(),
                                        timeMax: timeMax.toISOString(),
                                        maxResults: 10
                                    };
                                }
                            }

                            const confirmationResult = await TaskExecutor.executeTool('checkCalendar', confirmationArgs, userId, socket, { signal: controller.signal });
                            // Keep the confirmation for internal reasoning only; do not feed a synthetic tool_call_id back to the provider.
                            finalToolResult.internalConfirmation = confirmationResult;
                        }
                    }

                    const providerToolResults = toolCalls.map((toolCall) => {
                        const matchedResult = messages.find((message) => message.role === 'tool' && message.toolCallId === toolCall.id);
                        return matchedResult ? {
                            toolCallId: toolCall.id,
                            name: matchedResult.name,
                            content: matchedResult.content
                        } : null;
                    }).filter(Boolean);

                    // Persist compact working-state refs so the NEXT turn can
                    // resolve "it"/"that"/"the second one" against this tool
                    // activity. Failure-silent; never blocks synthesis.
                    try {
                        await this.refreshWorkingStateFromResults(conversationId, userId, providerToolResults);
                    } catch { /* working state is advisory */ }

                    const finalGeneration = await makeContinuationGeneration({
                        assistantMessage: assistantToolMessage,
                        toolResults: providerToolResults
                    });

                    const quickStreamOnChunk = ttsBuffer ? async (chunkText) => { ttsBuffer.push(chunkText); } : null;
                    const quickFollowUp = [];
                    finalOutputText = await consumeContinuation(finalGeneration, quickFollowUp, quickStreamOnChunk);
                    if (!String(finalOutputText || '').trim() && quickFollowUp.length > 0) {
                        console.log('[AIService] continuation requested follow-up tools', {
                            tools: quickFollowUp.map((t) => t?.function?.name).filter(Boolean)
                        });
                        finalOutputText = await runFollowUpContinuation(quickFollowUp, quickStreamOnChunk);
                    }
                }
            } else {
                finalOutputText = response?.text || '';
                if (socket) {
                    await this.streamingRuntime.emitText(socket, finalOutputText, controller.signal, async (chunkText) => {
                        assistantDraftContent += chunkText;
                        await persistAssistantDraft(assistantDraftContent, { interrupted: false, state: 'streaming' });
                        if (ttsBuffer) ttsBuffer.push(chunkText);
                    }, deliveryHooks);
                }
            }

            // Flush any buffered server-TTS audio only AFTER text delivery has
            // completed, so speech synthesis can never delay visible text.
            if (ttsBuffer) {
                try {
                    await ttsBuffer.flush();
                } catch (error) {
                    console.warn('[TTS] buffer flush failed:', error?.message || error);
                }
            }

            if (!finalOutputText || !String(finalOutputText).trim()) {
                finalOutputText = buildEmptyToolResponse({
                    calendarIntent,
                    toolCalls,
                    fallbackToolResults: []
                });
            }

            if (finalOutputText && !(socket && socket.isInterrupted) && !isGuest) {
                const memoryQuery = text || (document ? `Uploaded document: ${document.name}` : 'Uploaded a file.');
                const shouldSaveMemory = memoryLearningEnabled;

                if (shouldSaveMemory) {
                    const newMemory = new AIMemory({ userId, workspaceId: workspaceContext.workspaceId, query: memoryQuery, response: finalOutputText, source: 'conversation' });
                    await newMemory.save();
                }

                if (conversationId) {
                    try {
                        // Normalize stored text without destroying markdown structure:
                        // the chat UI renders history through a markdown renderer,
                        // and speech has its own dedicated stripper (ttsService).
                        const sanitizeForStorage = (t) => {
                            if (!t || typeof t !== 'string') return t;
                            let s = String(t);
                            s = s.replace(/\r\n|\r/g, '\n');
                            s = s.replace(/[ \t]+$/gm, '');
                            s = s.replace(/\n{3,}/g, '\n\n');
                            return s.trim();
                        };

                        const storedOutput = sanitizeForStorage(finalOutputText || '');

                        // Compact tool-activity records for next-turn working
                        // state derivation + audit trail. Bounded refs only
                        // (name + compact input summary + success flag) —
                        // never full outputs verbatim.
                        let storedToolCalls = [];
                        try {
                            storedToolCalls = (toolCalls || []).slice(0, 6).map((tc) => {
                                let argSummary = '';
                                try {
                                    const rawArgs = typeof tc?.function?.arguments === 'string'
                                        ? JSON.parse(tc.function.arguments) : (tc?.function?.arguments || {});
                                    const vals = Object.values(rawArgs).map((v) => String(v ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
                                    argSummary = vals.join(' | ').slice(0, 200);
                                } catch { argSummary = ''; }
                                return {
                                    toolName: String(tc?.function?.name || ''),
                                    input: { summary: argSummary },
                                    output: { summarized: true },
                                    status: 'success'
                                };
                            }).filter((e) => e.toolName);
                        } catch { storedToolCalls = []; }

                        let savedMessage = null;
                        if (assistantDraftMessageId) {
                            await Message.findByIdAndUpdate(assistantDraftMessageId, {
                                content: storedOutput,
                                provider: assistantResponseMeta.provider,
                                model: assistantResponseMeta.model,
                                toolCalls: storedToolCalls,
                                metadata: {
                                    tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                                    streaming: false,
                                    interrupted: false
                                }
                            });
                            savedMessage = await Message.findById(assistantDraftMessageId);
                        } else {
                            savedMessage = await Message.create({
                                conversationId,
                                workspaceId: workspaceContext.workspaceId || null,
                                role: 'ai',
                                content: storedOutput,
                                provider: assistantResponseMeta.provider,
                                model: assistantResponseMeta.model,
                                toolCalls: storedToolCalls,
                                metadata: {
                                    tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                                    streaming: false,
                                    interrupted: false
                                }
                            });
                        }

                        if (shouldSaveMemory) {
                            setImmediate(() => {
                                upsertTextVector({
                                    userId,
                                    workspaceId: workspaceContext.workspaceId,
                                    kind: 'message',
                                    entityId: savedMessage._id,
                                    text: `${text || ''} ${finalOutputText}`,
                                    metadata: {
                                        conversationId: String(conversationId),
                                        messageId: String(savedMessage._id),
                                        title: 'assistant message',
                                        // Never null: sanitizeMetadata omits
                                        // unknown providers instead of
                                        // writing provider:null (rejected by
                                        // the vector store). Indexing is
                                        // secondary — it must never fail the
                                        // chat or alter the AI response.
                                        provider: response?.provider || assistantResponseMeta.provider || undefined
                                    }
                                }).catch((error) => {
                                    console.warn('[WorkspaceIndex] message vector upsert failed:', error?.message || error);
                                });
                            });
                        }

                        if (socket) {
                            socket.emit('ai:provider:info', {
                                provider: response?.provider || null,
                                fallbackUsed: Boolean(response?.fallbackUsed),
                                route: response?.route || null
                            });
                        }

                        deliveryTiming.persistenceDoneAt = Date.now();
                        console.log('[AIService] delivery.completed', {
                            provider: assistantResponseMeta.provider || null,
                            elapsedMs: deliveryTiming.deliveryDoneAt != null && deliveryTiming.providerStartAt != null
                                ? deliveryTiming.deliveryDoneAt - deliveryTiming.providerStartAt
                                : null
                        });
                        console.log('[AIService] persistence.completed', {
                            elapsedMs: deliveryTiming.persistenceDoneAt - deliveryTiming.providerStartAt
                        });

                        const messageCount = await Message.countDocuments({ conversationId });
                        if (messageCount === 2) {
                            const conversationCtrl = require('../controllers/conversationController');
                            conversationCtrl.generateConversationTitle(conversationId, text || '');
                        }
                    } catch (err) {
                        console.error('[AIService] Error saving conversation message:', err);
                    }
                }
            }

            if (conversationId && !isGuest && socket && socket.isInterrupted) {
                const interruptedTitleSeed = String(assistantDraftContent || finalOutputText || '').trim();
                if (interruptedTitleSeed.length >= 24) {
                    const conversationCtrl = require('../controllers/conversationController');
                    conversationCtrl.generateConversationTitle(
                        conversationId,
                        `${text || ''} ${interruptedTitleSeed}`.trim()
                    );
                }
            }

            return finalOutputText;

        } catch (error) {
            // Normalize SDK shapes first (@google/genai reports `.status`,
            // OpenAI-compatible SDKs report `.status`) so classification
            // below and the router logs see one reliable `statusCode`.
            // Never touches secrets.
            normalizeProviderError(error, assistantResponseMeta.provider || null);
            const errorText = String(error?.message || error || '').toLowerCase();
            const isAbortError =
                error?.name === 'AbortError' ||
                errorText.includes('aborted') ||
                errorText.includes('user_interrupted') ||
                errorText.includes('interrupted');
            if (isAbortError) {
                console.log(`[AIService] Request aborted for user ${userId}.`);
                // Stop server TTS immediately so no stale audio plays after
                // barge-in / Stop Generating. Client flushes its audio queue.
                if (ttsBuffer) ttsBuffer.stop();

                if (assistantDraftMessageId && conversationId) {
                    const partialContent = assistantDraftContent || finalOutputText || '';
                    try {
                        console.log('[AIService] abort persistence checkpoint', {
                            conversationId: String(conversationId),
                            messageId: String(assistantDraftMessageId),
                            contentLength: String(partialContent || '').length
                        });
                        await Message.findByIdAndUpdate(assistantDraftMessageId, {
                            content: partialContent,
                            provider: assistantResponseMeta.provider,
                            model: assistantResponseMeta.model,
                            metadata: {
                                tokens: assistantResponseMeta.tokens || { input: 0, output: 0 },
                                streaming: false,
                                interrupted: true,
                                partial: true,
                                state: 'cancelled'
                            }
                        });
                    } catch (persistErr) {
                        console.warn('[AIService] Failed to persist interrupted draft:', persistErr?.message || persistErr);
                    }
                }

                if (socket) {
                    socket.emit('ai:agent:status', {
                        status: 'cancelled',
                        detail: 'Execution cancelled by user.'
                    });
                    socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
                }
                return "Cancelled";
            }

            console.error("[AIService] Error processing query:", error);
            // Structured, secret-free diagnostic: provider, model, HTTP status,
            // provider code, request-shape metadata. Message truncated; never
            // includes keys, tokens, or message content.
            console.error("[AIService] provider failure summary", describeProviderFailure(error, {
                providerId: assistantResponseMeta.provider || error?.providerId || null,
                model: assistantResponseMeta.model || error?.model || null,
                operation: 'processQuery',
                keyConfigured: error?.keyConfigured ?? null,
                // `tools` lives in a nested block; typeof-guard keeps this
                // diagnostic from throwing when it is out of scope here.
                // (The router's own structured log always carries the count.)
                tools: (typeof tools !== 'undefined' && Array.isArray(tools)) ? tools.length : null,
                hasAttachments: Boolean(imageBase64 || (document && (document.data || document.url))),
                stream: false
            }));
            let userFriendlyError = "An internal system error occurred.";

            // Context-budget refusal (HTTP 413 / context-length / TPM-limit):
            // the request itself is oversized, so retrying changes nothing.
            // Checked before the rate-limit branch via the shared classifier.
            const budgetFailure = classifyProviderFailure(error);
            if (budgetFailure.isContextBudget) {
                userFriendlyError = CONTEXT_BUDGET_USER_MESSAGE;
            } else if (error.statusCode === 429 || (error.message && (error.message.includes('capacity exceeded') || error.message.includes('Rate limit exceeded')))) {
                userFriendlyError = imageBase64 
                    ? "Your current multimodal provider is rate-limited right now. Please wait 1-2 minutes and retry the image request."
                    : "The current AI provider is rate-limited. Please wait a minute and try again.";
            } else if (error.statusCode === 400) {
                 // 400s are not always file problems (e.g. provider rejected a
                 // plain-text request). Only blame the file format when the
                 // request actually carried an attachment.
                 const hadAttachment = Boolean(imageBase64 || document);
                 userFriendlyError = hadAttachment
                     ? "There was an issue processing the file format. Please try again."
                     : "The AI provider could not process that request. Please try again.";
            }
            
            // Emit BOTH terminal signals (mirrors the credit-failure path):
            // the UI terminates generation on either one, so a dropped event
            // can never wedge it in "generating" forever.
            if (socket) socket.emit('bot_error', userFriendlyError);
            if (socket) socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
            return "Error";
        } finally {
            this.endRequest(key, controller);
        }
    }

}

module.exports = new AIService();