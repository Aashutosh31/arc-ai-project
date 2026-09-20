const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');
const {
  extractResponseText,
  inferTaskProfile,
  normalizeGeminiToolCalls,
  toGeminiContents,
  toGeminiTools,
  toWellFormedUnicode
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
    // System prompt is provider-bound: normalize to well-formed Unicode so a
    // lone surrogate (e.g. from a truncated snippet) cannot invalidate the
    // whole request body.
    const systemInstruction = request.systemPrompt ? toWellFormedUnicode(String(request.systemPrompt)) : undefined;
    const config = {
      systemInstruction,
      temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
      maxOutputTokens: typeof request.maxTokens === 'number' ? request.maxTokens : undefined,
      abortSignal: request.signal || undefined
    };

    const toolDeclarations = toGeminiTools(request.tools || []);
    if (toolDeclarations.length > 0) {
      config.tools = toolDeclarations;
      // Deterministic recovery forcing (MCP action enforcement): one
      // unambiguous required tool → constrain the model to it. Standard
      // Gemini function-calling config; unknown names stay AUTO so forcing
      // can never produce a new tool-mismatch rejection.
      let forced = '';
      try {
        forced = typeof request.forcedTool === 'string' ? request.forcedTool : '';
        const offered = new Set((request.tools || []).map((t) => t?.function?.name).filter(Boolean));
        if (!offered.has(forced)) forced = '';
      } catch { forced = ''; }
      config.toolConfig = forced
        ? {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [forced]
          }
        }
        : {
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
          const text = String(chunk?.text || '');
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

  // Transcribe a short voice clip for browsers without native SpeechRecognition.
  // Reuses the configured Gemini API key; throws when unconfigured or when the
  // provider rejects the request. Never logs audio content or API keys.
  // `vocabulary` (optional, bounded) biases the recognizer toward the
  // application's domain terms; the deterministic normalizer still runs
  // server-side on the result.
  async transcribeAudio({ audioBase64, mimeType, vocabulary = null, responseModalities = ['TEXT'], inputAudioTranscription = { languageCodes: [] } } = {}) {
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      const error = new Error('Audio data is required for transcription.');
      error.statusCode = 400;
      throw error;
    }

    const client = this.getClient();
    const startedAt = Date.now();
    const terms = Array.isArray(vocabulary)
      ? vocabulary
        .map((t) => String(t || '').trim())
        .filter((t) => t.length >= 2 && t.length <= 40 && !/[\n\r]/.test(t))
        .slice(0, 60)
      : [];
    const vocabularyHint = terms.length
      ? `Transcribe the speech in this audio clip verbatim. Return only the transcription text with no commentary. If there is no speech, return an empty string. The speaker may use these domain terms, spelled exactly as shown when they occur: ${terms.join(', ')}.`
      : 'Transcribe the speech in this audio clip verbatim. Return only the transcription text with no commentary. If there is no speech, return an empty string.';
    const transcriptionConfig = {};
    if (inputAudioTranscription && inputAudioTranscription.languageCodes) {
      transcriptionConfig.inputAudioTranscription = { languageCodes: inputAudioTranscription.languageCodes };
    }
    const prompt = terms.length
      ? `Transcribe the speech in this audio clip verbatim. Return only the transcription text with no commentary. If there is no speech, return an empty string. The speaker may use these domain terms, spelled exactly as shown when they occur: ${terms.join(', ')}.`
      : 'Transcribe the speech in this audio clip verbatim. Return only the transcription text with no commentary. If there is no speech, return an empty string.';
    const response = await client.models.generateContent({
      model: this.defaultModel,
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType || 'audio/webm', data: audioBase64 } }
          ]
        }
      ],
      config: {
        responseModalities: Array.isArray(responseModalities) ? responseModalities : ['TEXT'],
        ...transcriptionConfig
      }
    });

    return {
      provider: 'gemini',
      model: this.defaultModel,
      text: String(extractResponseText(response) || '').trim(),
      latencyMs: Date.now() - startedAt
    };
  }
}

module.exports = new GeminiProvider();