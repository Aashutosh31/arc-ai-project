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
const { selectToolSchemas, detectOutputIntent, activeToolNamesFromCalls, selectContinuationTools } = require('../lib/llm/toolSelection');
const {
    OUTPUT_BUDGET_DEFAULT,
    OUTPUT_BUDGET_EXTENDED,
    DOC_CHARS_INITIAL,
    assembleBudgetedRequest
} = require('../lib/llm/contextBudget');
const WorkspaceRuntimeManager = require('./WorkspaceRuntimeManager');
const WorkspaceLogger = require('../lib/WorkspaceLogger');
const ttsService = require('./ttsService');

// Truthful refusal when a request cannot fit the provider context budget
// even after deterministic compaction. Used both for pre-provider refusal
// and for provider-reported 413s — one message, no duplication drift.
const CONTEXT_BUDGET_USER_MESSAGE = "That request exceeds the current AI provider's context budget. Please start a new conversation or shorten the request and try again.";

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

    async emitAssistantText(socket, text) {
        await this.streamingRuntime.emitText(socket, text);
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
            // provider-context (messages[]) carries ONLY the current user
            // turn; short-term continuity arrives via RAG message snippets.
            // Display history (pagination) and provider context stay separate.
            const toolPick = selectToolSchemas(baseMessageContent, () => toolRegistry.getSchemas());
            const outputIntent = detectOutputIntent(baseMessageContent);
            const outputBudget = outputIntent === 'extended' ? OUTPUT_BUDGET_EXTENDED : OUTPUT_BUDGET_DEFAULT;

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

                    __LONG_TERM_MEMORY_SLOT____RETRIEVAL_CONTEXT_SLOT__

                    IDENTITY DIRECTIVE:
                    If a user asks "who created you", "who made you", or similar identity/creator questions, reply exactly with:

                    "I am ARC-AI, an autonomous multimodal AI platform created by Aashutosh Bairagi — an AI systems engineer focused on realtime architectures, autonomous agents, and next-generation intelligent software systems."
                    `;

            const budgeted = assembleBudgetedRequest({
                systemTemplate,
                baseUserText: baseMessageContent,
                docText: documentContext,
                memoryDocs,
                factDocs,
                ragItems: retrievalItems,
                selectedTools: toolPick.tools,
                outputBudget,
                query: baseMessageContent
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
            const systemPrompt = budgeted.systemPrompt;
            const tools = budgeted.tools;
            const maxTokens = budgeted.maxTokens;

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
            const response = await this.llmRouter.generate({
                messages,
                systemPrompt,
                tools,
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
            const toolCalls = response?.toolCalls || [];
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
                    provider: response?.provider || 'mistral'
                });

                // Continuation of the SAME tool-use transaction (not a new
                // intent): the tools referenced by the active tool calls are
                // mandatory. Sending tools=[] here makes providers reject the
                // request ("tool choice is none, but model called a tool").
                const activeContinuationNames = activeToolNamesFromCalls(assistantMessage?.toolCalls);
                const continuationPick = selectContinuationTools(
                    tools,
                    activeContinuationNames,
                    () => toolRegistry.getSchemas()
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

                return this.llmRouter.generate({
                    messages: continuationMessages,
                    systemPrompt,
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
                const flat = await this.llmRouter.generate({
                    messages: [{
                        role: 'user',
                        content: `${baseMessageContent}\n\nTool results:\n${flatContext}\n\nAnswer the user's request directly using these results.`
                    }],
                    systemPrompt,
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

                const usePlanner = shouldUsePlanner(toolCalls, finalOutputText);
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

                    for (const toolCall of toolCalls) {
                        if (socket && socket.isInterrupted) {
                            break;
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

                        let savedMessage = null;
                        if (assistantDraftMessageId) {
                            await Message.findByIdAndUpdate(assistantDraftMessageId, {
                                content: storedOutput,
                                provider: assistantResponseMeta.provider,
                                model: assistantResponseMeta.model,
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
                                        provider: response?.provider || null
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
            // mistralai reports `.statusCode`) so classification below and the
            // router logs see one reliable `statusCode`. Never touches secrets.
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