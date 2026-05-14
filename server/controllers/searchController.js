const { searchWorkspace } = require('../services/workspaceSearchService');

exports.searchWorkspace = async (req, res) => {
  const userId = req.user?.id || req.user?.userId;
  const query = String(req.query.q || req.body?.q || '').trim();
  const limit = Math.min(Number(req.query.limit || req.body?.limit || 10) || 10, 20);

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!query) {
    return res.json({ query: '', items: [], grouped: { conversations: [], messages: [], memories: [] }, stats: { total: 0, conversations: 0, messages: 0, memories: 0 } });
  }

  const controller = req.searchAbortController || null;

  try {
    if (controller?.signal?.aborted) {
      return res.status(499).json({ error: 'Search cancelled' });
    }

    const result = await searchWorkspace({ userId, query, signal: controller?.signal || null, limit });
    return res.json(result);
  } catch (error) {
    console.error('[Search] workspace search failed:', error?.stack || error);
    return res.status(500).json({ error: error.message || 'Workspace search failed' });
  }
};
