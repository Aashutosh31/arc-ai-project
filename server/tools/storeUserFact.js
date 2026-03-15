const UserFact = require('../models/UserFact');

module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "storeUserFact",
            description: "Store a permanent fact, preference, or detail about the user into their long-term memory. Use this when the user explicitly tells you to remember something, or when they share an important personal detail.",
            parameters: {
                type: "object",
                properties: {
                    fact: {
                        type: "string",
                        description: "The specific fact to remember about the user. Write it in third-person (e.g., 'The user's favorite color is blue')."
                    },
                    category: {
                        type: "string",
                        description: "A simple category for this fact (e.g., 'preferences', 'family', 'work', 'general')."
                    }
                },
                required: ["fact"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args, context) => {
        try {
            const newFact = new UserFact({
                userId: context.userId,
                fact: args.fact,
                category: args.category || 'general'
            });
            
            await newFact.save();
            
            return { 
                success: true, 
                message: `Fact successfully saved to user's long-term memory: ${args.fact}` 
            };
        } catch (error) {
            return { 
                success: false, 
                error: `Failed to save fact: ${error.message}` 
            };
        }
    }
};