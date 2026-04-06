module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "changeTheme",
            description: "Change the visual UI theme or colors of the application. Use this when the user asks for 'Hacker mode', 'Red alert', 'Dark mode', or to revert to the 'Default theme'.",
            parameters: {
                type: "object",
                properties: {
                    theme: {
                        type: "string",
                        enum: ["default", "hacker", "alert"],
                        description: "The requested theme."
                    }
                },
                required: ["theme"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: changeTheme] Requesting client to switch to theme: ${args.theme}`);
        
        return {
            success: true,
            message: `Successfully changed the system UI theme to ${args.theme} mode.`,
            // 🚀 Tell the React frontend to physically change the CSS!
            clientAction: {
                type: 'CHANGE_THEME',
                theme: args.theme
            }
        };
    }
};