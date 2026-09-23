const toolRegistry = require('../tools/index');
const { consumeCredits, isGuestActorId } = require('./creditService');
const { McpToolSource, isMcpToolName } = require('../lib/mcp');
const {
    createExecutionEnvelope,
    resolveExecutionCapability,
    authorizationPolicy: { authorizeCapability },
    operatorPolicy,
    capabilityTypes,
    observability
} = require('../lib/capabilities');
const idempotency = require('../lib/capabilities/idempotency');

// Slice 4B: normalized failure type for an execution-time authorization
// denial. Consumed by the envelope classification as an authorization error.
const EXEC_NOT_AUTHORIZED = 'execution.not_authorized';

/**
 * Read-only projection of the authoritative MCP pipeline state: whether the
 * live registry currently authorizes this wire tool for the given context.
 * Reuses the pipeline's OWN matchers (configsForWorkspace, toolAllowed) and
 * never modifies anything. McpManager.resolveTool still performs its own
 * final policy recheck during execution — this is a consumption point, not
 * a duplicate of the MCP policy.
 */
const mcpAuthorizedFor = (toolName, { workspaceId = null, isGuest = false } = {}) => {
    if (!isMcpToolName(toolName)) return null;
    let registry;
    try { registry = McpToolSource.registry; } catch { return false; }
    if (!registry) return false;

    let entry = null;
    try {
        entry = typeof registry.toolByWireName === 'function' ? registry.toolByWireName(toolName) : null;
    } catch { return false; }
    if (!entry) return false;

    let config = null;
    try {
        config = typeof registry.get === 'function' ? registry.get(entry.configId) : null;
    } catch { return false; }
    if (!config || config.disabled) return false;

    // Workspace/guest visibility via the pipeline's own query (handles scope,
    // disabled, and guest opt-in).
    if (typeof registry.configsForWorkspace === 'function') {
        let visible = false;
        try {
            const configs = registry.configsForWorkspace({ workspaceId, isGuest }) || [];
            visible = configs.some((c) => String(c.id) === String(entry.configId));
        } catch { return false; }
        if (!visible) return false;
    }

    // Allow/deny policy via the pipeline's own matcher (denied always wins).
    if (typeof registry.toolAllowed === 'function') {
        try {
            if (!registry.toolAllowed(entry.configId, entry.wireName, entry.originalToolName, workspaceId, isGuest)) {
                return false;
            }
        } catch { return false; }
    }

    return true;
};

const TOOL_CREDIT_COSTS = {
    executeCode: 2,
    checkCalendar: 3,
    scheduleMeeting: 5,
    deepResearchSwarm: 8,
    webSearch: 2,
    scrapeWebsite: 2,
    sendEmail: 2,
    openWebsite: 1,
    changeTheme: 1,
    storeUserFact: 1,
    memoryWriter: 1,
    memoryRecall: 1
};

/**
 * TaskExecutor now acts as a secure bridge between the AI logic
 * and the Modular Tool Registry. 
 */
class TaskExecutor {
    async executeTool(toolName, args, userId, socket = null, executionOptions = {}) {
        console.log(`[TaskExecutor] Before tool execution: ${toolName}`);

        // JARVIS Action Substrate — slice 2/3: wrap the single governed
        // execution choke point with the normalized envelope and the
        // idempotency guard. Additive only: the original body
        // (_executeToolCore) is preserved verbatim and its result is returned
        // unchanged.
        const envelope = createExecutionEnvelope({
            toolName,
            userId,
            workspaceId: executionOptions?.workspaceId || null,
            conversationId: executionOptions?.conversationId || null,
            signal: executionOptions?.signal || null,
            executionOptions,
            isGuest: isGuestActorId(userId)
        });

        // Slice 3: reserve the logical action before ANY side effect runs.
        // A duplicate (running or terminal) returns the prior outcome and
        // never re-executes the tool, credit flow, or clientAction emission.
        const gate = await idempotency.preflight({ envelope, executionOptions });
        if (gate.decision !== 'execute') {
            return gate.result;
        }
        envelope.idempotencyKey = gate.idempotency.keyHash || null;
        envelope.start();

        let result;
        try {
            result = await this._executeToolCore(toolName, args, userId, socket, executionOptions, envelope);
        } catch (error) {
            console.error(`[TaskExecutor] Critical failure in tool ${toolName}:`, error);
            result = { success: false, error: error.message };
        }
        const finalized = envelope.finalize(result, { signalAborted: Boolean(executionOptions?.signal?.aborted) });
        await idempotency.settle({ envelope, idempotency: gate.idempotency });
        return finalized;
    }

    async _executeToolCore(toolName, args, userId, socket = null, executionOptions = {}, envelope = null) {
        try {
            if (executionOptions?.signal?.aborted) {
                return { success: false, cancelled: true, error: 'Execution aborted before tool start.' };
            }

            let tool = toolRegistry.getTool(toolName);
            const isMcp = !tool && isMcpToolName(toolName);

            if (isMcp) {
                // MCP fallback: native registry first, MCP only on a miss.
                // Native tools can never be shadowed by an MCP server.
                try {
                    tool = await McpToolSource.resolveTool(toolName, {
                        workspaceId: executionOptions?.workspaceId || null,
                        isGuest: isGuestActorId(userId),
                        signal: executionOptions?.signal || null,
                        // Execution fallback reconnects carry the silent
                        // OAuth provider (same as schema supply): stored
                        // credentials survive restarts, live connections do
                        // not. Never interactive; failures stay classified.
                        userId
                    });
                } catch (err) {
                    return {
                        success: false,
                        error: err?.message || `MCP tool ${toolName} unavailable.`,
                        errorType: err?.category || 'mcp.protocol_error',
                        retryable: Boolean(err?.retryable),
                        tool: toolName,
                        cancelled: err?.category === 'mcp.cancelled'
                    };
                }
            }
            
            if (!tool) {
                console.warn(`[TaskExecutor] AI requested an unknown tool: ${toolName}`);
                return { success: false, error: `Tool ${toolName} not found in system registry.` };
            }

            if (executionOptions?.signal?.aborted) {
                return { success: false, cancelled: true, error: 'Execution aborted before credit charge.' };
            }

            // JARVIS Action Substrate — slice 4B: server-authoritative
            // execution-time authorization at the single choke point.
            //
            // Resolution (native or MCP) has already produced the authoritative
            // capability identity above. The verdict runs BEFORE credits,
            // clientAction emission, recovery/retry, provider fallback, and any
            // side-effect execution. MCP policy denial remains non-overridable
            // (authorizationPolicy consumes the pipeline projection only).
            //
            // APPROVAL_REQUIRED stays TRANSITIONAL in this slice: it executes,
            // because the approval transport/store/UI do not exist yet (the
            // verdict is surfaced through observability and safe metadata).
            const authorization = this._authorizeExecution(toolName, { isMcp, userId, executionOptions, envelope });
            authorization.observe();
            if (!authorization.verdict.allowed) {
                return {
                    success: false,
                    error: `Tool ${toolName} is not authorized for this action.`,
                    errorType: EXEC_NOT_AUTHORIZED,
                    tool: toolName,
                    authorization: authorization.metadata
                };
            }

            if (!executionOptions?.skipCreditCharge) {
                const creditCost = TOOL_CREDIT_COSTS[toolName] || 1;
                const creditResult = await consumeCredits(userId, creditCost, toolName);
                if (!creditResult.success) {
                    return {
                        success: false,
                        blocked: Boolean(creditResult.blocked),
                        status: creditResult.status || (creditResult.blocked ? 'BLOCKED' : 'FAILED'),
                        reason: creditResult.reason || null,
                        error: creditResult.error,
                        creditsRemaining: creditResult.creditsRemaining ?? 0
                    };
                }

                if (socket) {
                    socket.emit('ai:credits:update', {
                        creditsRemaining: creditResult.creditsRemaining,
                        reason: toolName
                    });
                }
            }

            // Package the context (e.g., who is requesting this)
            const context = {
                userId,
                signal: executionOptions?.signal || null,
                workspaceId: executionOptions?.workspaceId || null,
                conversationId: executionOptions?.conversationId || null
            };

            if (executionOptions?.signal?.aborted) {
                return { success: false, cancelled: true, error: 'Execution aborted before tool invocation.' };
            }
            
            // Execute the tool's modular logic
            if (envelope) envelope.markRunning();
            const result = await tool.execute(args, context, socket);

            console.log(`[TaskExecutor] After tool execution: ${toolName}`);
            if (!result?.success && !isMcp) {
                console.warn('[TaskExecutor] Tool returned failure payload:', {
                    toolName,
                    error: result?.error || result?.message || null,
                    diagnostic: result?.diagnostic || null,
                    cancelled: Boolean(result?.cancelled),
                    payloadPreview: JSON.stringify(result).slice(0, 500)
                });
            } else if (!result?.success && isMcp) {
                console.warn('[TaskExecutor] MCP tool returned failure payload:', {
                    toolName,
                    errorType: result?.errorType || null,
                    cancelled: Boolean(result?.cancelled),
                    retryable: Boolean(result?.retryable)
                });
            }
            return result;
            
        } catch (error) {
            console.error(`[TaskExecutor] Critical failure in tool ${toolName}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Slice 4B authorization decision for ONE execution. Pure within the
     * boundary: builds the authoritative capability identity (Slice-1
     * substrate builders — never the raw requested name alone), derives the
     * MCP policy projection from the live registry, and asks the pure
     * authorizationPolicy for a verdict. Denied executions are returned at
     * the call site with safe metadata; approval-required stays allowed.
     */
    _authorizeExecution(toolName, { isMcp, userId, executionOptions, envelope }) {
        const isGuest = Boolean(isGuestActorId(userId));
        const workspaceId = executionOptions?.workspaceId || null;

        // Authoritative capability identity. Unresolvable capabilities fail
        // safe: authorizeCapability(null) yields a malformed DENIED verdict.
        const capability = resolveExecutionCapability(toolName, { isGuest });

        const mcpAuthorized =
            isMcp && capability && capability.source === capabilityTypes.SOURCE_MCP
                ? mcpAuthorizedFor(toolName, { workspaceId, isGuest })
                : null;

        const policy = executionOptions?.authorizationPolicy || operatorPolicy.getOperatorPolicy() || operatorPolicy.DEFAULT_POLICY;
        const verdict = authorizeCapability(
            capability,
            { userId, workspaceId, isGuest },
            { policy, mcpAuthorized }
        );

        const source = capability
            ? capability.source
            : (isMcp ? capabilityTypes.SOURCE_MCP : capabilityTypes.SOURCE_NATIVE);
        const metadata = {
            capabilityId: capability ? capability.id : null,
            source,
            risk: verdict.risk,
            scope: verdict.scope,
            state: verdict.state,
            reason: verdict.reason,
            policySource: verdict.policySource,
            requiresApproval: Boolean(verdict.requiresApproval)
        };

        const observe = () => {
            let event;
            if (!verdict.allowed) event = observability.LOG_EVENTS.AUTH_DENIED;
            else if (verdict.requiresApproval === true) event = observability.LOG_EVENTS.AUTH_APPROVAL_REQUIRED;
            else event = observability.LOG_EVENTS.AUTH_ALLOWED;
            if (event) {
                observability.log(event, {
                    executionId: envelope && envelope.executionId,
                    capabilityId: metadata.capabilityId,
                    toolName,
                    source,
                    workspaceId,
                    risk: metadata.risk,
                    scope: metadata.scope,
                    state: metadata.state,
                    reason: metadata.reason,
                    policySource: metadata.policySource
                });
            }
        };

        return { verdict, metadata, observe };
    }
}

module.exports = new TaskExecutor();