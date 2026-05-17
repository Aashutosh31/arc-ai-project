// server/services/WorkspaceContextManager.js
const { searchWorkspace, buildMemoryContext } = require('./workspaceSearchService');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const UserFact = require('../models/UserFact');

/**
 * WorkspaceContextManager
 * Lightweight orchestration layer that decides what context to surface
 * for the current workspace request. It delegates heavy work to the
 * existing workspaceSearchService and then applies small, deterministic
 * heuristics (temporal weighting, prioritization, simple project inference).
 *
 * Goals:
 * - non-LLM, provider-agnostic
 * - memory-efficient and fast
 * - no duplicated writes
 */
class WorkspaceContextManager {
  async inferActiveProject(userId, conversationId = null) {
    try {
      if (conversationId) {
        const conv = await Conversation.findById(conversationId).select('title').lean();
        if (conv && conv.title && conv.title !== 'New Conversation') return conv.title;
      }

      // fallback: look for pinned user facts that look like project names
      const fact = await UserFact.findOne({ userId }).sort({ pinned: -1, createdAt: -1 }).lean();
      if (fact && fact.fact && fact.fact.length < 60) return fact.fact.split('\n')[0];
    } catch (err) {
      // non-fatal
    }
    return null;
  }

  async getShortTermContext(userId, conversationId, limit = 6) {
    if (!conversationId) return [];
    try {
      const messages = await Message.find({ conversationId }).sort({ createdAt: -1 }).limit(limit).lean();
      return messages.map((m, i) => ({
        type: 'message',
        snippet: String(m.content || '').slice(0, 120),
        messageId: String(m._id),
        conversationId: String(m.conversationId),
        timestamp: m.createdAt,
        score: 1 - i * 0.05 // slight decay within short-term buffer
      }));
    } catch (err) {
      return [];
    }
  }

  async getActiveContext({ userId, conversationId = null, query = '', limit = 12, signal = null }) {
    // Gather retrievals from semantic + structured searches
    const retrievalsPromise = buildMemoryContext({ userId, query, signal, limit });
    const shortPromise = this.getShortTermContext(userId, conversationId, 6);

    const [retrievals, shortTerm] = await Promise.all([retrievalsPromise, shortPromise]);

    // Merge with simple temporal weighting: newer items get a slight boost
    const now = Date.now();
    const weighted = retrievals.map((item) => {
      const ageMs = item.timestamp ? Math.max(0, now - new Date(item.timestamp).getTime()) : 0;
      const ageDays = ageMs / 86400000;
      const temporalFactor = 1 / (1 + ageDays / 7); // 1..0.125 approx
      return { ...item, score: (item.score || 0) * (0.7 + 0.3 * temporalFactor) };
    });

    // Short-term items should be highly relevant
    const shortWeighted = shortTerm.map((s) => ({ ...s, score: (s.score || 0) + 0.25 }));

    const combined = [...shortWeighted, ...weighted]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit);

    return {
      query: String(query || ''),
      items: combined,
      shortTerm: shortWeighted,
      longTerm: weighted
    };
  }
}

module.exports = new WorkspaceContextManager();
