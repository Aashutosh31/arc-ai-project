const ytSearch = require('yt-search');

module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "playMedia",
            description: "Play music, songs, videos, or podcasts requested by the user. Use this when the user says 'play [song]', 'listen to [music]', or 'show me a video of [topic]'.",
            parameters: {
                type: "object",
                properties: {
                    searchQuery: {
                        type: "string",
                        description: "The name of the song, artist, or video to search for."
                    }
                },
                required: ["searchQuery"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: playMedia] Searching YouTube for: ${args.searchQuery}`);
        
        try {
            // Search YouTube without an API key!
            const result = await ytSearch(args.searchQuery);
            const videos = result.videos.slice(0, 1); // Get the top result
            
            if (videos.length > 0) {
                const video = videos[0];
                console.log(`[Tool: playMedia] Found: ${video.title}`);
                
                return {
                    success: true,
                    message: `Playing ${video.title} for you now.`,
                    // 🚀 Trigger the floating Mini-Player on the frontend!
                    clientAction: {
                        type: 'PLAY_MEDIA',
                        videoId: video.videoId,
                        title: video.title
                    }
                };
            } else {
                return { success: false, message: "I couldn't find any videos matching that request." };
            }
        } catch (error) {
            console.error(`[Tool: playMedia] Error:`, error);
            return { success: false, error: "Failed to search for the media." };
        }
    }
};