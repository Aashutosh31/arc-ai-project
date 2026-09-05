const express = require('express');
const router = express.Router();
const Workspace = require('../models/Workspace');
const WorkspaceRuntimeManager = require('../services/WorkspaceRuntimeManager');
const mongoose = require('mongoose');
const { protect } = require('../middleware/authMiddleware');
const { getActor, isGuestActor } = require('../lib/actor');

const workspaceRuntime = new WorkspaceRuntimeManager({ logger: console });

router.use(protect);

// Guest sessions are ephemeral and cannot own workspaces (Workspace.owner is
// an ObjectId ref to User). Short-circuit instead of letting string sessionIds
// hit ObjectId casts (500s) or mint orphan workspaces.
router.use((req, res, next) => {
  if (!isGuestActor(getActor(req))) return next();
  if (req.method === 'GET' && req.path === '/') return res.json({ workspaces: [] });
  if (req.method === 'GET' && req.path === '/active') return res.json({ workspace: null });
  return res.status(403).json({ error: 'Guest sessions cannot manage workspaces. Sign in to use workspaces.' });
});

// Get current user's workspaces
router.get('/', async (req, res) => {
  try {
    const userId = getActor(req)?.id || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const workspaces = await Workspace.find({
      owner: userId,
      $or: [{ 'metadata.archived': { $exists: false } }, { 'metadata.archived': { $ne: true } }]
    })
      .select('_id name description visibility activeProject vectorNamespace createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ workspaces });
  } catch (err) {
    console.error('[Workspace] list failed:', err);
    res.status(500).json({ error: 'Failed to fetch workspaces' });
  }
});

// Get active workspace (resolved based on context or default)
router.get('/active', async (req, res) => {
  try {
    const userId = getActor(req)?.id || null;
    const workspaceId = req.query?.workspaceId || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ws = await workspaceRuntime.resolveWorkspace({ userId, workspaceId });
    if (!ws) return res.status(404).json({ error: 'Workspace not found or could not be created' });

    res.json({
      workspace: {
        _id: ws._id,
        name: ws.name,
        description: ws.description,
        vectorNamespace: ws.vectorNamespace,
        settings: ws.settings,
        metadata: ws.metadata
      }
    });
  } catch (err) {
    console.error('[Workspace] active resolution failed:', err);
    res.status(500).json({ error: 'Failed to resolve active workspace' });
  }
});

// Get specific workspace
router.get('/:workspaceId', async (req, res) => {
  try {
    const userId = getActor(req)?.id || null;
    const { workspaceId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }

    const ws = await Workspace.findOne({
      _id: workspaceId,
      owner: userId,
      $or: [{ 'metadata.archived': { $exists: false } }, { 'metadata.archived': { $ne: true } }]
    }).lean();
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    res.json({ workspace: ws });
  } catch (err) {
    console.error('[Workspace] get failed:', err);
    res.status(500).json({ error: 'Failed to fetch workspace' });
  }
});

// Create new workspace
router.post('/', async (req, res) => {
  try {
    const userId = getActor(req)?.id || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { name, description, visibility = 'private' } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Workspace name is required' });
    }

    const ws = new Workspace({
      name: name.trim(),
      description: description ? String(description).trim() : '',
      owner: userId,
      visibility
    });

    // Generate deterministic vector namespace
    await ws.save();
    ws.vectorNamespace = `workspace_${ws._id}`;
    await ws.save();

    console.info('[Workspace] created:', ws._id.toString(), 'namespace:', ws.vectorNamespace);

    res.status(201).json({
      workspace: {
        _id: ws._id,
        name: ws.name,
        description: ws.description,
        visibility: ws.visibility,
        vectorNamespace: ws.vectorNamespace,
        createdAt: ws.createdAt
      }
    });
  } catch (err) {
    console.error('[Workspace] create failed:', err);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// Update workspace
router.put('/:workspaceId', async (req, res) => {
  try {
    const userId = getActor(req)?.id || null;
    const { workspaceId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }

    const ws = await Workspace.findOne({ _id: workspaceId, owner: userId });
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    const { name, description, visibility, settings } = req.body;
    if (name && typeof name === 'string') ws.name = name.trim();
    if (description !== undefined) ws.description = String(description || '').trim();
    if (visibility && ['private', 'org', 'public'].includes(visibility)) ws.visibility = visibility;
    if (settings && typeof settings === 'object') ws.settings = { ...ws.settings, ...settings };

    await ws.save();
    res.json({ workspace: ws });
  } catch (err) {
    console.error('[Workspace] update failed:', err);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// Delete workspace (soft delete by archiving)
router.delete('/:workspaceId', async (req, res) => {
  try {
    const userId = getActor(req)?.id || null;
    const { workspaceId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
      return res.status(400).json({ error: 'Invalid workspace ID' });
    }

    const ws = await Workspace.findOne({ _id: workspaceId, owner: userId });
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    // Mark as archived instead of hard delete for safety
    ws.metadata = ws.metadata || {};
    ws.metadata.archived = true;
    ws.metadata.archivedAt = new Date();
    await ws.save();

    console.info('[Workspace] archived:', workspaceId);
    res.json({ success: true, message: 'Workspace archived' });
  } catch (err) {
    console.error('[Workspace] delete failed:', err);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

module.exports = router;
