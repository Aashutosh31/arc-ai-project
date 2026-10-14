// Tokenizer service using tiktoken for accurate token counting.
// Falls back to chars/4 heuristic if tiktoken is unavailable.

let encoding = null;
let encodingError = null;

// Initialize tiktoken encoding for GPT-4/3.5 (cl100k_base) which works for Groq/Gemini too
function initTokenizer() {
    if (encoding || encodingError) return;
    try {
        const tiktoken = require('tiktoken');
        encoding = tiktoken.getEncoding('cl100k_base');
    } catch (err) {
        encodingError = err;
        console.warn('[Tokenizer] tiktoken not available, falling back to chars/4 heuristic:', err.message);
    }
}

// Estimate tokens using tiktoken if available, otherwise chars/4
function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    initTokenizer();
    if (encoding) {
        try {
            return encoding.encode(text).length;
        } catch (err) {
            console.warn('[Tokenizer] encode failed, falling back:', err.message);
        }
    }
    // Fallback: chars/4 heuristic (conservative)
    return Math.max(0, Math.ceil(text.length / 4));
}

// Estimate tokens for messages array
function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const m of messages) {
        // Each message has overhead (~4 tokens for role + formatting)
        total += 4 + estimateTokens(String(m?.content || ''));
    }
    return total;
}

// Estimate tokens for tool schemas
function estimateToolsTokens(schemas) {
    try {
        return estimateTokens(JSON.stringify(schemas || []));
    } catch {
        return 0;
    }
}

// Estimate tokens for any object by JSON stringifying
function estimateObjectTokens(obj) {
    try {
        return estimateTokens(JSON.stringify(obj));
    } catch {
        return 0;
    }
}

module.exports = {
    estimateTokens,
    estimateMessagesTokens,
    estimateToolsTokens,
    estimateObjectTokens,
    initTokenizer
};