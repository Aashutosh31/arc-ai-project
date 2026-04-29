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
    async executeTool(toolName, args, userId, socket = null) {
        console.log(`[TaskExecutor] Routing execution to tool: ${toolName}`, args);
        
        try {
            const tool = toolRegistry.getTool(toolName);
            
            if (!tool) {
                console.warn(`[TaskExecutor] AI requested an unknown tool: ${toolName}`);
                return { success: false, error: `Tool ${toolName} not found in system registry.` };
            }

            const creditCost = TOOL_CREDIT_COSTS[toolName] || 1;
            const creditResult = await consumeCredits(userId, creditCost, toolName);
            if (!creditResult.success) {
                return { success: false, error: creditResult.error, creditsRemaining: creditResult.creditsRemaining ?? 0 };
            }

            if (socket) {
                socket.emit('ai:credits:update', {
                    creditsRemaining: creditResult.creditsRemaining,
                    reason: toolName
                });
            }

            // Package the context (e.g., who is requesting this)
            const context = { userId };
            
            // Execute the tool's modular logic
            const result = await tool.execute(args, context, socket);
            
            console.log(`[TaskExecutor] Tool ${toolName} execution complete.`);
            return result;
            
        } catch (error) {
            console.error(`[TaskExecutor] Critical failure in tool ${toolName}:`, error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new TaskExecutor();