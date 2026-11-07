const AIMemory = require('../models/AIMemory');
const UserFact = require('../models/UserFact');
const User = require('../models/User');
const { getActor, isGuestActor } = require('../lib/actor');
const { upsertTextVector, removeVectorsByEntity } = require('../services/workspaceIndexService');
const { normalizeLayer, inferLayerFromText, clamp01 } = require('../lib/memoryLayers');

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
  workspaceId: memory.workspaceId ? String(memory.workspaceId) : null,
  type: 'semanticMemory',
  query: memory.query,
  response: memory.response,
  summary: memory.summary || '',
  tags: memory.tags || [],
  layer: memory.layer || 'episodic',
  importance: Number.isFinite(Number(memory.importance)) ? Number(memory.importance) : 0.5,
  confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.7,
  pinned: Boolean(memory.pinned),
  source: memory.source || 'conversation',
  conversationId: memory.conversationId ? String(memory.conversationId) : null,
  timestamp: memory.timestamp,
  createdAt: memory.createdAt || memory.timestamp,
  updatedAt: memory.updatedAt || memory.timestamp
});

const toFactResponse = (fact) => ({
  _id: String(fact._id),
  userId: String(fact.userId),
  workspaceId: fact.workspaceId ? String(fact.workspaceId) : null,
  type: 'userFact',
  fact: fact.fact,
  category: fact.category || 'general',
  layer: fact.layer || 'semantic',
  source: fact.source || 'explicit',
  confidence: Number.isFinite(Number(fact.confidence)) ? Number(fact.confidence) : 0.9,
  importance: Number.isFinite(Number(fact.importance)) ? Number(fact.importance) : 0.6,
  pinned: Boolean(fact.pinned),
  conversationId: fact.conversationId ? String(fact.conversationId) : null,
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

    // Strict workspace boundary: a missing/blank workspace means the global
    // workspace (workspaceId null), never "all workspaces".
    const scopedWorkspaceId = workspaceId || null;
    const factQuery = { userId, workspaceId: scopedWorkspaceId };
    const memoryQuery = { userId, workspaceId: scopedWorkspaceId };

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

// Explicit fact creation (web + mobile parity). The tool path stores facts
// implicitly; this route lets a user add one from the memory dashboard.
exports.createFact = async (req, res) => {
  try {
    const userId = getUserId(req);
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const rawFact = typeof req.body?.fact === 'string' ? req.body.fact.trim() : '';
    if (!rawFact) return res.status(400).json({ error: 'Fact text is required' });
    if (rawFact.length > 2000) return res.status(400).json({ error: 'Fact text is too long' });

    const category = typeof req.body?.category === 'string'
      ? (req.body.category.trim().slice(0, 40) || 'general')
      : 'general';
    const layer = req.body?.layer
      ? normalizeLayer(req.body.layer, 'semantic')
      : inferLayerFromText(`${rawFact} ${category}`, 'semantic');
    const source = typeof req.body?.source === 'string' ? req.body.source.slice(0, 40) : 'explicit';

    const fact = await UserFact.create({
      userId,
      workspaceId: workspaceId || null,
      fact: rawFact,
      category,
      pinned: Boolean(req.body?.pinned),
      layer,
      source,
      confidence: clamp01(req.body?.confidence, 0.95),
      importance: clamp01(req.body?.importance, 0.7),
      conversationId: null
    });

    try {
      await upsertTextVector({
        userId,
        workspaceId: workspaceId || null,
        kind: 'userFact',
        entityId: fact._id,
        text: fact.fact,
        metadata: {
          category: fact.category,
          source: fact.source,
          layer: fact.layer,
          confidence: fact.confidence,
          memoryId: String(fact._id)
        }
      });
    } catch (indexError) {
      console.warn('[Memory] fact vector index failed:', indexError?.message || indexError);
    }

    return res.status(201).json(toFactResponse(fact));
  } catch (error) {
    console.error('[Memory] create fact failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to create memory fact' });
  }
};

exports.updateFact = async (req, res) => {
  try {
    const userId = getUserId(req);
    const workspaceId = req.query?.workspaceId || req.body?.workspaceId || null;
    const { memoryId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    if (rejectGuestMutation(req, res)) return;

    const factQuery = { _id: memoryId, userId, workspaceId: workspaceId || null };

    const fact = await UserFact.findOne(factQuery);
    if (!fact) return res.status(404).json({ error: 'Memory not found' });

    const previous = {
      fact: fact.fact,
      category: fact.category,
      layer: fact.layer,
      source: fact.source
    };

    const { fact: factText, category, pinned, layer, confidence, importance, source } = req.body || {};
    if (typeof factText === 'string') {
      const next = factText.trim();
      if (!next) return res.status(400).json({ error: 'Fact text is required' });
      fact.fact = next.slice(0, 2000);
    }
    if (typeof category === 'string') fact.category = category.trim().slice(0, 40) || 'general';
    if (typeof pinned === 'boolean') fact.pinned = pinned;
    if (typeof layer === 'string') fact.layer = normalizeLayer(layer, fact.layer || 'semantic');
    if (typeof source === 'string') fact.source = source.slice(0, 40);
    if (typeof confidence !== 'undefined') fact.confidence = clamp01(confidence, fact.confidence);
    if (typeof importance !== 'undefined') fact.importance = clamp01(importance, fact.importance);
    fact.updatedAt = new Date();

    await fact.save();

    const textChanged = typeof factText === 'string' && fact.fact !== previous.fact;
    const metadataChanged = fact.category !== previous.category
      || fact.layer !== previous.layer
      || fact.source !== previous.source;
    if (textChanged || metadataChanged) {
      try {
        await removeVectorsByEntity({
          userId,
          kind: 'userFact',
          entityId: fact._id,
          workspaceId: fact.workspaceId || null
        });
        await upsertTextVector({
          userId,
          workspaceId: fact.workspaceId || null,
          kind: 'userFact',
          entityId: fact._id,
          text: fact.fact,
          metadata: {
            category: fact.category,
            source: fact.source,
            layer: fact.layer,
            confidence: fact.confidence,
            memoryId: String(fact._id)
          }
        });
      } catch (indexError) {
        console.warn('[Memory] fact re-index failed:', indexError?.message || indexError);
      }
    }

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

    const factQuery = { _id: memoryId, userId, workspaceId: workspaceId || null };

    const deleted = await UserFact.findOneAndDelete(factQuery);
    if (deleted) {
      try {
        await removeVectorsByEntity({
          userId,
          kind: 'userFact',
          entityId: deleted._id,
          workspaceId: deleted.workspaceId || null
        });
      } catch (indexError) {
        console.warn('[Memory] fact vector cleanup failed:', indexError?.message || indexError);
      }
    }
    return res.json({ success: true, deletedCount: deleted ? 1 : 0 });
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

    const memoryQuery = { _id: memoryId, userId, workspaceId: workspaceId || null };

    const memory = await AIMemory.findOne(memoryQuery);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });

    const previous = {
      query: memory.query,
      response: memory.response,
      summary: memory.summary,
      tags: (memory.tags || []).join('|'),
      layer: memory.layer,
      source: memory.source
    };

    const { query, response, tags, pinned, layer, importance, confidence, summary, source } = req.body || {};
    if (typeof query === 'string') memory.query = query.trim();
    if (typeof response === 'string') memory.response = response.trim();
    if (typeof summary === 'string') memory.summary = summary.trim().slice(0, 400);
    if (Array.isArray(tags)) memory.tags = tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12);
    if (typeof pinned === 'boolean') memory.pinned = pinned;
    if (typeof layer === 'string') memory.layer = normalizeLayer(layer, memory.layer || 'episodic');
    if (typeof source === 'string') memory.source = source.slice(0, 40);
    if (typeof importance !== 'undefined') memory.importance = clamp01(importance, memory.importance);
    if (typeof confidence !== 'undefined') memory.confidence = clamp01(confidence, memory.confidence);
    memory.updatedAt = new Date();

    await memory.save();

    const contentChanged = memory.query !== previous.query
      || memory.response !== previous.response
      || (memory.summary || '') !== (previous.summary || '')
      || (memory.tags || []).join('|') !== previous.tags
      || memory.layer !== previous.layer
      || memory.source !== previous.source;
    if (contentChanged) {
      try {
        await removeVectorsByEntity({
          userId,
          kind: 'semanticMemory',
          entityId: memory._id,
          workspaceId: memory.workspaceId || null
        });
        const text = `${memory.query || ''}\n${memory.response || ''}`.trim();
        await upsertTextVector({
          userId,
          workspaceId: memory.workspaceId || null,
          kind: 'semanticMemory',
          entityId: memory._id,
          text,
          metadata: {
            tags: memory.tags || [],
            layer: memory.layer,
            source: memory.source,
            memoryId: String(memory._id)
          }
        });
      } catch (indexError) {
        console.warn('[Memory] semantic re-index failed:', indexError?.message || indexError);
      }
    }

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

    const memoryQuery = { _id: memoryId, userId, workspaceId: workspaceId || null };

    const deleted = await AIMemory.findOneAndDelete(memoryQuery);
    if (deleted) {
      try {
        await removeVectorsByEntity({
          userId,
          kind: 'semanticMemory',
          entityId: deleted._id,
          workspaceId: deleted.workspaceId || null
        });
      } catch (indexError) {
        console.warn('[Memory] semantic vector cleanup failed:', indexError?.message || indexError);
      }
    }
    return res.json({ success: true, deletedCount: deleted ? 1 : 0 });
  } catch (error) {
    console.error('[Memory] delete semantic memory failed:', error?.stack || error);
    return res.status(500).json({ error: 'Failed to delete semantic memory' });
  }
};
