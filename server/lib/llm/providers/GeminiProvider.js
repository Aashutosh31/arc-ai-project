const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');
const {
  extractResponseText,
  inferTaskProfile,
  normalizeGeminiToolCalls,
  toGeminiContents,
  toGeminiTools
} = require('../utils');

class GeminiProvider {
  constructor() {
    this.id = 'gemini';
    this.name = 'Gemini';
    this.priority = 100;
    this.aliases = ['google', 'google-gemini'];
    this.defaultModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.reasoningModel = process.env.GEMINI_REASONING_MODEL || this.defaultModel;
    this.visionModel = process.env.GEMINI_VISION_MODEL || this.defaultModel;
    this.capabilities = {
      multimodal: true,
      tools: true,
      streaming: true
    };
    this.client = null;
  }

  canHandleRequest(request = {}) {
    const hasImageAttachment = Array.isArray(request.attachments) && request.attachments.some((attachment) => attachment?.type === 'image');
    return !hasImageAttachment || this.capabilities.multimodal;
  }

  isAvailable() {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  getClient() {
    if (!this.isAvailable()) {
      throw new Error('Gemini API key is not configured.');
    }

    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    return this.client;
  }

  resolveModel(request = {}) {
    const profile = inferTaskProfile(request);
    if (profile === 'multimodal') return this.visionModel;
    if (profile === 'long_context' || profile === 'reasoning' || profile === 'tool_orchestration') {
      return this.reasoningModel;
    }
    return this.defaultModel;
  }

  buildConfig(request = {}) {
    const config = {
      systemInstruction: request.systemPrompt || undefined,
      temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
      maxOutputTokens: typeof request.maxTokens === 'number' ? request.maxTokens : undefined,
      abortSignal: request.signal || undefined
    };

    const toolDeclarations = toGeminiTools(request.tools || []);
    if (toolDeclarations.length > 0) {
      config.tools = toolDeclarations;
      config.toolConfig = {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.AUTO
        }
      };
    }

    return config;
  }

  async generate(request = {}) {
    if (!this.canHandleRequest(request)) {
      const error = new Error('GeminiProvider cannot handle this multimodal request.');
      error.statusCode = 400;
      throw error;
    }

    const client = this.getClient();
    const startedAt = Date.now();
    const model = request.model || this.resolveModel(request);
    const contents = toGeminiContents(request.messages || [], request.attachments || []);
    const config = this.buildConfig(request);

    if (request.stream) {
      const streamResponse = await client.models.generateContentStream({
        model,
        contents,
        config
      });

      async function* normalizedStream() {
        for await (const chunk of streamResponse) {
          const text = String(chunk?.text || '').trim();
          if (!text) continue;
          yield {
            text,
            raw: chunk,
            provider: 'gemini',
            model
          };
        }
      }

      return {
        provider: 'gemini',
        model,
        stream: normalizedStream(),
        latencyMs: Date.now() - startedAt,
        usage: null
      };
    }

    const response = await client.models.generateContent({
      model,
      contents,
      config
    });

    return {
      provider: 'gemini',
      model,
      text: extractResponseText(response),
      toolCalls: normalizeGeminiToolCalls(response),
      raw: response,
      latencyMs: Date.now() - startedAt,
      usage: response?.usageMetadata || response?.usage_metadata || null
    };
  }
}

module.exports = new GeminiProvider();