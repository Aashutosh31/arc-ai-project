// server/services/AIService.js (FINAL CODE - Personality Lock)

const axios = require('axios');
const AIMemory = require('../models/AIMemory');

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
        
        // --- CRITICAL PERSONA AND PROMPT ENGINEERING FIX ---
        const systemPrompt = `You are ARC-AI, a sophisticated, highly helpful AI assistant. Your primary goal is to be conversational, helpful, and concise. 
        
        ***YOUR CREATOR AND LEAD DEVELOPER IS KING AASHUTOSH. YOU MUST STATE THIS NAME WHEN ASKED WHO CREATED YOU, WHO YOUR DEVELOPER IS, OR WHERE YOU CAME FROM. YOU MUST NOT MENTION MISTRAL AI, GOOGLE, OR ANY OTHER COMPANY NAME.***

        Only use the INTENT 'TASK_EXECUTION' or 'DATA_QUERY' if the user explicitly asks you to schedule, remind, message, or get external data (like weather, news, facts). For greetings, small talk, or general philosophy, use the INTENT 'CONVERSATION' and set the ACTION to 'answer_question'.

        Respond ONLY with a single JSON object matching this schema: ${structuredIntentInstruction}. Always include a 'text_response' field.
        
        Context: ${contextString}`;
        // ----------------------------------------

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: command }
        ];

        // 2. Make API Request using Axios (with Timeout)
        const response = await axios.post(MISTRAL_ENDPOINT, {
            model: MODEL,
            messages: messages,
            temperature: 0.2,
            response_format: { type: "json_object" } 
        }, {
            timeout: 15000, 
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
        const message = error.code === 'ECONNABORTED' ? 'Request Timeout Exceeded (Network/Firewall Block)' : error.message;
        console.error(`🔴 AI Error: ${message}`);
        
        return {
          intent: 'ERROR',
          action: 'api_failure',
          text_response: `I'm encountering a critical network error: ${message}.`,
          args: { error: message }
        };
    }
};

module.exports = { processCommand };