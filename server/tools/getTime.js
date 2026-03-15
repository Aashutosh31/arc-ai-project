module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "getTime",
            description: "Get the current system time and date.",
            parameters: {
                type: "object",
                properties: {}, // No parameters needed for this simple tool
                required: []
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args, context) => {
        const now = new Date();
        // Return structured data back to Mistral
        return {
            success: true,
            time: now.toLocaleTimeString(),
            date: now.toLocaleDateString(),
            fullISO: now.toISOString()
        };
    }
};