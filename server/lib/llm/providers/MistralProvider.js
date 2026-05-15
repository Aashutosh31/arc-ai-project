const { Mistral } = require('@mistralai/mistralai');
const {
  extractResponseText,
  inferTaskProfile,
  normalizeMistralToolCalls
} = require('../utils');

class MistralProvider {
  constructor() {
    this.id = 'mistral';
    this.name = 'Mistral';
    this.priority = 80;
    this.aliases = ['mistral-ai'];
    this.defaultModel = process.env.MISTRAL_MODEL || 'mistral-small-latest';
    this.lightweightModel = process.env.MISTRAL_LIGHT_MODEL || this.defaultModel;
    this.visionModel = process.env.MISTRAL_VISION_MODEL || 'pixtral-12b-2409';
    this.capabilities = {
      multimodal: false,
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
    return Boolean(process.env.MISTRAL_API_KEY);
  }

  getClient() {
    if (!this.isAvailable()) {
      throw new Error('Mistral API key is not configured.');
    }

    if (!this.client) {
      this.client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
    }

    return this.client;
  }

  resolveModel(request = {}) {
    const profile = inferTaskProfile(request);
    if (profile === 'multimodal') return this.visionModel;
    if (profile === 'lightweight' || profile === 'memory_compression') return this.lightweightModel;
    return this.defaultModel;
  }

  buildMessages(request = {}) {
    const messages = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    for (const message of request.messages || []) {
      const role = message?.role || 'user';

      if (role === 'tool') {
        const toolCallId = message?.toolCallId || message?.tool_call_id;
        messages.push({
          role: 'tool',
          name: message?.name,
          toolCallId,
          tool_call_id: toolCallId,
          content: String(message?.content || '')
        });
        continue;
      }

      if (role === 'assistant' && Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: String(message?.content || ''),
          toolCalls: message.toolCalls,
          tool_calls: message.toolCalls
        });
        continue;
      }

      messages.push({ role, content: String(message?.content || '') });
    }

    return messages;
  }

  async generate(request = {}) {
    if (!this.canHandleRequest(request)) {
      const error = new Error('MistralProvider does not support image attachments in the current adapter.');
      error.statusCode = 400;
      throw error;
    }

    const client = this.getClient();
    const startedAt = Date.now();
    const model = request.model || this.resolveModel(request);
    const messages = this.buildMessages(request);
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;

    if (request.stream) {
      const streamResponse = await client.chat.stream(
        {
          model,
          messages,
          tools: hasTools ? request.tools : undefined,
          toolChoice: hasTools ? 'auto' : undefined
        },
        { signal: request.signal }
      );

      async function* normalizedStream() {
        for await (const chunk of streamResponse) {
          const text = String(chunk?.data?.choices?.[0]?.delta?.content || '');
          if (!text) continue;
          yield {
            text,
            raw: chunk,
            provider: 'mistral',
            model
          };
        }
      }

      return {
        provider: 'mistral',
        model,
        stream: normalizedStream(),
        latencyMs: Date.now() - startedAt,
        usage: null
      };
    }

    const response = await client.chat.complete(
      {
        model,
        messages,
        tools: hasTools ? request.tools : undefined,
        toolChoice: hasTools ? 'auto' : undefined
      },
      { signal: request.signal }
    );

    const message = response?.choices?.[0]?.message || {};

    return {
      provider: 'mistral',
      model,
      text: extractResponseText(message),
      toolCalls: normalizeMistralToolCalls(message),
      raw: response,
      latencyMs: Date.now() - startedAt,
      usage: response?.usage || null
    };
  }
}

module.exports = new MistralProvider();