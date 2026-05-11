const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const TaskExecutor = require('./TaskExecutor');
const toolRegistry = require('../tools/index');
const pdfExtract = require('pdf-extraction'); // 🚀 The modern, working package!
const { consumeCredits, isGuestActorId } = require('./creditService');
const LLMRouter = require('../lib/llm/LLMRouter');
const StreamingRuntime = require('../lib/llm/StreamingRuntime');

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

class AIService {
    constructor() {
        this.llmRouter = new LLMRouter();
        this.streamingRuntime = new StreamingRuntime();
        this.activeRequests = new Map();
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

    async processQuery(userId, text, socket = null, imageBase64 = null, document = null, conversationId = null) {
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

        // Handle conversation lifecycle
        if (!isGuestActorId(userId)) {
            try {
                if (!conversationId) {
                    // Create a new conversation
                    const newConversation = new Conversation({
                        userId,
                        title: 'New Conversation'
                    });
                    await newConversation.save();
                    conversationId = newConversation._id;
                    
                    // Notify frontend of new conversation ID
                    if (socket) {
                        socket.emit('ai:conversation:created', { conversationId: conversationId.toString() });
                    }
                }

                // Save user message
                await Message.create({
                    conversationId,
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
        try {
            console.log(`[Planner] Incoming user command: ${String(text || '').trim()}`);
            const now = new Date();
            const currentDateString = now.toLocaleString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', 
                day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            const calendarIntent = classifyCalendarIntent(text);

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

                if (!isGuestActorId(userId)) {
                    const newMemory = new AIMemory({
                        userId,
                        query: text || 'Schedule meeting request',
                        response: scheduleResponse
                    });
                    await newMemory.save();
                }

                return scheduleResponse;
            }

            const isGuest = isGuestActorId(userId);
            const history = isGuest ? [] : await AIMemory.find({ userId }).sort({ timestamp: -1 }).limit(15)
                .then((recentMemories) => recentMemories.reverse()
                    .filter(mem => mem.query && mem.response)
                    .map(mem => [
                        { role: 'user', content: String(mem.query) },
                        { role: 'assistant', content: String(mem.response) }
                    ]).flat());

            const userFacts = isGuest ? [] : await UserFact.find({ userId });
            let longTermMemoryText = "";
            if (userFacts.length > 0) {
                longTermMemoryText = "\n\nCRITICAL CONTEXT - You permanently know these facts about the user:\n" + 
                    userFacts.map(f => `- ${f.fact}`).join("\n");
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

                    if (parsedText.length > 80000) {
                        parsedText = parsedText.substring(0, 80000) + "\n... [Document truncated due to length limits]";
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

            let messageContent = text || (document ? `Please analyze the attached document: ${document.name}` : "Hello");
            messageContent = `${messageContent}${documentContext}`;

            const systemPrompt = `You are ARC-AI, an advanced, highly intelligent autonomous agent.
                    The current system date and time is: ${currentDateString}.
                    
                    CORE DIRECTIVES:
                    1. BE PROACTIVE: Use tools when necessary.
                    2. LONG-TERM MEMORY: Use 'storeUserFact' tool to remember personal facts.
                    3. UI CONTROL: Use 'openWebsite' or 'changeTheme' to control the user's system.
                    4. VISION & FILES: Analyze provided images or document text thoroughly and accurately.
                    5. COMPUTATION: Use 'executeCode' for exact math, logic, iteration, parsing, or verification instead of guessing.
                    6. CALENDAR: Use 'checkCalendar' to inspect availability and 'scheduleMeeting' to create or update meetings when the user asks to manage Google Calendar.
                    7. WHATSAPP: Use 'sendWhatsAppMessage' only when the user explicitly asks to send, message, text, forward, or deliver content on WhatsApp. Do not trigger the WhatsApp tool for vague references, questions, contact checks, or phrases like 'can you see', 'is Mummy there', or similar unless the user clearly wants a message sent. Ask a follow-up if the recipient is ambiguous or the request is not an explicit send action.
                    ${longTermMemoryText}`;

            const messages = [
                ...history,
                { role: 'user', content: messageContent }
            ];

            const tools = toolRegistry.getSchemas();
            const attachments = imageBase64 ? [{ type: 'image', mimeType: 'image/jpeg', data: imageBase64 }] : [];

            const response = await this.llmRouter.generate({
                messages,
                systemPrompt,
                tools,
                stream: false,
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

            let finalOutputText = response?.text || "";
            const toolCalls = response?.toolCalls || [];

            if (toolCalls && toolCalls.length > 0) {
                console.log(`[Agent Router] AI requested ${toolCalls.length} tool(s). Executing...`);
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

                    const toolResult = await TaskExecutor.executeTool(functionName, args, userId, socket, { signal: controller.signal });
                    console.log('[Planner] After tool execution payload:', { tool: functionName, payload: toolResult });

                    if (toolResult.clientAction && socket) {
                        socket.emit('ai:client:action', toolResult.clientAction);
                    }

                    messages.push({
                        role: 'tool',
                        name: functionName,
                        content: JSON.stringify(toolResult),
                        toolCallId: toolCall.id
                    });

                    if (functionName === 'scheduleMeeting' && toolResult?.success) {
                        console.log('[Planner] scheduleMeeting succeeded; running optional checkCalendar confirmation.');
                        const createdStart = toolResult?.event?.start;
                        const createdEnd = toolResult?.event?.end;
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
                        messages.push({
                            role: 'tool',
                            name: 'checkCalendar',
                            content: JSON.stringify(confirmationResult),
                            toolCallId: `${toolCall.id}-confirmation`
                        });
                    }
                }
                
                const malformedContinuationMessages = messages.filter((message) => message.role === 'tool' && (!message.toolCallId || !message.name || typeof message.content !== 'string'));
                if (malformedContinuationMessages.length > 0) {
                    console.warn('[AIService] Malformed tool continuation payload detected.', {
                        count: malformedContinuationMessages.length,
                        sample: malformedContinuationMessages[0]
                    });
                }

                const finalGeneration = await this.llmRouter.generate({
                    messages,
                    systemPrompt,
                    tools: [],
                    stream: true,
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

                finalOutputText = await this.streamingRuntime.consume(finalGeneration.stream, socket, controller.signal);
            } else {
                finalOutputText = response?.text || '';
                if (socket) {
                    await this.streamingRuntime.emitText(socket, finalOutputText, controller.signal);
                }
            }

            if (!finalOutputText || !String(finalOutputText).trim()) {
                finalOutputText = 'Meeting request processed but confirmation pending.';
            }

            if (finalOutputText && !(socket && socket.isInterrupted) && !isGuest) {
                let memoryQuery = text || "Uploaded a file.";
                if (imageBase64) memoryQuery = `[Attached Image] ${text || ""}`;
                if (document) memoryQuery = `[Attached Document: ${document.name}] ${text || ""}`;
                
                const newMemory = new AIMemory({ userId, query: memoryQuery, response: finalOutputText });
                await newMemory.save();

                // Also save to conversation messages
                if (conversationId) {
                    try {
                        await Message.create({
                            conversationId,
                            role: 'ai',
                            content: finalOutputText,
                            provider: response?.provider || null,
                            model: response?.model || null,
                            metadata: {
                                tokens: response?.tokens || { input: 0, output: 0 },
                                streaming: true,
                                interrupted: false
                            }
                        });

                        // Generate title async on first message
                        const messageCount = await Message.countDocuments({ conversationId });
                        if (messageCount === 2) { // 1 user + 1 ai
                            const conversationCtrl = require('../controllers/conversationController');
                            conversationCtrl.generateConversationTitle(conversationId, text || '');
                        }
                    } catch (err) {
                        console.error('[AIService] Error saving conversation message:', err);
                    }
                }
            }

            return finalOutputText;

        } catch (error) {
            const errorText = String(error?.message || error || '').toLowerCase();
            const isAbortError =
                error?.name === 'AbortError' ||
                errorText.includes('aborted') ||
                errorText.includes('user_interrupted') ||
                errorText.includes('interrupted');
            if (isAbortError) {
                console.log(`[AIService] Request aborted for user ${userId}.`);
                if (socket) {
                    socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
                }
                return "Interrupted";
            }

            console.error("[AIService] Error processing query:", error);
            let userFriendlyError = "An internal system error occurred.";
            
                if (error.statusCode === 429 || (error.message && (error.message.includes('capacity exceeded') || error.message.includes('Rate limit exceeded')))) {
                userFriendlyError = imageBase64 
                    ? "Your current multimodal provider is rate-limited right now. Please wait 1-2 minutes and retry the image request."
                    : "The current AI provider is rate-limited. Please wait a minute and try again.";
            } else if (error.statusCode === 400) {
                 userFriendlyError = "There was an issue processing the file format. Please try again.";
            }
            
            if (socket) socket.emit('bot_error', userFriendlyError);
            return "Error";
        } finally {
            this.endRequest(key, controller);
        }
    }

}

module.exports = new AIService();