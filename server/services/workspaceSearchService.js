const { Pinecone } = require('@pinecone-database/pinecone');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const { getEmbedding, normalizeText, cacheKeyFor } = require('./embeddingService');

let pineconeClient = null;
let pineconeIndex = null;
let warnedMissingPineconeKey = false;

// Lazily create the Pinecone client on first semantic-search use so the server
// can boot when PINECONE_API_KEY is unconfigured. Semantic search degrades to
// keyword-only results; nothing is sent anywhere when the key is missing.
const getPineconeIndex = () => {
    if (pineconeIndex) return pineconeIndex;
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
        if (!warnedMissingPineconeKey) {
            warnedMissingPineconeKey = true;
            console.warn('[WorkspaceSearch] PINECONE_API_KEY is not defined. Semantic vector search is disabled; keyword search remains available.');
        }
        return null;
    }
    pineconeClient = pineconeClient || new Pinecone({ apiKey });
    pineconeIndex = pineconeIndex || pineconeClient.index(process.env.PINECONE_INDEX || 'arc-brain');
    return pineconeIndex;
};

const getNamespace = (userId, workspaceId) => (workspaceId ? `workspace_${String(workspaceId)}` : `user_${String(userId)}`);

const stopWords = new Set(['the', 'and', 'for', 'with', 'what', 'did', 'about', 'that', 'this', 'from', 'been', 'have', 'does', 'doesn', 'didn', 'what', 'when', 'where', 'how', 'why']);

const tokenize = (query) => normalizeText(query)
  .toLowerCase()
  .split(/[^a-z0-9]+/g)
  .map((word) => word.trim())
  .filter((word) => word.length > 2 && !stopWords.has(word));

const buildSearchRegex = (query) => {
  const words = tokenize(query);
  if (words.length === 0) return null;
  return new RegExp(words.slice(0, 8).join('|'), 'i');
};

const scoreRecency = (date) => {
  const value = new Date(date).getTime();
  if (Number.isNaN(value)) return 0;
  const ageDays = Math.max(0, (Date.now() - value) / 86400000);
  return 1 / (1 + ageDays / 14);
};

const toSnippet = (text, query) => {
  const content = normalizeText(text);
  if (!content) return '';

  const lowerContent = content.toLowerCase();
  const lowerQuery = normalizeText(query).toLowerCase();
  const hitIndex = lowerContent.indexOf(lowerQuery);
  if (hitIndex >= 0) {
    const start = Math.max(0, hitIndex - 70);
    const end = Math.min(content.length, hitIndex + lowerQuery.length + 120);
    return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
  }

  return content.slice(0, 180) + (content.length > 180 ? '…' : '');
};

const searchConversations = async (userId, query, limit = 5, workspaceId = null) => {
  const textRegex = buildSearchRegex(query);
  const results = [];
  const conversationQuery = { userId: String(userId), archived: false };
  if (workspaceId) conversationQuery.workspaceId = String(workspaceId);

  if (textRegex) {
    conversationQuery.$or = [{ title: textRegex }, { 'lastMessage.content': textRegex }];
  }

  const conversations = await Conversation.find(conversationQuery)
    .sort({ pinned: -1, updatedAt: -1 })
    .limit(limit)
    .lean();

  for (const conversation of conversations) {
    const title = conversation.title || 'New Conversation';
    const content = conversation.lastMessage?.content || '';
    const combined = `${title} ${content}`;
    const keywordHit = tokenize(query).some((word) => combined.toLowerCase().includes(word));

    results.push({
      type: 'conversation',
      source: 'keyword',
      id: String(conversation._id),
      conversationId: String(conversation._id),
      title,
      snippet: toSnippet(content || title, query),
      timestamp: conversation.updatedAt || conversation.createdAt,
      score: (keywordHit ? 0.9 : 0.5) + scoreRecency(conversation.updatedAt || conversation.createdAt)
    });
  }

  return results;
};

const searchMessages = async (userId, query, limit = 10, workspaceId = null) => {
  const regex = buildSearchRegex(query);
  if (!regex) return [];

  const convQuery = { userId: String(userId), archived: false };
  if (workspaceId) convQuery.workspaceId = String(workspaceId);
  const conversations = await Conversation.find(convQuery).select('_id').lean();
  const conversationIds = conversations.map((conversation) => conversation._id);
  if (conversationIds.length === 0) return [];

  const messages = await Message.find({
    conversationId: { $in: conversationIds },
    content: regex
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return messages.map((message) => ({
    type: 'message',
    source: 'keyword',
    id: String(message._id),
    messageId: String(message._id),
    conversationId: String(message.conversationId),
    snippet: toSnippet(message.content, query),
    timestamp: message.createdAt,
    score: 0.8 + scoreRecency(message.createdAt),
    text: message.content
  }));
};

const searchStructuredMemory = async (userId, query, limit = 8, workspaceId = null) => {
  const regex = buildSearchRegex(query);
  const [facts, memories] = await Promise.all([
    UserFact.find({ userId: String(userId), ...(regex ? { fact: regex } : {}), ...(workspaceId ? { workspaceId: String(workspaceId) } : {}) }).sort({ pinned: -1, createdAt: -1 }).limit(limit).lean(),
    AIMemory.find({ userId: String(userId), ...(regex ? { $or: [{ query: regex }, { response: regex }, { tags: regex }] } : {}), ...(workspaceId ? { workspaceId: String(workspaceId) } : {}) })
      .sort({ pinned: -1, timestamp: -1 })
      .limit(limit)
      .lean()
  ]);

  const factResults = facts.map((fact) => ({
    type: 'userFact',
    source: 'keyword',
    id: String(fact._id),
    memoryId: String(fact._id),
    snippet: fact.fact,
    category: fact.category || 'general',
    pinned: Boolean(fact.pinned),
    timestamp: fact.createdAt,
    score: 0.85 + scoreRecency(fact.createdAt)
  }));

  const memoryResults = memories.map((memory) => ({
    type: 'semanticMemory',
    source: 'keyword',
    id: String(memory._id),
    memoryId: String(memory._id),
    snippet: memory.query || memory.response,
    response: memory.response,
    tags: memory.tags || [],
    pinned: Boolean(memory.pinned),
    timestamp: memory.timestamp,
    score: 0.75 + scoreRecency(memory.timestamp)
  }));

  return [...factResults, ...memoryResults];
};

const searchSemanticVectors = async (userId, query, signal = null, limit = 8, workspaceId = null) => {
  const vector = await getEmbedding(query, { signal });
  if (!vector) return [];
  const targetIndex = getPineconeIndex();
  if (!targetIndex) return [];
  const namespace = getNamespace(userId, workspaceId);
  const response = await targetIndex.query({
    namespace,
    vector,
    topK: limit,
    includeMetadata: true
  });

  const matches = response?.matches || [];
  return matches.map((match) => ({
    type: match.metadata?.kind === 'message' ? 'message' : match.metadata?.kind === 'conversation' ? 'conversation' : match.metadata?.kind === 'userFact' ? 'userFact' : 'semanticMemory',
    source: 'semantic',
    id: String(match.id),
    conversationId: match.metadata?.conversationId || null,
    messageId: match.metadata?.messageId || null,
    memoryId: match.metadata?.memoryId || null,
    title: match.metadata?.title || null,
    snippet: match.metadata?.text || '',
    timestamp: match.metadata?.timestamp || null,
    score: Number(match.score || 0),
    metadata: match.metadata || {}
  }));
};

const dedupeAndRank = (items) => {
  const byKey = new Map();

  for (const item of items) {
    const key = item.messageId || item.memoryId || item.conversationId || item.id || cacheKeyFor(item.snippet || JSON.stringify(item));
    const current = byKey.get(key);
    if (!current || (item.score || 0) > (current.score || 0)) {
      byKey.set(key, item);
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 20);
};

const buildRetrievalContext = (items, query) => {
  const grouped = {
    conversations: [],
    messages: [],
    memories: []
  };

  for (const item of items) {
    const entry = {
      ...item,
      snippet: toSnippet(item.snippet || item.text || item.response || '', query)
    };
    if (item.type === 'conversation') grouped.conversations.push(entry);
    else if (item.type === 'message') grouped.messages.push(entry);
    else grouped.memories.push(entry);
  }

  return grouped;
};

const searchWorkspace = async ({ userId, query, signal = null, limit = 10, workspaceId = null }) => {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return { query: normalizedQuery, items: [], grouped: buildRetrievalContext([], normalizedQuery), stats: { total: 0 } };
  }

  const [conversationResults, messageResults, memoryResults, semanticResults] = await Promise.all([
    searchConversations(userId, normalizedQuery, Math.min(limit, 5), workspaceId),
    searchMessages(userId, normalizedQuery, Math.min(limit, 8), workspaceId),
    searchStructuredMemory(userId, normalizedQuery, Math.min(limit, 8), workspaceId),
    searchSemanticVectors(userId, normalizedQuery, signal, Math.min(limit, 8), workspaceId).catch((error) => {
      console.warn('[WorkspaceSearch] semantic search failed:', error?.message || error);
      return [];
    })
  ]);

  const items = dedupeAndRank([
    ...conversationResults,
    ...messageResults,
    ...memoryResults,
    ...semanticResults
  ]);

  return {
    query: normalizedQuery,
    items,
    grouped: buildRetrievalContext(items, normalizedQuery),
    stats: {
      total: items.length,
      conversations: items.filter((item) => item.type === 'conversation').length,
      messages: items.filter((item) => item.type === 'message').length,
      memories: items.filter((item) => item.type !== 'conversation' && item.type !== 'message').length
    }
  };
};

const buildMemoryContext = async ({ userId, query, signal = null, limit = 12, workspaceId = null }) => {
  const results = await searchWorkspace({ userId, query, signal, limit, workspaceId });
  return results.items
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      type: item.type,
      source: item.source,
      snippet: item.snippet || item.text || item.response || '',
      conversationId: item.conversationId || null,
      messageId: item.messageId || null,
      memoryId: item.memoryId || null,
      score: item.score || 0,
      timestamp: item.timestamp || null
    }));
};

module.exports = {
  searchWorkspace,
  buildMemoryContext,
  getNamespace
};
