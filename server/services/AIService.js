const { Mistral } = require('@mistralai/mistralai');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const TaskExecutor = require('./TaskExecutor');
const toolRegistry = require('../tools/index');
const pdfExtract = require('pdf-extraction'); // 🚀 The modern, working package!

class AIService {
    constructor() {
        const apiKey = process.env.MISTRAL_API_KEY;
        this.client = new Mistral({ apiKey: apiKey });
        this.defaultModel = process.env.MISTRAL_MODEL || 'mistral-small-latest'; 
    }

    async processQuery(userId, text, socket = null, imageBase64 = null, document = null) {
        try {
            const now = new Date();
            const currentDateString = now.toLocaleString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', 
                day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            const recentMemories = await AIMemory.find({ userId }).sort({ timestamp: -1 }).limit(15);
            const history = recentMemories.reverse()
                .filter(mem => mem.query && mem.response)
                .map(mem => [
                    { role: 'user', content: String(mem.query) },
                    { role: 'assistant', content: String(mem.response) }
                ]).flat();

            const userFacts = await UserFact.find({ userId });
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
            });

            const message = response.choices[0].message;
            let finalOutputText = "";
            const toolCalls = message.toolCalls || message.tool_calls;

            if (toolCalls && toolCalls.length > 0) {
                console.log(`[Agent Router] AI requested ${toolCalls.length} tool(s). Executing...`);
                messages.push(message);

                for (const toolCall of toolCalls) {
                    const functionName = toolCall.function.name;
                    const args = typeof toolCall.function.arguments === 'string' 
                        ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;

                    const toolResult = await TaskExecutor.executeTool(functionName, args, userId);

                    if (toolResult.clientAction && socket) {
                        socket.emit('ai:client:action', toolResult.clientAction);
                    }

                    messages.push({
                        role: 'tool',
                        name: functionName,
                        content: JSON.stringify(toolResult),
                        toolCallId: toolCall.id
                    });
                }
                
                finalOutputText = await this.streamMistralResponse(messages, socket, currentModel);
            } else {
                finalOutputText = message.content;
                if (socket) {
                    const words = finalOutputText.split(' ');
                    for (const word of words) {
                        socket.emit('ai:tts:response:chunk', { chunk: word + ' ', displayText: word + ' ', isFinal: false });
                        await new Promise(r => setTimeout(r, 20)); 
                    }
                }
            }

            if (socket) {
                socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
            }

            if (finalOutputText) {
                let memoryQuery = text || "Uploaded a file.";
                if (imageBase64) memoryQuery = `[Attached Image] ${text || ""}`;
                if (document) memoryQuery = `[Attached Document: ${document.name}] ${text || ""}`;
                
                const newMemory = new AIMemory({ userId, query: memoryQuery, response: finalOutputText });
                await newMemory.save();
            }

            return finalOutputText;

        } catch (error) {
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
        }
    }

    async streamMistralResponse(messages, socket, modelToUse) {
        let accumulatedText = "";
        const stream = await this.client.chat.stream({
            model: modelToUse,
            messages: messages
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