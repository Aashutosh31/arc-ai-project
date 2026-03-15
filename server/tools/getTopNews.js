module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "getTopNews",
            description: "Fetch the absolute latest, real-time top news headlines from around the world. Use this specifically when the user asks for current news, today's headlines, or what is happening in the world right now.",
            parameters: {
                type: "object",
                properties: {}, // No parameters needed, just fetch the news
                required: []
            }
        }
    },
    
    // 2. Execution Logic (Using BBC World News RSS converted to JSON for free)
    execute: async () => {
        console.log(`[Tool: getTopNews] Fetching live world news...`);
        
        try {
            const rssUrl = 'http://feeds.bbci.co.uk/news/world/rss.xml';
            const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
            
            const res = await fetch(apiUrl);
            const data = await res.json();
            
            if (data.status !== 'ok') {
                return { success: false, message: "News API is currently unavailable." };
            }

            // Extract just the top 5 headlines to keep the AI response concise
            const top5 = data.items.slice(0, 5).map(item => ({
                headline: item.title,
                publishedAt: item.pubDate
            }));
            
            return { 
                success: true, 
                source: "BBC World News",
                articles: top5 
            };
        } catch (error) {
            return { 
                success: false, 
                error: `Failed to fetch news: ${error.message}` 
            };
        }
    }
};