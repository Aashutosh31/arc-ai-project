const { Pinecone } = require('@pinecone-database/pinecone');
const { getNamespace } = require('../services/workspaceIndexService');

module.exports = {
    schema: {
        type: "function",
        function: {
            name: "recallMemory",
            description: "Search your permanent long-term vector database for past knowledge, facts, or documents. Use this when a user asks 'what did I tell you about...', 'do you remember...', or asks a question that requires consulting past saved knowledge.",
            parameters: {
                type: "object",
                properties: {
                    searchQuery: { 
                        type: "string", 
                        description: "The question or concept to search for in the database." 
                    }
                },
                required: ["searchQuery"]
            }
        }
    },
    
    execute: async (args, passedUserId) => {
        console.log(`[Tool: recallMemory] Searching Pinecone vector brain for: "${args.searchQuery}"`);
        
        let uid = typeof passedUserId === 'object' && passedUserId !== null ? (passedUserId.userId || passedUserId.id || passedUserId._id) : passedUserId;
        uid = String(uid);

        try {
            // 1. Convert the Search Query into a Vector using Mistral
            const embedRes = await fetch('https://api.mistral.ai/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'mistral-embed',
                    input: [args.searchQuery]
                })
            });

            const embedData = await embedRes.json();
            const queryVector = embedData.data[0].embedding;

            // 2. Search Pinecone for the 3 most semantically similar memories
            const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
            const index = pc.index('arc-brain');
            const namespace = getNamespace(uid);

            const queryResponse = await index.query({
                namespace,
                vector: queryVector,
                topK: 3,
                includeMetadata: true
            });

            if (!queryResponse.matches || queryResponse.matches.length === 0) {
                return { success: true, data: "No relevant memories found in the database." };
            }

            // 3. Compile the memories into a readable format for Mistral to interpret
            let compiledMemories = queryResponse.matches.map((match, i) => {
                return `Memory ${i + 1} (Match Score: ${(match.score * 100).toFixed(1)}%):\nText: ${match.metadata.text}\nTags: ${match.metadata.tags}`;
            }).join('\n\n');

            console.log(`[Tool: recallMemory] Retrieved ${queryResponse.matches.length} memories.`);
            return { 
                success: true, 
                message: "I have retrieved the following related memories. Read them to answer the user's query:",
                retrieved_data: compiledMemories 
            };

        } catch (error) {
            console.error(`[Tool: recallMemory] Error:`, error);
            return { success: false, error: "Failed to retrieve memories." };
        }
    }
};