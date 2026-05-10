const { createPartFromBase64, createPartFromText } = require('@google/genai');

const safeString = (value) => {
  if (value === null || value === undefined) return '';
  return String(value);
};

const extractTextFromContent = (content) => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractTextFromContent).join('');

  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (typeof content.message === 'string') return content.message;
    if (Array.isArray(content.parts)) {
      return content.parts.map(extractTextFromContent).join('');
    }
  }

  return safeString(content);
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
        parts.push(createPartFromText(`[TOOL_RESULT] ${JSON.stringify(toolPayload)}`));
        return { role: 'user', parts };
      }

      if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        parts.push(createPartFromText(`[ASSISTANT_TOOL_CALLS] ${JSON.stringify(message.toolCalls)}`));
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
            parts.push(createPartFromText(String(attachment.data)));
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
  if (/(reason|reasoning|plan|planning|code|coding|debug|architecture|research|analy[sz]e|tool orchestration|agent|multi-agent|long context|vision|multimodal)/i.test(combinedText)) {
    return 'reasoning';
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

  const isTransient =
    isRateLimit ||
    status >= 500 ||
    message.includes('unavailable') ||
    message.includes('timeout') ||
    message.includes('network');

  return { isRateLimit, isTransient, status, message };
};

module.exports = {
  classifyProviderFailure,
  extractResponseText,
  extractTextFromContent,
  inferTaskProfile,
  normalizeGeminiToolCalls,
  normalizeMessages,
  normalizeMistralToolCalls,
  toGeminiContents,
  toGeminiTools
};