// server/services/AIService.js (CLEANED FINAL CODE)

const axios = require('axios');
const AIMemory = require('../models/AIMemory');
// Removed: const https = require('https'); 

// --- Module-level constants ---
const API_KEY = process.env.MISTRAL_API_KEY; 
const MODEL = process.env.MISTRAL_MODEL || 'mistral-tiny'; 
const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions'; 

// Define the structure for task execution (CRITICAL for "Jarvis")
const structuredIntentInstruction = JSON.stringify({
    intent: "A category like CONVERSATION, TASK_EXECUTION, DATA_QUERY.",
    action: "Specific action like schedule_reminder, answer_question, get_weather.",
    args: "JSON arguments for the action, e.g., {location: 'London', time: 'tomorrow'}.",
    text_response: "The natural language response ARC-AI should say to the user."
});


// --- ASYNC FUNCTION: Core Logic ---
const processCommand = async (command, userId) => {
    
    if (!API_KEY) {
        console.error("🔴 MISTRAL_API_KEY is MISSING! Cannot process command.");
        return { intent: 'ERROR', action: 'config_error', text_response: "System key configuration failure (Backend).", args: {} };
    }
    
    try {
        // 1. Get Contextual Memory
        const memoryDoc = await AIMemory.findOne({ userId }); 
        const history = memoryDoc.conversationHistory.slice(-5);
        const contextString = history.map(m => `${m.role}: ${m.content}`).join('\n');
        
        const systemPrompt = `You are ARC-AI, a professional, futuristic AI assistant. Analyze the user command and context. Respond ONLY with a single JSON object matching this schema: ${structuredIntentInstruction}. Always include a 'text_response' field. Context: ${contextString}`;

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: command }
        ];

        // 2. Make API Request using Axios (Simplified Config)
        const response = await axios.post(MISTRAL_ENDPOINT, {
            model: MODEL,
            messages: messages,
            temperature: 0.2,
            response_format: { type: "json_object" } 
        }, {
            // --- CRITICAL AXIOS CONFIGURATION ---
            timeout: 15000, 
            // Removed: httpsAgent is no longer needed
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}` 
            }
        });

        // 3. Parse Response and Save History 
        const jsonString = response.data.choices[0].message.content.trim();
        const aiResponse = JSON.parse(jsonString);
        
        memoryDoc.conversationHistory.push({ role: 'user', content: command });
        memoryDoc.conversationHistory.push({ role: 'assistant', content: aiResponse.text_response }); 
        await memoryDoc.save();

        return aiResponse;

    } catch (error) {
        // Log the full error message for debugging
        const message = error.code === 'ECONNABORTED' ? 'Request Timeout Exceeded (Network/Firewall Block)' : error.message;
        console.error(`🔴 AI Error: ${message}`);
        
        return {
          intent: 'ERROR',
          action: 'api_failure',
          text_response: `The AI brain encountered a critical network error: ${message}.`,
          args: { error: message }
        };
    }
};

module.exports = { processCommand };