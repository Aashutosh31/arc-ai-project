const mongoose = require('mongoose');
const UserFact = require('../models/UserFact');
const { upsertTextVector } = require('../services/workspaceIndexService');
const { inferLayerFromText, clamp01 } = require('../lib/memoryLayers');

module.exports = {
    // 1. Provider function-calling schema (Groq/Gemini compatible)
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
            const category = String(args.category || 'general').trim().slice(0, 40) || 'general';
            const layer = inferLayerFromText(`${args.fact || ''} ${category}`, 'semantic');
            const confidence = clamp01(context.confidence, 0.95);
            const importance = clamp01(context.importance, 0.7);
            const newFact = new UserFact({
                userId: context.userId,
                workspaceId: context.workspaceId || null,
                fact: args.fact,
                category,
                pinned: false,
                layer,
                source: context.source || 'explicit',
                confidence,
                importance,
                conversationId: mongoose.isValidObjectId(context.conversationId) ? context.conversationId : null
            });
            
            await newFact.save();
            let indexed = { skipped: true };
            try {
                indexed = await upsertTextVector({
                    userId: context.userId,
                    workspaceId: context.workspaceId || null,
                    kind: 'userFact',
                    entityId: newFact._id,
                    text: args.fact,
                    metadata: {
                        category,
                        source: context.source || 'explicit',
                        layer,
                        confidence,
                        memoryId: String(newFact._id)
                    }
                });
            } catch (indexError) {
                // The Mongo row is the source of truth; a vector outage must not
                // make the model retry and duplicate the fact.
                console.warn('[Tool: storeUserFact] Vector indexing failed:', indexError?.message || indexError);
            }

            return { 
                success: true, 
                message: `Fact successfully saved to user's long-term memory: ${args.fact}`,
                indexed: !indexed?.skipped
            };
        } catch (error) {
            return { 
                success: false, 
                error: `Failed to save fact: ${error.message}` 
            };
        }
    }
};