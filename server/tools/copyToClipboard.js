module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "copyToClipboard",
            description: "Copy specific text, code, emails, or content to the user's system clipboard. Use this ONLY when the user explicitly asks you to 'copy this', 'copy the code', or 'copy to my clipboard'.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The exact text, code, or content to be copied to the clipboard."
                    }
                },
                required: ["text"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: copyToClipboard] Requesting client to copy ${args.text.length} characters.`);
        
        return {
            success: true,
            message: "Successfully triggered the browser to copy the text to the clipboard.",
            // 🚀 The payload that commands the React frontend
            clientAction: {
                type: 'COPY_TO_CLIPBOARD',
                text: args.text
            }
        };
    }
};