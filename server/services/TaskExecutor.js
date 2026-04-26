const toolRegistry = require('../tools/index');

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