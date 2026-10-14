const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { discoverMcp, McpToolSource } = require('../lib/mcp');
const { selectToolSchemas, matchGroups, CAPABILITY_GROUPS, GROUP_PRIORITY, GROUP_PATTERNS, CAP_TOOL_PATTERNS, CAP_INTENT_PATTERNS, CAPABILITY_PICK_ORDER } = require('../lib/llm/toolSelection');
const { authorizationPolicy } = require('../lib/capabilities/authorizationPolicy');
const { McpRegistry } = require('../lib/mcp/McpRegistry');

const router = express.Router();

// Debug endpoint to show tool selection rationale
router.get('/debug/tool-selection', protect, async (req, res) => {
    try {
        const { query, workspaceId } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'query parameter required' });
        }

        const userId = req.user._id;
        const isGuest = req.authType === 'guest';

        // Step 1: Lexical group matching
        const matchedGroups = matchGroups(query);
        const groupsWithPriority = matchedGroups.map(g => ({
            group: g,
            priority: GROUP_PRIORITY.indexOf(g),
        })).sort((a, b) => a.priority - b.priority);

        // Step 2: Native tool schemas for matched groups
        const nativeSchemas = [];
        for (const { group } of groupsWithPriority) {
            const toolNames = CAPABILITY_GROUPS[group] || [];
            for (const toolName of toolNames) {
                if (nativeSchemas.length >= 6) break;
                const tool = require('../tools/index').get(toolName);
                if (tool) {
                    nativeSchemas.push({
                        name: toolName,
                        group,
                        schema: tool.schema,
                    });
                }
            }
        }

        // Step 3: MCP capabilities for workspace
        let mcpCapabilities = [];
        let mcpSelectionDebug = [];

        if (!isGuest) {
            try {
                const mcpResult = await discoverMcp({ workspaceId: workspaceId || null, userId });
                const mcpTools = McpRegistry.configsForWorkspace(userId, workspaceId || null, mcpResult.configs);

                // Get capability intents from query
                const queryLower = query.toLowerCase();
                const requestedCapabilities = [];

                for (const [cap, patterns] of Object.entries(CAP_INTENT_PATTERNS)) {
                    for (const pattern of patterns) {
                        if (pattern.test(queryLower)) {
                            requestedCapabilities.push(cap);
                            break;
                        }
                    }
                }

                // Filter MCP tools by policy
                const allowedMcpTools = [];
                for (const config of mcpTools) {
                    const wireNames = Object.keys(config.tools);
                    for (const wireName of wireNames) {
                        if (!McpRegistry.toolAllowed(userId, workspaceId || null, wireName)) {
                            mcpSelectionDebug.push({
                                tool: wireName,
                                server: config.slug,
                                status: 'blocked_by_policy',
                                reason: 'MCP policy denied',
                            });
                            continue;
                        }

                        // Check capability match
                        const schema = config.tools[wireName];
                        const toolCaps = getToolCapabilities(schema);
                        const hasMatchingCap = requestedCapabilities.length === 0 ||
                            toolCaps.some(cap => requestedCapabilities.includes(cap));

                        if (hasMatchingCap) {
                            const auth = authorizationPolicy.authorizeCapability(req.actor, {
                                capabilityId: wireName,
                                source: 'mcp',
                                toolName: wireName,
                            });
                            if (auth.allowed) {
                                allowedMcpTools.push({
                                    wireName,
                                    serverSlug: config.slug,
                                    schema,
                                    capabilities: toolCaps,
                                    authorized: true,
                                });
                                mcpSelectionDebug.push({
                                    tool: wireName,
                                    server: config.slug,
                                    status: 'selected',
                                    capabilities: toolCaps,
                                    reason: 'Matches requested capability and policy allows',
                                });
                            } else {
                                mcpSelectionDebug.push({
                                    tool: wireName,
                                    server: config.slug,
                                    status: 'blocked_by_auth',
                                    reason: `Authorization denied: ${auth.reason}`,
                                });
                            }
                        } else {
                            mcpSelectionDebug.push({
                                tool: wireName,
                                server: config.slug,
                                status: 'skipped',
                                reason: `No matching capability (requested: ${requestedCapabilities.join(', ')})`,
                            });
                        }
                    }
                }

                mcpCapabilities = allowedMcpTools;
            } catch (err) {
                mcpSelectionDebug.push({
                    error: err.message,
                    stage: 'mcp_discovery',
                });
            }
        }

        // Step 4: Combine and apply budget (max 6 tools)
        const allCandidates = [
            ...nativeSchemas.map(s => ({ ...s, source: 'native' })),
            ...mcpCapabilities.map(s => ({ ...s, source: 'mcp' })),
        ];

        // Sort by group priority (native) and capability priority (MCP)
        allCandidates.sort((a, b) => {
            if (a.source === 'native' && b.source === 'mcp') return -1;
            if (a.source === 'mcp' && b.source === 'native') return 1;
            if (a.source === 'native' && b.source === 'native') {
                return (GROUP_PRIORITY.indexOf(a.group) || 99) - (GROUP_PRIORITY.indexOf(b.group) || 99);
            }
            // MCP: sort by capability pick order
            const aCapIdx = a.capabilities ? Math.min(...a.capabilities.map(c => CAPABILITY_PICK_ORDER.indexOf(c))) : 99;
            const bCapIdx = b.capabilities ? Math.min(...b.capabilities.map(c => CAPABILITY_PICK_ORDER.indexOf(c))) : 99;
            return aCapIdx - bCapIdx;
        });

        const selected = allCandidates.slice(0, 6);

        res.json({
            query,
            workspaceId: workspaceId || null,
            isGuest,
            userId,
            matchedGroups: groupsWithPriority,
            requestedCapabilities,
            nativeCandidates: nativeSchemas,
            mcpCandidates: mcpCapabilities,
            mcpSelectionDebug,
            finalSelection: selected.map(s => ({
                name: s.name || s.wireName,
                source: s.source,
                group: s.group,
                server: s.serverSlug,
                capabilities: s.capabilities,
            })),
            totalCandidates: allCandidates.length,
            dropped: allCandidates.length > 6 ? allCandidates.slice(6).map(s => s.name || s.wireName) : [],
        });
    } catch (err) {
        console.error('[ToolSelectionDebug] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Debug endpoint to list all available MCP tools with policy status
router.get('/debug/mcp-tools', protect, async (req, res) => {
    try {
        const { workspaceId } = req.query;
        const userId = req.user._id;
        const isGuest = req.authType === 'guest';

        if (isGuest) {
            return res.json({ tools: [], message: 'Guests cannot access MCP tools' });
        }

        const mcpResult = await discoverMcp({ workspaceId: workspaceId || null, userId });
        const mcpTools = McpRegistry.configsForWorkspace(userId, workspaceId || null, mcpResult.configs);

        const allTools = [];
        for (const config of mcpTools) {
            const wireNames = Object.keys(config.tools);
            for (const wireName of wireNames) {
                const schema = config.tools[wireName];
                const allowed = McpRegistry.toolAllowed(userId, workspaceId || null, wireName);
                const auth = allowed ? authorizationPolicy.authorizeCapability(req.actor, {
                    capabilityId: wireName,
                    source: 'mcp',
                    toolName: wireName,
                }) : { allowed: false, reason: 'Policy blocked' };

                allTools.push({
                    wireName,
                    serverSlug: config.slug,
                    serverName: config.name,
                    description: schema.description,
                    policyAllowed: allowed,
                    authAllowed: auth.allowed,
                    authReason: auth.reason,
                    capabilities: getToolCapabilities(schema),
                });
            }
        }

        res.json({ tools: allTools });
    } catch (err) {
        console.error('[MCPToolsDebug] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper to extract capabilities from tool schema
function getToolCapabilities(schema) {
    const text = [
        schema.name || '',
        schema.description || '',
        ...(schema.parameters?.properties ? Object.keys(schema.parameters.properties) : []),
    ].join(' ').toLowerCase();

    const caps = [];
    for (const [cap, patterns] of Object.entries(CAP_TOOL_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(text)) {
                caps.push(cap);
                break;
            }
        }
    }
    return caps;
}

module.exports = router;