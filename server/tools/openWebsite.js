module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "openWebsite",
            description: "Open a specific website or URL in the user's browser. Use this when the user asks to open YouTube, Google, GitHub, Netflix, or any other website.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The full HTTPS URL of the website to open (e.g., 'https://www.youtube.com')."
                    },
                    siteName: {
                        type: "string",
                        description: "The name of the site being opened (e.g., 'YouTube')."
                    }
                },
                required: ["url", "siteName"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args, context) => {
        console.log(`[Tool: openWebsite] Requesting client to open: ${args.url}`);
        
        return {
            success: true,
            message: `Successfully triggered the browser to open ${args.siteName}.`,
            // 🚀 NEW: This special payload tells the frontend to perform a physical action
            clientAction: {
                type: 'OPEN_URL',
                url: args.url
            }
        };
    }
};