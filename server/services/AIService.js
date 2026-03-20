const { Mistral } = require('@mistralai/mistralai');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const TaskExecutor = require('./TaskExecutor');
const toolRegistry = require('../tools/index');

class AIService {
    constructor() {
        const apiKey = process.env.MISTRAL_API_KEY;
        this.client = new Mistral({ apiKey: apiKey });
        this.model = process.env.MISTRAL_MODEL || 'mistral-tiny';
    }

    async processQuery(userId, text, socket = null) {
        try {
            const now = new Date();
            const currentDateString = now.toLocaleString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', 
                day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            const recentMemories = await AIMemory.find({ userId }).sort({ timestamp: -1 }).limit(5);
            const history = recentMemories.reverse()
                .filter(mem => mem.query && mem.response)
                .map(mem => [
                    { role: 'user', content: String(mem.query) },
                    { role: 'assistant', content: String(mem.response) }
                ]).flat();

            const userFacts = await UserFact.find({ userId });
            let longTermMemoryText = "";
            if (userFacts.length > 0) {
                longTermMemoryText = "\n\nHere are permanent facts you know about this user:\n" + 
                    userFacts.map(f => `- ${f.fact}`).join("\n");
            }

            const messages = [
                {
                    role: 'system',
                    content: `You are ARC-AI, an advanced, highly capable AI assistant created by Aashutosh.
                    The current system date and time is: ${currentDateString}.
                    You are equipped with real-time tools. If a user asks a question or makes a request 
                    that requires a tool, USE THE APPROPRIATE TOOL.
                    Do not hallucinate answers if a tool is available. Be conversational and helpful.
                    ${longTermMemoryText}` 
                },
                ...history,
                { role: 'user', content: text }
            ];

            const tools = toolRegistry.getSchemas();

            const response = await this.client.chat.complete({
                model: this.model,
                messages: messages,
                tools: tools.length > 0 ? tools : undefined,
                toolChoice: tools.length > 0 ? "auto" : "none",
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

                    // 🚀 NEW: If the tool wants to trigger a UI action, emit it to the client!
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
                
                console.log(`[Agent Router] Tools executed. Streaming final response...`);
                finalOutputText = await this.streamMistralResponse(messages, socket);
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

            if (text && finalOutputText) {
                const newMemory = new AIMemory({ userId, query: text, response: finalOutputText });
                await newMemory.save();
            }

            return finalOutputText;

        } catch (error) {
            console.error("[AIService] Error processing query:", error);
            if (socket) socket.emit('ai:tts:response:chunk', { chunk: "Error", displayText: "Internal error occurred.", isFinal: true });
            return "Error";
        }
    }

    async streamMistralResponse(messages, socket) {
        let accumulatedText = "";
        const stream = await this.client.chat.stream({
            model: this.model,
            messages: messages
        });

        for await (const chunk of stream) {
            if (socket && socket.isInterrupted) {
                console.log("[Agent Router] Stream aborted by user to save tokens.");
                break; 
            }

            const content = chunk.data.choices[0].delta.content;
            if (content) {
                accumulatedText += content;
                if (socket) {
                    socket.emit('ai:tts:response:chunk', {
                        chunk: content,
                        displayText: content,
                        isFinal: false
                    });
                }
            }
        }
        
        return accumulatedText;
    }
}

module.exports = new AIService();