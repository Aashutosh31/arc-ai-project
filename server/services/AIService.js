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

    // Accept the socket as a parameter to emit data instantly
    async processQuery(userId, text, socket = null) {
        try {
            // 1. Fetch Context (Short-Term & Long-Term Memory)
            const recentMemories = await AIMemory.find({ userId }).sort({ timestamp: -1 }).limit(5);
            
            // 🚀 FIX: Filter out corrupted memories and strictly ensure content is a string
            const history = recentMemories.reverse()
                .filter(mem => mem.query && mem.response) // Must exist!
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
                    You are equipped with real-time tools. If a user asks a question or makes a request 
                    that requires a tool, USE THE APPROPRIATE TOOL.
                    Do not hallucinate answers if a tool is available. Be conversational and helpful.
                    ${longTermMemoryText}` 
                },
                ...history,
                { role: 'user', content: text }
            ];

            const tools = toolRegistry.getSchemas();

            // 2. Reasoning Phase (Fast, non-streamed check to see if a tool is needed)
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

                    messages.push({
                        role: 'tool',
                        name: functionName,
                        content: JSON.stringify(toolResult),
                        toolCallId: toolCall.id
                    });
                }
                
                // 3a. Synthesis Phase: Tools finished, generate the streaming response
                console.log(`[Agent Router] Tools executed. Streaming final response...`);
                finalOutputText = await this.streamMistralResponse(messages, socket);
            } else {
                // 3b. Synthesis Phase: No tools needed, just stream the response normally
                messages.push(message); // Wait, if no tool, we must re-prompt or just stream the original text.
                // Mistral already generated the text in the complete call. To make it truly stream,
                // we should bypass the first `.complete()` if no tools exist, OR just artificially stream the result.
                // Since Mistral v1 doesn't stream tools well, we'll artificially emit the fast response:
                finalOutputText = message.content;
                if (socket) {
                    // Split by words to simulate stream effect for the UI
                    const words = finalOutputText.split(' ');
                    for (const word of words) {
                        socket.emit('ai:tts:response:chunk', { chunk: word + ' ', displayText: word + ' ', isFinal: false });
                        await new Promise(r => setTimeout(r, 20)); // tiny delay for visual effect
                    }
                }
            }

            // 4. Signal that the stream is completely finished
            if (socket) {
                socket.emit('ai:tts:response:chunk', { chunk: '', displayText: '', isFinal: true });
            }

            // 5. Save the final conversation to short-term memory (Only if valid)
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

    // Helper method to pipe real tokens from Mistral directly to the socket
    async streamMistralResponse(messages, socket) {
        let accumulatedText = "";
        
        const stream = await this.client.chat.stream({
            model: this.model,
            messages: messages
        });

        for await (const chunk of stream) {
            const content = chunk.data.choices[0].delta.content;
            if (content) {
                accumulatedText += content;
                if (socket) {
                    // Emit exact format your frontend previously expected
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