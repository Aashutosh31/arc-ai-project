const toolRegistry = require('../tools/index');
const { consumeCredits } = require('./creditService');

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
        console.log(`[TaskExecutor] Before tool execution: ${toolName}`, args || {});
        
        try {
            if (executionOptions?.signal?.aborted) {
                return { success: false, cancelled: true, error: 'Execution aborted before tool start.' };
            }

            const tool = toolRegistry.getTool(toolName);
            
            if (!tool) {
                console.warn(`[TaskExecutor] AI requested an unknown tool: ${toolName}`);
                return { success: false, error: `Tool ${toolName} not found in system registry.` };
            }

            if (executionOptions?.signal?.aborted) {
                return { success: false, cancelled: true, error: 'Execution aborted before credit charge.' };
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
            const result = await tool.execute(args, context, socket);

            console.log(`[TaskExecutor] After tool execution: ${toolName}`, result);
            if (!result?.success) {
                console.warn('[TaskExecutor] Tool returned failure payload:', {
                    toolName,
                    error: result?.error || result?.message || null,
                    diagnostic: result?.diagnostic || null,
                    cancelled: Boolean(result?.cancelled),
                    payloadPreview: JSON.stringify(result).slice(0, 500)
                });
            }
            return result;
            
        } catch (error) {
            console.error(`[TaskExecutor] Critical failure in tool ${toolName}:`, error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new TaskExecutor();