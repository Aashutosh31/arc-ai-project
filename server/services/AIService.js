const { Mistral } = require('@mistralai/mistralai');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact'); // <-- NEW: Import Long-Term Memory Model
const TaskExecutor = require('./TaskExecutor');
const toolRegistry = require('../tools/index');

class AIService {
    constructor() {
        const apiKey = process.env.MISTRAL_API_KEY;
        this.client = new Mistral({ apiKey: apiKey });
        this.model = process.env.MISTRAL_MODEL || 'mistral-tiny';
    }

    async processQuery(userId, text) {
        try {
            // 1. Fetch Short-Term Memory (recent conversation)
            const recentMemories = await AIMemory.find({ userId })
                .sort({ timestamp: -1 })
                .limit(5);

            const history = recentMemories.reverse().map(mem => [
                { role: 'user', content: mem.query },
                { role: 'assistant', content: mem.response }
            ]).flat();

            // 2. NEW: Fetch Long-Term Memory (Permanent facts)
            const userFacts = await UserFact.find({ userId });
            let longTermMemoryText = "";
            
            if (userFacts.length > 0) {
                // Format the facts into a readable list for the AI
                longTermMemoryText = "\n\nHere are permanent facts you know about this user:\n" + 
                    userFacts.map(f => `- ${f.fact}`).join("\n");
            }

            // 3. Build the Agent Router Message Context
            const messages = [
                {
                    role: 'system',
                    content: `You are ARC-AI, an advanced, highly capable AI assistant created by Aashutosh.
                    You are equipped with real-time tools. If a user asks a question or makes a request 
                    that requires a tool (like checking the time, setting a reminder, or saving a fact), USE THE APPROPRIATE TOOL.
                    Do not hallucinate answers if a tool is available. Be conversational and helpful.
                    ${longTermMemoryText}` // <-- NEW: Injecting the facts dynamically!
                },
                ...history,
                { role: 'user', content: text }
            ];

            // 4. Load Schemas from our plugin ecosystem
            const tools = toolRegistry.getSchemas();

            // 5. Step 1: Reasoning phase (Does the AI need a tool?)
            const response = await this.client.chat.complete({
                model: this.model,
                messages: messages,
                tools: tools.length > 0 ? tools : undefined,
                toolChoice: tools.length > 0 ? "auto" : "none",
            });

            const message = response.choices[0].message;
            let finalOutputText = message.content;

            // 6. Tool Call Execution Loop
            const toolCalls = message.toolCalls || message.tool_calls;

            if (toolCalls && toolCalls.length > 0) {
                console.log(`[Agent Router] AI requested ${toolCalls.length} tool(s). Executing...`);
                
                messages.push(message);

                for (const toolCall of toolCalls) {
                    const functionName = toolCall.function.name;
                    
                    const args = typeof toolCall.function.arguments === 'string' 
                        ? JSON.parse(toolCall.function.arguments) 
                        : toolCall.function.arguments;

                    const toolResult = await TaskExecutor.executeTool(functionName, args, userId);

                    messages.push({
                        role: 'tool',
                        name: functionName,
                        content: JSON.stringify(toolResult),
                        toolCallId: toolCall.id
                    });
                }

                // 7. Step 2: Synthesis Phase
                console.log(`[Agent Router] Tools executed. Generating final user response...`);
                const finalResponse = await this.client.chat.complete({
                    model: this.model,
                    messages: messages
                });

                finalOutputText = finalResponse.choices[0].message.content;
            }

            // 8. Store final conversation result in Short-Term Memory
            const newMemory = new AIMemory({
                userId,
                query: text,
                response: finalOutputText
            });
            await newMemory.save();

            return finalOutputText;

        } catch (error) {
            console.error("[AIService] Error processing query:", error);
            return "I encountered an internal error while processing your request. Please try again.";
        }
    }
}

module.exports = new AIService();