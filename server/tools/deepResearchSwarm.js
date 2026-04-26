const { Mistral } = require('@mistralai/mistralai');
const webSearchTool = require('./webSearch');
const scrapeWebsiteTool = require('./scrapeWebsite');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    schema: {
        type: "function",
        function: {
            name: "deepResearchSwarm",
            description: "Deploy a multi-agent swarm to conduct deep research, scrape multiple websites, and write a comprehensive report on a complex topic. Use this ONLY for complex requests like 'write a 5-page report on...', 'deep dive into...', or 'comprehensively research...'",
            parameters: {
                type: "object",
                properties: {
                    topic: { type: "string", description: "The complex topic to deeply research." }
                },
                required: ["topic"]
            }
        }
    },
    
    execute: async (args, passedUserId, socket) => {
        console.log(`[Swarm Orchestrator] Spinning up multi-agent swarm for: ${args.topic}`);

        const emitUpdate = (text) => {
            if (socket) {
                // 🚀 Emits the live status strictly to the UI (does not pollute the chat log)
                socket.emit('ai:agent:status', { status: text });
            }
            console.log(text);
        };

        try {
            emitUpdate(`Assigning topic: "${args.topic}" to the Swarm...`);
            await delay(1000);

            emitUpdate(`Searching the web for latest data...`);
            const searchResults = await webSearchTool.execute({ query: args.topic + " latest news comprehensive overview" });
            
            const urlMatch = searchResults.content ? searchResults.content.match(/https?:\/\/[^\s]+/) : null;
            let scrapedData = "No deep data scraped, relying on search snippets.";

            await delay(1500); // Rate limit protection

            if (urlMatch && urlMatch[0]) {
                const targetUrl = urlMatch[0].replace(']', '').replace(')', '');
                emitUpdate(`Scraping primary source: ${targetUrl.substring(0, 30)}...`);
                
                const scrapeResult = await scrapeWebsiteTool.execute({ url: targetUrl });
                if (scrapeResult.success) {
                    scrapedData = scrapeResult.content;
                    emitUpdate(`Extracted ${scrapedData.length} characters of raw data.`);
                } else {
                    emitUpdate(`Firewall blocked scraping. Proceeding with base data.`);
                }
            }

            await delay(1500); // Rate limit protection

            emitUpdate(`Synthesizing research into final report...`);

            const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
            
            let writerResponse = "";
            let retries = 3;
            
            while (retries > 0) {
                try {
                    // 🚀 Clear the status indicator right before the real stream begins!
                    if (socket) socket.emit('ai:agent:status', { status: null });

                    const stream = await mistral.chat.stream({
                        model: process.env.MISTRAL_MODEL || 'mistral-small-latest',
                        messages: [
                            { role: "system", content: "You are an expert Writer Agent. Turn raw scraped data into a beautifully formatted, highly detailed Markdown report. Use headers, bullet points, and bold text." },
                            { role: "user", content: `Write a comprehensive report on: ${args.topic}.\n\nSEARCH CONTEXT:\n${searchResults.content}\n\nDEEP SCRAPE CONTEXT:\n${scrapedData}` }
                        ]
                    });

                    for await (const chunk of stream) {
                        // Check for early aborts!
                        if (socket && socket.isInterrupted) {
                            console.log("[Swarm] Stream aborted by user.");
                            return { success: false, message: "Aborted." };
                        }

                        const content = chunk.data.choices[0].delta.content;
                        if (content) {
                            writerResponse += content;
                            if (socket) {
                                socket.emit('ai:tts:response:chunk', { chunk: content, displayText: content, isFinal: false });
                            }
                        }
                    }
                    break; 
                } catch (err) {
                    retries--;
                    emitUpdate(`API busy. Retrying... (${retries} attempts left)`);
                    await delay(3000);
                    if (retries === 0) throw new Error("Writer Agent failed after 3 attempts.");
                }
            }

            console.log(`[Manager Agent] Swarm execution complete.`);

            return {
                success: true,
                message: "The Multi-Agent Swarm successfully wrote the report and streamed it directly to the user's screen. Do NOT repeat the report. Just ask the user if they need any revisions."
            };

        } catch (error) {
            console.error(`[Tool: deepResearchSwarm] Error:`, error);
            if (socket) socket.emit('ai:agent:status', { status: null }); // Clear on error
            return {
                success: false,
                error: `The Swarm encountered a fatal error: ${error.message}`
            };
        }
    }
};