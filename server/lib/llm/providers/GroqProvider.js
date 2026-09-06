const OpenAI = require('openai');
const {
  extractResponseText,
  normalizeGroqToolCalls,
  toWellFormedUnicode
} = require('../utils');

class GroqProvider {
  constructor() {
    this.id = 'groq';
    this.name = 'Groq';
    this.priority = 90;
    this.aliases = ['groq-ai', 'groqcloud'];
    this.defaultModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
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
    return Boolean(process.env.GROQ_API_KEY);
  }

  getClient() {
    if (!this.isAvailable()) {
      throw new Error('Groq API key is not configured.');
    }

    if (!this.client) {
      this.client = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1'
      });
    }

    return this.client;
  }

  resolveModel() {
    return this.defaultModel;
  }

  buildMessages(request = {}) {
    const messages = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: toWellFormedUnicode(String(request.systemPrompt)) });
    }

    for (const message of request.messages || []) {
      const role = message?.role || 'user';

      if (role === 'tool') {
        const toolCallId = message?.toolCallId || message?.tool_call_id;
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: toWellFormedUnicode(String(message?.content || ''))
        });
        continue;
      }

      if (role === 'assistant' && Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) {
        const toolCalls = message.toolCalls.map((tc) => ({
          id: tc?.id,
          type: 'function',
          function: {
            name: tc?.function?.name,
            arguments: typeof tc?.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc?.function?.arguments || {})
          }
        }));
        messages.push({
          role: 'assistant',
          content: toWellFormedUnicode(String(message?.content || '')) || null,
          tool_calls: toolCalls
        });
        continue;
      }

      messages.push({ role, content: toWellFormedUnicode(String(message?.content || '')) });
    }

    return messages;
  }

  buildTools(request = {}) {
    const rawTools = request.tools || [];
    if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;

    const normalized = [];
    for (const tool of rawTools) {
      const fn = tool?.function || tool?.schema?.function || tool;
      if (!fn || !fn.name || typeof fn.name !== 'string') continue;

      const name = fn.name;
      if (name.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(name)) continue;

      const description = typeof fn.description === 'string'
        ? toWellFormedUnicode(fn.description).slice(0, 1024)
        : '';

      const rawParams = fn.parameters || fn.parametersJsonSchema || { type: 'object', properties: {} };
      const parameters = this.sanitizeSchema(rawParams);

      normalized.push({
        type: 'function',
        function: { name, description, parameters }
      });
    }

    return normalized.length > 0 ? normalized : undefined;
  }

  sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {} };
    }

    const sanitized = { type: schema.type || 'object' };

    if (schema.description) {
      sanitized.description = toWellFormedUnicode(String(schema.description));
    }

    if (schema.properties && typeof schema.properties === 'object') {
      sanitized.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        sanitized.properties[key] = this.sanitizeProperty(value);
      }
    }

    if (Array.isArray(schema.required)) {
      sanitized.required = schema.required.filter((r) => typeof r === 'string');
    }

    if (Array.isArray(schema.enum)) {
      sanitized.enum = schema.enum;
    }

    if (schema.default !== undefined) {
      sanitized.default = schema.default;
    }

    if (schema.minimum !== undefined) sanitized.minimum = schema.minimum;
    if (schema.maximum !== undefined) sanitized.maximum = schema.maximum;

    return sanitized;
  }

  sanitizeProperty(prop) {
    if (!prop || typeof prop !== 'object') return { type: 'string' };

    const sanitized = { type: prop.type || 'string' };

    if (prop.description) {
      sanitized.description = toWellFormedUnicode(String(prop.description));
    }

    if (prop.enum) sanitized.enum = prop.enum;
    if (prop.default !== undefined) sanitized.default = prop.default;

    if (prop.type === 'object' && prop.properties) {
      sanitized.properties = {};
      for (const [key, value] of Object.entries(prop.properties)) {
        sanitized.properties[key] = this.sanitizeProperty(value);
      }
      if (Array.isArray(prop.required)) {
        sanitized.required = prop.required.filter((r) => typeof r === 'string');
      }
    }

    if (prop.type === 'array' && prop.items) {
      sanitized.items = this.sanitizeProperty(prop.items);
    }

    if (prop.minimum !== undefined) sanitized.minimum = prop.minimum;
    if (prop.maximum !== undefined) sanitized.maximum = prop.maximum;

    return sanitized;
  }

  buildRequestParams(request = {}) {
    const model = request.model || this.resolveModel(request);
    const messages = this.buildMessages(request);
    const tools = this.buildTools(request);
    const hasTools = Array.isArray(tools) && tools.length > 0;

    const params = {
      model,
      messages,
      stream: Boolean(request.stream)
    };

    if (hasTools) {
      params.tools = tools;
      params.tool_choice = 'auto';
    }

    if (typeof request.temperature === 'number') {
      params.temperature = Math.max(0, Math.min(2, request.temperature));
    }

    if (typeof request.maxTokens === 'number') {
      params.max_tokens = request.maxTokens;
    }

    if (typeof request.topP === 'number') {
      params.top_p = request.topP;
    }

    return params;
  }

  buildRequestOptions(request = {}) {
    const options = {};
    if (request.signal) {
      options.signal = request.signal;
    }
    return options;
  }

  async generate(request = {}) {
    if (!this.canHandleRequest(request)) {
      const error = new Error('Groq provider does not support image attachments.');
      error.statusCode = 400;
      throw error;
    }

    const client = this.getClient();
    const startedAt = Date.now();
    const params = this.buildRequestParams(request);

    if (request.stream) {
      const streamResponse = await client.chat.completions.create(params, this.buildRequestOptions(request));

      async function* normalizedStream() {
        const toolCallBuffers = new Map();
        let currentToolCallId = null;

        for await (const chunk of streamResponse) {
          const delta = chunk?.choices?.[0]?.delta;
          if (!delta) continue;

          const text = String(delta?.content || '');
          if (text) {
            yield { text, raw: chunk, provider: 'groq', model: params.model };
          }

          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (tc?.id) {
                currentToolCallId = tc.id;
                if (!toolCallBuffers.has(tc.id)) {
                  toolCallBuffers.set(tc.id, {
                    id: tc.id,
                    function: { name: '', arguments: '' }
                  });
                }
              }
              if (tc?.function?.name) {
                const buf = toolCallBuffers.get(currentToolCallId);
                if (buf) buf.function.name += tc.function.name;
              }
              if (tc?.function?.arguments) {
                const buf = toolCallBuffers.get(currentToolCallId);
                if (buf) buf.function.arguments += tc.function.arguments;
              }
            }
          }
        }

        if (toolCallBuffers.size > 0) {
          const assembledToolCalls = Array.from(toolCallBuffers.values()).map((buf) => ({
            id: buf.id,
            function: {
              name: buf.function.name,
              arguments: (() => { try { return JSON.parse(buf.function.arguments || '{}'); } catch { return {}; } })()
            }
          }));
          yield { toolCalls: assembledToolCalls, raw: null, provider: 'groq', model: params.model };
        }
      }

      return {
        provider: 'groq',
        model: params.model,
        stream: normalizedStream(),
        latencyMs: Date.now() - startedAt,
        usage: null
      };
    }

    const response = await client.chat.completions.create(params, this.buildRequestOptions(request));
    const choice = response?.choices?.[0];
    const message = choice?.message || {};

    return {
      provider: 'groq',
      model: params.model,
      text: extractResponseText(message),
      toolCalls: normalizeGroqToolCalls(message),
      raw: response,
      latencyMs: Date.now() - startedAt,
      usage: response?.usage || null
    };
  }
}

module.exports = new GroqProvider();
