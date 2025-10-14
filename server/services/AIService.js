// server/services/AIService.js
const { GoogleGenAI } = require('@google/genai');
const AIMemory = require('../models/AIMemory');

// Initialize Gemini (uses GOOGLE_API_KEY from .env)
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;


if (GOOGLE_API_KEY) {
    // Force the environment variable used by the SDK to be set in the current process.
    // This is the variable the SDK relies on when initialized with no arguments.
    process.env.GEMINI_API_KEY = GOOGLE_API_KEY; 
    console.log('✅ GEMINI_API_KEY forced into environment scope.');
} else {
    console.error("🔴 API Key is missing. The next step will fail.");
    // It's still good practice to check, but the issue is usually the lookup, not the existence.
}
// 2. Initialize Gemini client. 
// We use the empty constructor, which should now correctly find the key 
// because we set process.env.GEMINI_API_KEY just above.
const ai = new GoogleGenAI({}); 

// NOTE: If this fails, the only other option is to install the deprecated 
// 'google-auth-library' and manually disable ADC, but this direct manipulation 
// of process.env is the modern fix.

// Define the structure for task execution (CRITICAL for "Jarvis")
const structuredIntentSchema = {
  type: "object",
  properties: {
    intent: { 
      type: "string", 
      description: "A category like CONVERSATION, TASK_EXECUTION, DATA_QUERY."
    },
    action: { 
      type: "string", 
      description: "Specific action like get_weather, schedule_reminder, answer_question." 
    },
    args: { 
      type: "object", 
      description: "JSON arguments for the action, e.g., {location: 'London', time: 'tomorrow'}."
    },
    text_response: {
      type: "string",
      description: "The natural language response ARC-AI should say to the user."
    }
  },
  required: ["intent", "action", "text_response"]
};

const processCommand = async (command, userId) => {
  try {
    // 1. Get Contextual Memory
    const memoryDoc = await AIMemory.findOne({ userId });
    const history = memoryDoc.conversationHistory.slice(-5); // Use last 5 messages for context
    const contextString = history.map(m => `${m.role}: ${m.content}`).join('\n');

    // 2. Build the System Prompt
    const systemPrompt = `You are ARC-AI, a sophisticated, highly helpful AI assistant for the user. Your personality is professional and slightly futuristic. Analyze the user's command and previous context. If a task or action is implied (like a reminder, message, or data query), use the 'TASK_EXECUTION' intent. Always respond with the structured JSON object, and always include a natural language reply in the 'text_response' field. Context: ${contextString}`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash', // Use the fast, free tier model
        contents: [
            { role: 'user', parts: [{ text: systemPrompt + '\n\nUser Command: ' + command }] }
        ],
        config: {
            responseMimeType: "application/json", // CRITICAL for structured output
            responseSchema: structuredIntentSchema,
            temperature: 0.2, // Keep it precise
        },
    });

    // The response text should be the structured JSON string
    const jsonResponse = JSON.parse(response.text);

    // 3. Save to History (User command)
    memoryDoc.conversationHistory.push({ role: 'user', content: command });
    await memoryDoc.save();

    return jsonResponse;
  } catch (error) {
    console.error('Gemini API Error or JSON Parsing Failed:', error);
    return {
      intent: 'ERROR',
      action: 'error_response',
      text_response: "I apologize, an error occurred while processing your request. Please try again.",
      args: { error: error.message }
    };
  }
};

module.exports = { processCommand };