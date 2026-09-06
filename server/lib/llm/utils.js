const { createPartFromBase64, createPartFromText } = require('@google/genai');

const safeString = (value) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

// Replace lone surrogates (unpaired \uD800-\uDFFF) with U+FFFD so the result
// is well-formed Unicode. Providers (Mistral, Gemini) strictly validate JSON
// bodies as UTF-8: a single lone surrogate — e.g. from slicing an emoji in
// half when truncating snippets, or pasted/scraped text — makes the whole
// request fail with HTTP 400 ("Invalid JSON payload"). Stored data is never
// touched; this applies only to provider-bound strings.
const toWellFormedUnicode = (value) => {
  const str = String(value ?? '');
  if (typeof str.toWellFormed === 'function') return str.toWellFormed();
  return str.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
    '\uFFFD'
  );
};

const extractTextFromContent = (content) => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractTextFromContent).filter(Boolean).join(' ');

  if (typeof content === 'object') {
    if (typeof content.text === 'string') return toWellFormedUnicode(content.text);
    if (typeof content.content === 'string') return toWellFormedUnicode(content.content);
    if (typeof content.message === 'string') return toWellFormedUnicode(content.message);
    if (Array.isArray(content.parts)) {
      return content.parts.map(extractTextFromContent).filter(Boolean).join(' ');
    }
    // Unknown object shape (e.g. an SDK response envelope with no text):
    // return empty rather than "[object Object]", which previously leaked
    // into user-visible titles and messages.
    return '';
  }

  return toWellFormedUnicode(safeString(content));
};

const normalizeMessages = (messages = []) => {
  return messages.map((message) => ({
    ...message,
    role: message?.role || 'user',
    content: extractTextFromContent(message?.content)
  }));
};

const getLastUserMessageIndex = (messages = []) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index]?.role || '').toLowerCase() === 'user') return index;
  }
  return -1;
};

const toGeminiContents = (messages = [], attachments = []) => {
  const normalizedMessages = normalizeMessages(messages);
  const lastUserIndex = getLastUserMessageIndex(normalizedMessages);

  return normalizedMessages
    .filter((message) => message.role !== 'system')
    .map((message, index) => {
      const role = message.role === 'assistant' ? 'model' : 'user';
      const parts = [];
      const text = extractTextFromContent(message.content).trim();

      if (message.role === 'tool') {
        const toolPayload = {
          toolCallId: message.toolCallId || message.tool_call_id || null,
          toolName: message.name || null,
          role: 'tool',
          output: text
        };
        parts.push(createPartFromText(`[TOOL_RESULT] ${toWellFormedUnicode(JSON.stringify(toolPayload))}`));
        return { role: 'user', parts };
      }

      if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        parts.push(createPartFromText(`[ASSISTANT_TOOL_CALLS] ${toWellFormedUnicode(JSON.stringify(message.toolCalls))}`));
      }

      if (text) {
        parts.push(createPartFromText(text));
      }

      if (role === 'user' && index === lastUserIndex && Array.isArray(attachments)) {
        for (const attachment of attachments) {
          if (!attachment) continue;

          if (attachment.type === 'image' && attachment.data) {
            parts.push(createPartFromBase64(attachment.data, attachment.mimeType || 'image/jpeg'));
          } else if (attachment.type === 'text' && attachment.data) {
            parts.push(createPartFromText(toWellFormedUnicode(String(attachment.data))));
          }
        }
      }

      return { role, parts };
    })
    .filter((message) => Array.isArray(message.parts) && message.parts.length > 0);
};

const toGeminiTools = (tools = []) => {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const functionDeclarations = tools
    .map((tool) => tool?.function || tool?.schema?.function || tool)
    .filter((definition) => definition && definition.name)
    .map((definition) => ({
      name: definition.name,
      description: definition.description || '',
      parametersJsonSchema: definition.parametersJsonSchema || definition.parameters || { type: 'object', properties: {} }
    }));

  if (functionDeclarations.length === 0) return [];

  return [{ functionDeclarations }];
};

const normalizeGeminiToolCalls = (response) => {
  const functionCalls = response?.functionCalls || [];
  return functionCalls.map((functionCall, index) => ({
    id: functionCall?.id || `gemini-tool-call-${index}`,
    function: {
      name: functionCall?.name,
      arguments: functionCall?.args || functionCall?.arguments || {}
    }
  }));
};

const normalizeMistralToolCalls = (message) => {
  const toolCalls = message?.toolCalls || message?.tool_calls || [];
  return toolCalls.map((toolCall, index) => ({
    id: toolCall?.id || `mistral-tool-call-${index}`,
    function: {
      name: toolCall?.function?.name,
      arguments: toolCall?.function?.arguments || {}
    }
  }));
};

const isAssistantToolCallMessage = (message) => {
  return (message?.role || '').toLowerCase() === 'assistant' && Array.isArray(message?.toolCalls) && message.toolCalls.length > 0;
};

const buildProviderContinuationMessages = ({
  messages = [],
  assistantMessage = null,
  toolResults = [],
  provider = 'mistral'
} = {}) => {
  const sourceAssistantMessage = assistantMessage || [...messages].reverse().find(isAssistantToolCallMessage) || null;
  const sourceToolCalls = Array.isArray(sourceAssistantMessage?.toolCalls)
    ? sourceAssistantMessage.toolCalls
    : Array.isArray(sourceAssistantMessage?.tool_calls)
      ? sourceAssistantMessage.tool_calls
      : [];

  const assistantToolCalls = [];
  const assistantToolCallIds = new Set();

  for (const toolCall of sourceToolCalls) {
    const toolCallId = toolCall?.id || toolCall?.toolCallId || toolCall?.tool_call_id;
    if (!toolCallId) {
      throw new Error('buildProviderContinuationMessages: assistant tool call is missing an id.');
    }
    if (assistantToolCallIds.has(toolCallId)) {
      throw new Error(`buildProviderContinuationMessages: duplicate assistant tool_call_id detected: ${toolCallId}`);
    }
    assistantToolCallIds.add(toolCallId);
    assistantToolCalls.push({
      id: toolCallId,
      function: {
        name: toolCall?.function?.name || toolCall?.name,
        arguments: toolCall?.function?.arguments || toolCall?.arguments || {}
      }
    });
  }

  const toolResultsById = new Map();
  for (const result of toolResults || []) {
    const toolCallId = result?.toolCallId || result?.tool_call_id;
    if (!toolCallId) {
      throw new Error('buildProviderContinuationMessages: tool result missing tool_call_id.');
    }
    if (!assistantToolCallIds.has(toolCallId)) {
      throw new Error(`buildProviderContinuationMessages: orphan tool result detected for tool_call_id ${toolCallId}`);
    }
    if (toolResultsById.has(toolCallId)) {
      throw new Error(`buildProviderContinuationMessages: duplicate tool result detected for tool_call_id ${toolCallId}`);
    }

    toolResultsById.set(toolCallId, {
      role: 'tool',
      name: result?.name || result?.toolName || result?.tool || null,
      toolCallId,
      tool_call_id: toolCallId,
      content: typeof result?.content === 'string'
        ? result.content
        : JSON.stringify(result?.content ?? result?.result ?? result?.data ?? result?.output ?? {})
    });
  }

  for (const toolCallId of assistantToolCallIds) {
    if (!toolResultsById.has(toolCallId)) {
      throw new Error(`buildProviderContinuationMessages: missing tool result for tool_call_id ${toolCallId}`);
    }
  }

  const baseMessages = [];
  let seenAssistantToolCallSegment = false;

  for (const message of messages || []) {
    if (isAssistantToolCallMessage(message)) {
      seenAssistantToolCallSegment = true;
      continue;
    }

    if ((message?.role || '').toLowerCase() === 'tool') {
      continue;
    }

    baseMessages.push({
      ...message,
      role: message?.role || 'user',
      content: extractTextFromContent(message?.content)
    });
  }

  if (!seenAssistantToolCallSegment && assistantToolCalls.length > 0) {
    // The caller is reconstructing a fresh continuation chain.
  }

  const continuation = [
    ...baseMessages,
    {
      role: 'assistant',
      content: extractTextFromContent(sourceAssistantMessage?.content || ''),
      toolCalls: assistantToolCalls
    },
    ...Array.from(toolResultsById.values())
  ];

  return continuation;
};

const extractResponseText = (response) => {
  if (!response) return '';
  if (typeof response.text === 'string') return response.text;
  if (typeof response.content === 'string') return response.content;
  if (typeof response.output === 'string') return response.output;
  return extractTextFromContent(response);
};

const inferTaskProfile = ({ messages = [], tools = [], attachments = [], userContext = {} } = {}) => {
  const taskMode = safeString(userContext.taskMode).toLowerCase();
  if (taskMode === 'multimodal') return 'multimodal';
  if (taskMode === 'memory_compression') return 'memory_compression';
  if (taskMode === 'lightweight') return 'lightweight';

  const combinedText = [...messages.map((message) => extractTextFromContent(message?.content)), safeString(userContext.taskHint)]
    .join(' ')
    .toLowerCase();

  const hasImageAttachment = Array.isArray(attachments) && attachments.some((attachment) => attachment?.type === 'image');
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const textLength = combinedText.length;

  if (hasImageAttachment) return 'multimodal';
  if (/(summari[sz]e|compress|title generation|title|headline|shorten|brief)/i.test(combinedText)) return 'lightweight';
  if (/(memory compression|condense memory|memory summary)/i.test(combinedText)) return 'memory_compression';
  // Only classify as 'reasoning' for truly complex tasks (debugging, architecture, complex analysis)
  if (/(debug|architecture|design pattern|algorithm|refactor|optimize|security|vulnerability|complex analy[sz]e|research paper|formal proof|mathematical proof)/i.test(combinedText)) {
    return 'reasoning';
  }
  // If has plan, code, or agent keywords but simpler context, still use lightweight
  if (/(reason|plan|code|agent)/i.test(combinedText) && textLength < 2000 && messages.length < 8) {
    return 'lightweight';
  }
  if (textLength > 6000 || messages.length > 12) return 'long_context';
  if (hasTools) return 'tool_orchestration';
  return 'lightweight';
};

const classifyProviderFailure = (error) => {
  const message = safeString(error?.message || error).toLowerCase();
  const status = Number(error?.statusCode || error?.status || error?.code || 0);

  const isRateLimit =
    status === 429 ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('capacity exceeded') ||
    message.includes('resource_exhausted') ||
    message.includes('too many requests');

  // Treat API key errors (400) as transient to trigger provider fallback
  const isApiKeyError = status === 400 && message.includes('api key');

  // Provider-side model/config rejections (e.g. Mistral "invalid_model"):
  // the request itself may be fine, so a healthy backup provider deserves a
  // chance. Never treated as transient-retries against the SAME provider —
  // only as cross-provider failover. Matched narrowly to avoid masking
  // genuinely malformed requests.
  const isModelError =
    (status === 400 || status === 404) &&
    /(invalid_model|model_not_found|unknown model|does not exist|unsupported model|model .*not (available|found|supported))/.test(message);

  const isTransient =
    isRateLimit ||
    isApiKeyError ||
    status >= 500 ||
    message.includes('unavailable') ||
    message.includes('timeout') ||
    message.includes('network');

  return { isRateLimit, isTransient, status, message, isApiKeyError, isModelError };
};

// Normalize provider SDK errors to a common shape WITHOUT touching secrets.
// Different SDKs report HTTP status differently (@google/genai uses `.status`,
// mistralai uses `.statusCode`). After this, `error.statusCode` is reliable
// for classification, and `error.providerCode` carries the short machine tag
// (e.g. API_KEY_INVALID, invalid_model) when one is detectable.
const normalizeProviderError = (error, providerId = null) => {
  if (!error || typeof error !== 'object') return error;

  if (error.statusCode == null) {
    const status = Number(error.status ?? error.code ?? 0);
    if (Number.isFinite(status) && status >= 100 && status < 600) {
      error.statusCode = status;
    }
  }

  if (providerId && error.providerId == null) error.providerId = providerId;

  if (error.providerCode == null) {
    const message = safeString(error.message);
    if (/api key not valid|invalid api key/i.test(message)) {
      error.providerCode = 'API_KEY_INVALID';
    } else {
      const match = message.match(/(API_KEY_INVALID|invalid_model|INVALID_ARGUMENT|SAFETY|RESOURCE_EXHAUSTED|model_not_found)/i);
      if (match) error.providerCode = match[1];
    }
  }

  return error;
};

// Safe one-line diagnostic for server logs: provider, model, HTTP status,
// machine-readable code, truncated message, request-shape metadata and
// key-configured booleans. NEVER includes keys, tokens, audio, or full text.
const describeProviderFailure = (error, context = {}) => {
  const failure = classifyProviderFailure(error);
  return {
    provider: context.providerId || error?.providerId || null,
    model: context.model || null,
    operation: context.operation || 'generate',
    status: failure.status || null,
    providerCode: error?.providerCode || null,
    message: failure.message.slice(0, 300),
    keyConfigured: context.keyConfigured ?? null,
    tools: context.tools ?? null,
    hasAttachments: context.hasAttachments ?? null,
    stream: context.stream ?? null,
    failover: context.failover ?? null
  };
};

module.exports = {
  classifyProviderFailure,
  normalizeProviderError,
  describeProviderFailure,
  toWellFormedUnicode,
  extractResponseText,
  extractTextFromContent,
  inferTaskProfile,
  normalizeGeminiToolCalls,
  normalizeMessages,
  normalizeMistralToolCalls,
  buildProviderContinuationMessages,
  toGeminiContents,
  toGeminiTools
};