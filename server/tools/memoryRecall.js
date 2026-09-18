const { Pinecone } = require('@pinecone-database/pinecone');
const { getNamespace } = require('../services/workspaceIndexService');
const { getEmbedding } = require('../services/embeddingService');

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
        const workspaceId = typeof passedUserId === 'object' && passedUserId !== null ? (passedUserId.workspaceId || null) : null;
        uid = String(uid);

        try {
            // 1. Convert the Search Query into a Vector (shared embedding provider)
            const queryVector = await getEmbedding(args.searchQuery);
            if (!queryVector) {
                return { success: true, data: "No relevant memories found in the database." };
            }

            // 2. Search Pinecone for the 3 most semantically similar memories
            const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
            const index = pc.index('arc-brain');
            const namespace = getNamespace(uid, workspaceId);

            const queryResponse = await index.query({
                namespace,
                vector: queryVector,
                topK: 3,
                includeMetadata: true
            });

            if (!queryResponse.matches || queryResponse.matches.length === 0) {
                return { success: true, data: "No relevant memories found in the database." };
            }

            // 3. Compile the memories into a readable format for the provider to interpret
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