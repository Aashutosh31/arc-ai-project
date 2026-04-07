module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "stopMedia",
            description: "Stop the currently playing media, music, or video and close the media player. Use this when the user says 'stop it', 'stop the music', 'close the video', or 'turn it off'.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    
    // 2. Execution Logic
    execute: async () => {
        console.log(`[Tool: stopMedia] Requesting client to stop media playback.`);
        
        return {
            success: true,
            message: "I have stopped the media and closed the player for you.",
            // 🚀 Trigger the frontend to close the floating player!
            clientAction: {
                type: 'STOP_MEDIA'
            }
        };
    }
};