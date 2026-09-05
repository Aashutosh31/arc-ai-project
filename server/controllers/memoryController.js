const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const User = require('../models/User');
const { getActor, isGuestActor } = require('../lib/actor');

const getUserId = (req) => getActor(req)?.id || null;

// Guests persist no memory records (AIMemory/UserFact reference real users
// only). The dashboard returns empty collections instead of hitting ObjectId
// casts; mutations are rejected instead of 500ing on those casts.
const rejectGuestMutation = (req, res) => {
  const actor = getActor(req);
  if (actor && isGuestActor(actor)) {
    res.status(403).json({ error: 'Memory management requires a signed-in account.', code: 'GUEST_NOT_ALLOWED' });
    return true;
  }
  return false;
};

const emptyDashboard = () => ({
  preferences: {
    memoryLearningEnabled: true,
    voice: 'professional',
    accentColor: '#00FFFF'
  },
  facts: [],
  memories: []
});

const toMemoryResponse = (memory) => ({
  _id: String(memory._id),
  userId: String(memory.userId),
  type: 'semanticMemory',
  query: memory.query,
  response: memory.response,
  tags: memory.tags || [],
  pinned: Boolean(memory.pinned),
  source: memory.source || 'conversation',
  timestamp: memory.timestamp,
  createdAt: memory.createdAt || memory.timestamp,
  updatedAt: memory.updatedAt || memory.timestamp
});

const toFactResponse = (fact) => ({
  _id: String(fact._id),
  userId: String(fact.userId),
  type: 'userFact',
  fact: fact.fact,
  category: fact.category || 'general',
  pinned: Boolean(fact.pinned),
  createdAt: fact.createdAt,
  updatedAt: fact.updatedAt || fact.createdAt
});

exports.getMemoryDashboard = async (req, res) => {
  try {
    const actor = getActor(req);
    const userId = actor?.id || null;
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (actor && isGuestActor(actor)) return res.json(emptyDashboard());

    const factQuery = { userId };
    const memoryQuery = { userId };
    if (workspaceId) {
      factQuery.workspaceId = workspaceId;
      memoryQuery.workspaceId = workspaceId;
    }

    const [facts, memories, user] = await Promise.all([
      UserFact.find(factQuery).sort({ pinned: -1, createdAt: -1 }).lean(),
      AIMemory.find(memoryQuery).sort({ pinned: -1, timestamp: -1 }).limit(100).lean(),
      User.findById(userId).select('preferences.memoryLearningEnabled preferences.voice preferences.accentColor').lean()
    ]);

    return res.json({
      preferences: {
        memoryLearningEnabled: user?.preferences?.memoryLearningEnabled !== false,
        voice: user?.preferences?.voice || 'professional',
        accentColor: user?.preferences?.accentColor || '#00FFFF'
      },
      facts: facts.map(toFactResponse),
      memories: memories.map(toMemoryResponse)
    });
  } catch (error) {
    console.error('[Memory] dashboard load failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to load memory dashboard' });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const { memoryLearningEnabled } = req.body || {};
    if (typeof memoryLearningEnabled !== 'boolean') {
      return res.status(400).json({ error: 'memoryLearningEnabled must be boolean' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.preferences = {
      ...(user.preferences || {}),
      memoryLearningEnabled
    };
    await user.save();

    return res.json({ success: true, preferences: { memoryLearningEnabled } });
  } catch (error) {
    console.error('[Memory] update preferences failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to update preferences' });
  }
};

exports.updateFact = async (req, res) => {
  try {
    const userId = getUserId(req);
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    const { memoryId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const factQuery = { _id: memoryId, userId };
    if (workspaceId) factQuery.workspaceId = workspaceId;

    const fact = await UserFact.findOne(factQuery);
    if (!fact) return res.status(404).json({ error: 'Memory not found' });

    const { fact: factText, category, pinned } = req.body || {};
    if (typeof factText === 'string') fact.fact = factText.trim();
    if (typeof category === 'string') fact.category = category.trim().slice(0, 40) || 'general';
    if (typeof pinned === 'boolean') fact.pinned = pinned;

    await fact.save();
    return res.json(toFactResponse(fact));
  } catch (error) {
    console.error('[Memory] update fact failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to update memory fact' });
  }
};

exports.deleteFact = async (req, res) => {
  try {
    const userId = getUserId(req);
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    const { memoryId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const factQuery = { _id: memoryId, userId };
    if (workspaceId) factQuery.workspaceId = workspaceId;

    const result = await UserFact.deleteOne(factQuery);
    return res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    console.error('[Memory] delete fact failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to delete memory fact' });
  }
};

exports.updateSemanticMemory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    const { memoryId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const memoryQuery = { _id: memoryId, userId };
    if (workspaceId) memoryQuery.workspaceId = workspaceId;

    const memory = await AIMemory.findOne(memoryQuery);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });

    const { query, response, tags, pinned } = req.body || {};
    if (typeof query === 'string') memory.query = query.trim();
    if (typeof response === 'string') memory.response = response.trim();
    if (Array.isArray(tags)) memory.tags = tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12);
    if (typeof pinned === 'boolean') memory.pinned = pinned;

    await memory.save();
    return res.json(toMemoryResponse(memory));
  } catch (error) {
    console.error('[Memory] update semantic memory failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to update semantic memory' });
  }
};

exports.deleteSemanticMemory = async (req, res) => {
  try {
    const userId = getUserId(req);
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    const { memoryId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const memoryQuery = { _id: memoryId, userId };
    if (workspaceId) memoryQuery.workspaceId = workspaceId;

    const result = await AIMemory.deleteOne(memoryQuery);
    return res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    console.error('[Memory] delete semantic memory failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to delete semantic memory' });
  }
};
