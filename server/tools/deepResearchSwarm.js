const webSearchTool = require('./webSearch');
const scrapeWebsiteTool = require('./scrapeWebsite');
const LLMRouter = require('../lib/llm/LLMRouter');
const StreamingRuntime = require('../lib/llm/StreamingRuntime');

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
    
    execute: async (args, context = {}, socket) => {
        console.log(`[Swarm Orchestrator] Spinning up multi-agent swarm for: ${args.topic}`);
        const llmRouter = new LLMRouter();
        const streamingRuntime = new StreamingRuntime();
        const upstreamSignal = context?.signal || null;
        const userId = context?.userId || context?.id || context?._id || null;
        const localAbortController = new AbortController();

        let signalCleanup = null;
        if (upstreamSignal) {
            const onAbort = () => localAbortController.abort('upstream_aborted');
            if (upstreamSignal.aborted) {
                localAbortController.abort('upstream_aborted');
            } else {
                upstreamSignal.addEventListener('abort', onAbort, { once: true });
                signalCleanup = () => upstreamSignal.removeEventListener('abort', onAbort);
            }
        }

        const interruptionWatcher = setInterval(() => {
            if (socket && socket.isInterrupted && !localAbortController.signal.aborted) {
                localAbortController.abort('socket_interrupted');
            }
        }, 150);

        const emitUpdate = (text) => {
            if (socket) {
                // 🚀 Emits the live status strictly to the UI (does not pollute the chat log)
                socket.emit('ai:agent:status', { status: text });
            }
            console.log(text);
        };

        try {
            if (localAbortController.signal.aborted) {
                throw new Error('Swarm execution interrupted before start.');
            }

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

            if (socket) socket.emit('ai:agent:status', { status: null });

            const generation = await llmRouter.generate({
                messages: [
                    {
                        role: 'user',
                        content: `Write a comprehensive report on: ${args.topic}.\n\nSEARCH CONTEXT:\n${searchResults.content}\n\nDEEP SCRAPE CONTEXT:\n${scrapedData}`
                    }
                ],
                systemPrompt: 'You are an expert Writer Agent. Turn raw scraped data into a beautifully formatted, highly detailed Markdown report. Use headers, bullet points, and bold text.',
                stream: true,
                temperature: 0.2,
                userContext: {
                    userId,
                    taskHint: 'deep research report generation'
                },
                signal: localAbortController.signal
            });

            const writerResponse = await streamingRuntime.consume(generation.stream, socket, localAbortController.signal);

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
        } finally {
            clearInterval(interruptionWatcher);
            if (typeof signalCleanup === 'function') {
                signalCleanup();
            }
        }
    }
};