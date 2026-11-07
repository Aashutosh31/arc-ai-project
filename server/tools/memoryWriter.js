const mongoose = require('mongoose');
const AIMemory = require('../models/AIMemory');
const { upsertTextVector } = require('../services/workspaceIndexService');
const { inferLayerFromText } = require('../lib/memoryLayers');

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

        const context = typeof passedUserId === 'object' && passedUserId !== null ? passedUserId : {};
        const uid = String(context.userId || context.id || context._id || passedUserId || '');
        const workspaceId = context.workspaceId || null;
        const conversationId = context.conversationId || null;

        if (!uid) {
            return { success: false, error: "No user context available for memory." };
        }

        const content = String(args.content || '').trim();
        if (!content) {
            return { success: false, error: "Nothing to memorize." };
        }

        const tagList = String(args.tags || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 12);
        const layer = inferLayerFromText(`${content} ${tagList.join(' ')}`, 'semantic');

        try {
            // Persist the memory in Mongo as well as the vector index. Before
            // Phase 3 `memorize` wrote only Pinecone, so the record could not be
            // viewed, edited, or deleted from the memory dashboard. The Mongo
            // row is the manageable source of truth; the vector is an index.
            let memoryDoc = null;
            if (mongoose.isValidObjectId(uid)) {
                try {
                    memoryDoc = await AIMemory.create({
                        userId: uid,
                        workspaceId: workspaceId || null,
                        query: content.slice(0, 280),
                        response: content,
                        tags: tagList,
                        layer,
                        source: 'memorize',
                        importance: 0.7,
                        confidence: 0.9,
                        summary: content.slice(0, 180),
                        conversationId: mongoose.isValidObjectId(conversationId) ? conversationId : null
                    });
                } catch (persistError) {
                    // Vector memory is still useful; do not fail the tool just
                    // because the manageable row could not be written.
                    console.warn('[Tool: memorize] Mongo persistence failed:', persistError?.message || persistError);
                }
            }

            const entityId = memoryDoc?._id || `mem_${Date.now()}`;
            let indexed = { skipped: true };
            try {
                indexed = await upsertTextVector({
                    userId: uid,
                    workspaceId,
                    kind: 'semanticMemory',
                    entityId,
                    text: content,
                    metadata: {
                        tags: tagList,
                        layer,
                        source: 'memorize',
                        ...(memoryDoc ? { memoryId: String(memoryDoc._id) } : {})
                    }
                });
            } catch (indexError) {
                // Mongo already holds the manageable row; do not fail the tool
                // and trigger a model retry that would duplicate it.
                console.warn('[Tool: memorize] Vector indexing failed:', indexError?.message || indexError);
            }

            console.log(`[Tool: memorize] Memory saved successfully! ID: ${entityId}`);
            return {
                success: true,
                message: "Information has been permanently encoded into my long-term memory.",
                memoryId: String(entityId),
                indexed: !indexed?.skipped
            };

        } catch (error) {
            console.error(`[Tool: memorize] Error:`, error);
            return { success: false, error: "Failed to access long-term memory." };
        }
    }
};
