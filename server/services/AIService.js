// server/services/AIService.js — FINAL STABLE VERSION

const axios = require("axios");
const AIMemory = require("../models/AIMemory");

const API_KEY = process.env.MISTRAL_API_KEY;
const MODEL = process.env.MISTRAL_MODEL;
const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";

const processCommand = async (command, userId) => {
  try {
    const memoryDoc = await AIMemory.findOne({ userId });
    const history = memoryDoc.conversationHistory.slice(-6);

    const context = history
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    // 🔒 SYSTEM PROMPT — SIMPLE, VOICE-FIRST, LIKE ME
    const systemPrompt = `
You are ARC-AI, a calm, intelligent, voice-first assistant.

RULES:
- Be concise.
- Do NOT dump long explanations.
- Assume the user is listening.
- Explain only the core idea.
- Give 1–2 examples max.
- End by asking what to explain next.
- Never mention JSON, schemas, or formatting issues.
- Never say "task identified".

If the user greets or chats → respond naturally.
If the user asks a technical question → explain briefly and clearly.
If the user wants more → expand only that part.

Creator: King Aashutosh.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: `Conversation so far:\n${context}` },
      { role: "user", content: command }
    ];

    const response = await axios.post(
      ENDPOINT,
      {
        model: MODEL,
        messages,
        temperature: 0.3
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    const text = response.data.choices[0].message.content.trim();

    // Save memory
    memoryDoc.conversationHistory.push({ role: "user", content: command });
    memoryDoc.conversationHistory.push({ role: "assistant", content: text });
    await memoryDoc.save();

    return {
      intent: "CONVERSATION",
      action: "reply",
      args: {},
      text_response: text
    };

  } catch (err) {
    console.error("🔴 AI ERROR:", err.message);

    return {
      intent: "ERROR",
      action: "fallback",
      args: {},
      text_response:
        "Something went wrong on my side. Can you try asking that again?"
    };
  }
};

module.exports = { processCommand };