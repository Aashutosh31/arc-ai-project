// server/services/AIService.js (COMPLETE CODE)

const axios = require('axios');
const AIMemory = require('../models/AIMemory');

// --- Module-level constants (Read from environment when module loads) ---
const API_KEY = process.env.MISTRAL_API_KEY; 
const MODEL = process.env.MISTRAL_MODEL || 'mistral-tiny'; // Default to a fast model
const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions'; 

// Define the structure for task execution (CRITICAL for "Jarvis")
const structuredIntentInstruction = JSON.stringify({
    intent: "A category like CONVERSATION, TASK_EXECUTION, DATA_QUERY.",
    action: "Specific action like schedule_reminder, answer_question, get_weather.",
    args: "JSON arguments for the action, e.g., {location: 'London', time: 'tomorrow'}.",
    text_response: "The natural language response ARC-AI should say to the user."
});


// --- ASYNC FUNCTION: The entire core logic is safely placed inside here ---
const processCommand = async (command, userId) => {
    
    // 1. FINAL CHECK for API Key
    if (!API_KEY) {
        console.error("🔴 MISTRAL_API_KEY is MISSING! Cannot process command.");
        return { intent: 'ERROR', action: 'config_error', text_response: "System key configuration failure (Backend).", args: {} };
    }
    
    try {
        // 2. Get Contextual Memory and Build Prompt
        // The await is now safe because we are inside the async function block.
        const memoryDoc = await AIMemory.findOne({ userId }); 
        const history = memoryDoc.conversationHistory.slice(-5); // Last 5 messages for context
        const contextString = history.map(m => `${m.role}: ${m.content}`).join('\n');
        
        const systemPrompt = `You are ARC-AI, a professional, futuristic AI assistant. Analyze the user command and context. Respond ONLY with a single JSON object matching this schema: ${structuredIntentInstruction}. Always include a 'text_response' field. Context: ${contextString}`;

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: command }
        ];

       // 2. Make API Request using Axios (Pure HTTP)
const response = await axios.post(MISTRAL_ENDPOINT, {
    model: MODEL,
    messages: messages,
    temperature: 0.2,
    response_format: { type: "json_object" } 
}, {
    // --- ADD A TIMEOUT (e.g., 8 seconds) ---
    timeout: 8000, 
    // ---------------------------------------
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}` 
    }
});

        // 4. Parse the Structured JSON Response
        const jsonString = response.data.choices[0].message.content.trim();
        const aiResponse = JSON.parse(jsonString);
        
        // 5. Save to History 
        // We save the original command first
        memoryDoc.conversationHistory.push({ role: 'user', content: command });
        // Then we save the AI's response text for future context
        memoryDoc.conversationHistory.push({ role: 'assistant', content: aiResponse.text_response }); 
        await memoryDoc.save();

        // 6. Return the structured response for task execution
        return aiResponse;

    } catch (error) {
        // Log the full error for debugging, but send a graceful response to the user
        console.error('AI API Request or JSON Parsing Failed:', error.response?.data || error.message);
        return {
          intent: 'ERROR',
          action: 'api_failure',
          text_response: `I'm encountering a critical system error. The AI brain is currently offline. Please check the network or your API key.`,
          args: { error: error.message }
        };
    }
};

module.exports = { processCommand };