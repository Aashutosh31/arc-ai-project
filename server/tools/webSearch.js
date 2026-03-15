module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "webSearch",
            description: "Search the web for real-time information, historical facts, summaries about people, places, or current events. Use this whenever the user asks for factual information you might not know.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The specific search query or topic to look up."
                    }
                },
                required: ["query"]
            }
        }
    },
    
    // 2. Execution Logic (Using the free Wikipedia API)
    execute: async (args, context) => {
        console.log(`[Tool: webSearch] Searching web for: "${args.query}"`);
        
        try {
            // Step 1: Search for the closest matching article
            const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(args.query)}&utf8=&format=json&origin=*`;
            const searchRes = await fetch(searchUrl);
            const searchData = await searchRes.json();
            
            if (!searchData.query || searchData.query.search.length === 0) {
                return { 
                    success: false, 
                    message: `I searched the web but couldn't find any exact information about "${args.query}".` 
                };
            }

            const firstResult = searchData.query.search[0];
            
            // Clean up the HTML tags Wikipedia returns in its snippets
            const cleanSnippet = firstResult.snippet.replace(/<[^>]*>?/gm, '');
            
            return { 
                success: true, 
                title: firstResult.title,
                summary: cleanSnippet,
                source: "Wikipedia Search"
            };
        } catch (error) {
            return { 
                success: false, 
                error: `Failed to search the web: ${error.message}` 
            };
        }
    }
};