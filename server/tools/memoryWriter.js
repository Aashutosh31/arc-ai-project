const { Pinecone } = require('@pinecone-database/pinecone');

module.exports = {
    schema: {
        type: "function",
        function: {
            name: "memorize",
            description: "Save important information, facts, or documents to your long-term memory vector database. Use this when the user says 'remember this', 'save this fact', or uploads a document they want you to remember forever.",
            parameters: {
                type: "object",
                properties: {
                    content: { 
                        type: "string", 
                        description: "The raw text or facts you need to memorize. Be highly detailed." 
                    },
                    tags: {
                        type: "string",
                        description: "Comma-separated keywords to categorize this memory (e.g., 'work, project x, code')."
                    }
                },
                required: ["content", "tags"]
            }
        }
    },
    
    execute: async (args, passedUserId) => {
        console.log(`[Tool: memorize] Encoding new memory into Vector Database...`);
        
        let uid = typeof passedUserId === 'object' && passedUserId !== null ? (passedUserId.userId || passedUserId.id || passedUserId._id) : passedUserId;
        uid = String(uid);

        try {
            // 1. Ask Mistral to convert the text into a 1024-dimension Vector
            const embedRes = await fetch('https://api.mistral.ai/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'mistral-embed',
                    input: [args.content]
                })
            });

            const embedData = await embedRes.json();
            if (!embedData.data || !embedData.data[0]) throw new Error("Failed to generate vector embedding.");
            const vector = embedData.data[0].embedding;

            // 2. Connect to Pinecone and Save it!
            const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
            const index = pc.index('arc-brain'); // Must match the name you created!

            // Generate a unique ID for this memory
            const memoryId = `mem_${Date.now()}`;

            await index.upsert([{
                id: memoryId,
                values: vector,
                metadata: {
                    userId: uid, // VERY IMPORTANT: Only save it for THIS user!
                    text: args.content,
                    tags: args.tags,
                    timestamp: new Date().toISOString()
                }
            }]);

            console.log(`[Tool: memorize] Memory saved successfully! ID: ${memoryId}`);
            return { success: true, message: "Information has been permanently encoded into my long-term memory." };

        } catch (error) {
            console.error(`[Tool: memorize] Error:`, error);
            return { success: false, error: "Failed to access long-term memory." };
        }
    }
};