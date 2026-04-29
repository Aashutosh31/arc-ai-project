const { Mistral } = require('@mistralai/mistralai');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const TaskExecutor = require('./TaskExecutor');
const toolRegistry = require('../tools/index');
const pdfExtract = require('pdf-extraction'); // 🚀 The modern, working package!
const { consumeCredits, isGuestActorId } = require('./creditService');

const SCHEDULE_KEYWORDS = [
    'schedule',
    'book',
    'create meeting',
    'set meeting',
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

class AIService {
    constructor() {
        const apiKey = process.env.MISTRAL_API_KEY;
        this.client = new Mistral({ apiKey: apiKey });
        this.defaultModel = process.env.MISTRAL_MODEL || 'mistral-small-latest'; 
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

    async processQuery(userId, text, socket = null, imageBase64 = null, document = null) {
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

        const { key, controller } = this.beginRequest(socket, userId);
        try {
            const now = new Date();
            const currentDateString = now.toLocaleString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', 
                day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

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

            let currentModel = this.defaultModel;
            let messageContent = text || (document ? `Please analyze the attached document: ${document.name}` : "Hello");
            messageContent = `${messageContent}${documentContext}`;

            if (imageBase64) {
                currentModel = 'pixtral-12b-2409'; 
                messageContent = [
                    { type: 'text', text: messageContent },
                    { type: 'image_url', imageUrl: `data:image/jpeg;base64,${imageBase64}` }
                ];
                console.log("[Agent Router] Image detected! Swapped brain to Pixtral-12B Vision Model.");
            }

            const messages = [
                {
                    role: 'system',
                    content: `You are ARC-AI, an advanced, highly intelligent autonomous agent.
                    The current system date and time is: ${currentDateString}.
                    
                    CORE DIRECTIVES:
                    1. BE PROACTIVE: Use tools when necessary.
                    2. LONG-TERM MEMORY: Use 'storeUserFact' tool to remember personal facts.
                    3. UI CONTROL: Use 'openWebsite' or 'changeTheme' to control the user's system.
                    4. VISION & FILES: Analyze provided images or document text thoroughly and accurately.
                    5. COMPUTATION: Use 'executeCode' for exact math, logic, iteration, parsing, or verification instead of guessing.
                    6. CALENDAR: Use 'checkCalendar' to inspect availability and 'scheduleMeeting' to create or update meetings when the user asks to manage Google Calendar.
                    ${longTermMemoryText}` 
                },
                ...history,
                { role: 'user', content: messageContent }
            ];

            const tools = toolRegistry.getSchemas();
            const useTools = tools.length > 0 && !imageBase64;

            const response = await this.client.chat.complete({
                model: currentModel,
                messages: messages,
                tools: useTools ? tools : undefined,
                toolChoice: useTools ? "auto" : "none",
            }, {
                signal: controller.signal,
            });

            const message = response.choices[0].message;
            let finalOutputText = "";
            const toolCalls = message.toolCalls || message.tool_calls;
            const calendarIntent = classifyCalendarIntent(text);

            if (calendarIntent.type !== 'none') {
                console.log(
                    `[Planner] Calendar intent classified as "${calendarIntent.type}" (${calendarIntent.reason || 'rule match'}).`
                );
            }

            if (toolCalls && toolCalls.length > 0) {
                console.log(`[Agent Router] AI requested ${toolCalls.length} tool(s). Executing...`);
                messages.push(message);

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

                    const toolResult = await TaskExecutor.executeTool(functionName, args, userId, socket);

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

                        const confirmationResult = await TaskExecutor.executeTool('checkCalendar', confirmationArgs, userId, socket);
                        messages.push({
                            role: 'tool',
                            name: 'checkCalendar',
                            content: JSON.stringify(confirmationResult),
                            toolCallId: `${toolCall.id}-confirmation`
                        });
                    }
                }
                
                finalOutputText = await this.streamMistralResponse(messages, socket, currentModel, controller.signal);
            } else {
                finalOutputText = message.content;
                if (socket) {
                    const words = finalOutputText.split(' ');
                    for (const word of words) {
                        if (socket.isInterrupted) {
                            break;
                        }
                        socket.emit('ai:tts:response:chunk', { chunk: word + ' ', displayText: word + ' ', isFinal: false });
                        await new Promise(r => setTimeout(r, 20)); 
                    }
                }
            }

            if (socket) {
                socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
            }

            if (finalOutputText && !(socket && socket.isInterrupted) && !isGuest) {
                let memoryQuery = text || "Uploaded a file.";
                if (imageBase64) memoryQuery = `[Attached Image] ${text || ""}`;
                if (document) memoryQuery = `[Attached Document: ${document.name}] ${text || ""}`;
                
                const newMemory = new AIMemory({ userId, query: memoryQuery, response: finalOutputText });
                await newMemory.save();
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
                    ? "Mistral's free tier has strict limits on image analysis. Please wait 1-2 minutes before uploading another photo."
                    : "Mistral API capacity exceeded. Please wait a minute.";
            } else if (error.statusCode === 400) {
                 userFriendlyError = "There was an issue processing the file format. Please try again.";
            }
            
            if (socket) socket.emit('bot_error', userFriendlyError);
            return "Error";
        } finally {
            this.endRequest(key, controller);
        }
    }

    async streamMistralResponse(messages, socket, modelToUse, signal) {
        let accumulatedText = "";
        const stream = await this.client.chat.stream({
            model: modelToUse,
            messages: messages
        }, {
            signal,
        });

        for await (const chunk of stream) {
            if (socket && socket.isInterrupted) {
                console.log("[Agent Router] Stream aborted by user.");
                break; 
            }

            const content = chunk.data.choices[0].delta.content;
            if (content) {
                accumulatedText += content;
                if (socket) {
                    socket.emit('ai:tts:response:chunk', { chunk: content, displayText: content, isFinal: false });
                }
            }
        }
        return accumulatedText;
    }
}

module.exports = new AIService();