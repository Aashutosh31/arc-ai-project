const Workspace = require('../models/Workspace');
const mongoose = require('mongoose');
const WorkspaceLogger = require('../lib/WorkspaceLogger');

class WorkspaceRuntimeManager {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.wsLog = new WorkspaceLogger('WorkspaceRuntime');
  }

  async getWorkspaceById(workspaceId) {
    if (!workspaceId) return null;
    if (!mongoose.Types.ObjectId.isValid(workspaceId)) return null;
    const ws = await Workspace.findOne({
      _id: workspaceId,
      $or: [{ 'metadata.archived': { $exists: false } }, { 'metadata.archived': { $ne: true } }]
    }).lean();
    if (!ws) this.logger.info('[WorkspaceRuntimeManager] workspace not found:', workspaceId);
    return ws;
  }

  async createDefaultWorkspace(userId) {
    const defaultName = 'Default Workspace';
    const ws = new Workspace({ name: defaultName, owner: userId });
    await ws.save();
    // generate a deterministic vector namespace tied to id
    ws.vectorNamespace = `workspace_${ws._id}`;
    await ws.save();
    this.wsLog.workspaceDefaultCreated(userId, ws._id.toString(), ws.vectorNamespace);
    // Best-effort background migration: attach existing user-scoped documents to this workspace
    setImmediate(async () => {
      try {
        const Conversation = require('../models/Conversation');
        const Message = require('../models/Message');
        const AIMemory = require('../models/AIMemory');
        const UserFact = require('../models/UserFact');
        const Execution = require('../models/Execution');

        const selector = { userId: userId, workspaceId: { $in: [null, undefined] } };
        await Promise.all([
          Conversation.updateMany(selector, { $set: { workspaceId: ws._id } }),
          Message.updateMany({ workspaceId: { $in: [null, undefined] }, $or: [{ userId }, { conversationId: { $exists: true } }] }, { $set: { workspaceId: ws._id } }),
          AIMemory.updateMany({ userId: userId, workspaceId: { $in: [null, undefined] } }, { $set: { workspaceId: ws._id } }),
          UserFact.updateMany({ userId: userId, workspaceId: { $in: [null, undefined] } }, { $set: { workspaceId: ws._id } }),
          Execution.updateMany({ userId: userId, workspaceId: { $in: [null, undefined] } }, { $set: { workspaceId: ws._id } })
        ]);
        this.logger.info('[WorkspaceRuntimeManager] migration completed for user', userId, '-> workspace', ws._id.toString());
      } catch (err) {
        this.logger.warn('[WorkspaceRuntimeManager] background migration failed:', err?.message || err);
      }
    });

    return ws.toObject();
  }

  async resolveWorkspace({ userId, workspaceId } = {}) {
    // priority: explicit workspaceId -> user's default workspace -> create default
    if (workspaceId) {
      const ws = await this.getWorkspaceById(workspaceId);
      if (ws) {
        this.wsLog.workspaceResolved(userId, ws._id.toString(), ws.vectorNamespace || `workspace_${ws._id}`);
        return ws;
      }
    }

    const defaultWs = await Workspace.findOne({
      owner: userId,
      $or: [{ 'metadata.archived': { $exists: false } }, { 'metadata.archived': { $ne: true } }]
    }).sort({ createdAt: 1 }).lean();
    if (defaultWs) {
      if (!defaultWs.vectorNamespace) {
        defaultWs.vectorNamespace = `workspace_${defaultWs._id}`;
        await Workspace.updateOne({ _id: defaultWs._id }, { $set: { vectorNamespace: defaultWs.vectorNamespace } });
      }
      this.wsLog.workspaceResolved(userId, defaultWs._id.toString(), defaultWs.vectorNamespace);
      return defaultWs;
    }

    // create one non-destructively
    return this.createDefaultWorkspace(userId);
  }

  injectWorkspaceContext(workspace) {
    if (!workspace) return { workspaceId: null, vectorNamespace: null, settings: {} };
    return {
      workspaceId: workspace._id,
      vectorNamespace: workspace.vectorNamespace || `workspace_${workspace._id}`,
      settings: workspace.settings || {},
      metadata: workspace.metadata || {}
    };
  }

}

module.exports = WorkspaceRuntimeManager;
