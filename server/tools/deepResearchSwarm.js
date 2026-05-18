const webSearchTool = require('./webSearch');
const scrapeWebsiteTool = require('./scrapeWebsite');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const LLMRouter = require('../lib/llm/LLMRouter');
const StreamingRuntime = require('../lib/llm/StreamingRuntime');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const classifyFailureCause = (errorOrResult) => {
    const text = String(errorOrResult?.error || errorOrResult?.message || errorOrResult || '').toLowerCase();
    const status = Number(errorOrResult?.statusCode || errorOrResult?.status || 0);

    if (!text && !status) return 'unknown';
    if (errorOrResult?.name === 'AbortError' || text.includes('aborted') || text.includes('interrupted') || text.includes('socket_interrupted')) return 'abort_signal';
    if (status === 401 || status === 403 || text.includes('api key') || text.includes('unauthor') || text.includes('forbidden')) return 'missing_api_key_or_auth';
    if (status === 429 || text.includes('rate limit') || text.includes('too many requests') || text.includes('capacity exceeded')) return 'rate_limit';
    if (status >= 500 || text.includes('unavailable') || text.includes('502') || text.includes('503') || text.includes('timeout') || text.includes('network')) return 'provider_timeout_or_unavailable';
    if (text.includes('parse') || text.includes('malformed') || text.includes('unexpected token') || text.includes('invalid json')) return 'parsing_failure';
    if (text.includes('invalid') || text.includes('bad request') || text.includes('unsupported') || text.includes('tool output')) return 'invalid_tool_output';
    if (text.includes('not found') || text.includes('404')) return 'not_found';
    return 'unknown';
};

const safePreview = (value, maxLength = 240) => {
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return String(text || '').slice(0, maxLength);
    } catch {
        return '[unserializable payload]';
    }
};

const logSwarm = (event, payload = {}) => {
    console.log('[Tool: deepResearchSwarm]', JSON.stringify({ event, ...payload }));
};

const persistSwarmDraft = async ({ conversationId, userId, workspaceId, provider, model, content, state = 'streaming', interrupted = false, messageIdRef }) => {
    if (!conversationId || !userId) return messageIdRef?.current || null;

    const normalizedContent = String(content || '');
    const existingMessageId = messageIdRef?.current || null;

    if (!existingMessageId) {
        const draftMessage = await Message.create({
            conversationId,
            workspaceId: workspaceId || null,
            role: 'ai',
            content: normalizedContent,
            provider: provider || null,
            model: model || null,
            metadata: {
                tokens: { input: 0, output: 0 },
                streaming: !interrupted,
                interrupted,
                partial: true,
                state
            }
        });

        if (messageIdRef) {
            messageIdRef.current = draftMessage._id;
        }

        await Conversation.findByIdAndUpdate(conversationId, {
            lastMessage: {
                content: normalizedContent.substring(0, 100),
                role: 'ai',
                timestamp: new Date()
            }
        });

        return draftMessage._id;
    }

    await Message.findByIdAndUpdate(existingMessageId, {
        content: normalizedContent,
        provider: provider || null,
        model: model || null,
        metadata: {
            tokens: { input: 0, output: 0 },
            streaming: !interrupted,
            interrupted,
            partial: true,
            state
        }
    });

    await Conversation.findByIdAndUpdate(conversationId, {
        lastMessage: {
            content: normalizedContent.substring(0, 100),
            role: 'ai',
            timestamp: new Date()
        }
    });

    return existingMessageId;
};

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
        const startedAt = Date.now();
        const topic = String(args?.topic || '').trim();
        logSwarm('start', {
            topic,
            userId: context?.userId || context?.id || context?._id || null,
            hasSignal: Boolean(context?.signal),
            isInterrupted: Boolean(socket?.isInterrupted)
        });
        const llmRouter = new LLMRouter();
        const streamingRuntime = new StreamingRuntime();
        const upstreamSignal = context?.signal || null;
        const conversationId = context?.conversationId || null;
        const workspaceId = context?.workspaceId || null;
        const userId = context?.userId || context?.id || context?._id || null;
        const localAbortController = new AbortController();
        const draftMessageIdRef = { current: null };
        const draftContentRef = { current: '' };
        let streamProvider = null;
        let streamModel = null;

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
                logSwarm('abort.detected', { source: 'socket.isInterrupted' });
                localAbortController.abort('socket_interrupted');
            }
        }, 150);

        const emitUpdate = (text) => {
            logSwarm('status', { detail: text });
            if (socket) {
                // 🚀 Emits the live status strictly to the UI (does not pollute the chat log)
                socket.emit('ai:agent:status', { status: text });
            }
            console.log(text);
        };

        try {
            if (localAbortController.signal.aborted) {
                logSwarm('abort.before_start', { cause: classifyFailureCause({ name: 'AbortError', message: 'Swarm execution interrupted before start.' }) });
                throw new Error('Swarm execution interrupted before start.');
            }

            emitUpdate(`Assigning topic: "${args.topic}" to the Swarm...`);
            await delay(1000);

            emitUpdate(`Searching the web for latest data...`);
            logSwarm('tool.start', { tool: 'webSearch', query: `${topic} latest news comprehensive overview` });
            const searchStartedAt = Date.now();
            const searchResults = await webSearchTool.execute({ query: topic + " latest news comprehensive overview" });
            logSwarm('tool.result', {
                tool: 'webSearch',
                durationMs: Date.now() - searchStartedAt,
                success: Boolean(searchResults?.success),
                payloadPreview: safePreview(searchResults)
            });

            if (!searchResults?.success) {
                logSwarm('tool.failure', {
                    tool: 'webSearch',
                    cause: classifyFailureCause(searchResults),
                    payloadPreview: safePreview(searchResults)
                });
            }
            
            const urlMatch = searchResults.content ? searchResults.content.match(/https?:\/\/[^\s]+/) : null;
            let scrapedData = "No deep data scraped, relying on search snippets.";

            await delay(1500); // Rate limit protection

            if (urlMatch && urlMatch[0]) {
                const targetUrl = urlMatch[0].replace(']', '').replace(')', '');
                emitUpdate(`Scraping primary source: ${targetUrl.substring(0, 30)}...`);

                logSwarm('tool.start', { tool: 'scrapeWebsite', url: targetUrl });
                const scrapeStartedAt = Date.now();
                const scrapeResult = await scrapeWebsiteTool.execute({ url: targetUrl });
                logSwarm('tool.result', {
                    tool: 'scrapeWebsite',
                    durationMs: Date.now() - scrapeStartedAt,
                    success: Boolean(scrapeResult?.success),
                    payloadPreview: safePreview(scrapeResult)
                });
                if (scrapeResult.success) {
                    scrapedData = scrapeResult.content;
                    emitUpdate(`Extracted ${scrapedData.length} characters of raw data.`);
                } else {
                    logSwarm('fallback.activation', {
                        tool: 'scrapeWebsite',
                        cause: classifyFailureCause(scrapeResult),
                        payloadPreview: safePreview(scrapeResult)
                    });
                    emitUpdate(`Firewall blocked scraping. Proceeding with base data.`);
                }
            }

            await delay(1500); // Rate limit protection

            emitUpdate(`Synthesizing research into final report...`);

            if (socket) socket.emit('ai:agent:status', { status: null });

            logSwarm('provider.request', {
                provider: 'llmRouter.generate',
                stream: true,
                topic,
                searchPreview: safePreview(searchResults?.content || searchResults?.summary || searchResults?.message),
                scrapePreview: safePreview(scrapedData)
            });

            let generation;
            try {
                const generationStartedAt = Date.now();
                generation = await llmRouter.generate({
                    messages: [
                        {
                            role: 'user',
                            content: `Write a comprehensive report on: ${topic}.\n\nSEARCH CONTEXT:\n${searchResults.content}\n\nDEEP SCRAPE CONTEXT:\n${scrapedData}`
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
                logSwarm('provider.response', {
                    provider: generation?.provider || null,
                    model: generation?.model || null,
                    durationMs: Date.now() - generationStartedAt,
                    hasStream: Boolean(generation?.stream)
                });
                streamProvider = generation?.provider || null;
                streamModel = generation?.model || null;
            } catch (error) {
                logSwarm('provider.failure', {
                    cause: classifyFailureCause(error),
                    statusCode: error?.statusCode || error?.status || null,
                    message: error?.message || String(error),
                    provider: generation?.provider || null,
                    model: generation?.model || null
                });
                throw error;
            }

            let writerResponse;
            try {
                const consumeStartedAt = Date.now();
                writerResponse = await streamingRuntime.consume(generation.stream, socket, localAbortController.signal, async (chunkText) => {
                    draftContentRef.current += chunkText;
                    logSwarm('draft.chunk', {
                        conversationId: conversationId ? String(conversationId) : null,
                        contentLength: draftContentRef.current.length
                    });
                    await persistSwarmDraft({
                        conversationId,
                        userId,
                        workspaceId,
                        provider: streamProvider,
                        model: streamModel,
                        content: draftContentRef.current,
                        state: 'streaming',
                        interrupted: false,
                        messageIdRef: draftMessageIdRef
                    });
                });
                logSwarm('stream.consume.complete', {
                    durationMs: Date.now() - consumeStartedAt,
                    resultPreview: safePreview(writerResponse)
                });
            } catch (error) {
                if (localAbortController.signal.aborted || socket?.isInterrupted) {
                    try {
                        logSwarm('draft.abort.finalize', {
                            conversationId: conversationId ? String(conversationId) : null,
                            contentLength: draftContentRef.current.length
                        });
                        await persistSwarmDraft({
                            conversationId,
                            userId,
                            workspaceId,
                            provider: streamProvider,
                            model: streamModel,
                            content: draftContentRef.current || writerResponse || '',
                            state: 'cancelled',
                            interrupted: true,
                            messageIdRef: draftMessageIdRef
                        });
                    } catch (persistErr) {
                        logSwarm('draft.abort.persist_failure', {
                            message: persistErr?.message || String(persistErr)
                        });
                    }
                }
                logSwarm('stream.consume.failure', {
                    cause: classifyFailureCause(error),
                    message: error?.message || String(error)
                });
                throw error;
            }

            if (conversationId && draftMessageIdRef.current) {
                try {
                    logSwarm('draft.finalize.complete', {
                        conversationId: String(conversationId),
                        messageId: String(draftMessageIdRef.current),
                        contentLength: draftContentRef.current.length
                    });
                    await Message.findByIdAndUpdate(draftMessageIdRef.current, {
                        content: draftContentRef.current,
                        provider: streamProvider,
                        model: streamModel,
                        metadata: {
                            tokens: { input: 0, output: 0 },
                            streaming: false,
                            interrupted: false,
                            partial: false,
                            state: 'final'
                        }
                    });
                } catch (persistErr) {
                    logSwarm('draft.finalize.persist_failure', {
                        message: persistErr?.message || String(persistErr)
                    });
                }
            }

            logSwarm('complete', {
                durationMs: Date.now() - startedAt,
                resultPreview: safePreview(writerResponse)
            });

            return {
                success: true,
                message: "The Multi-Agent Swarm successfully wrote the report and streamed it directly to the user's screen. Do NOT repeat the report. Just ask the user if they need any revisions."
            };

        } catch (error) {
            logSwarm('failure', {
                durationMs: Date.now() - startedAt,
                cause: classifyFailureCause(error),
                name: error?.name || null,
                statusCode: error?.statusCode || error?.status || null,
                message: error?.message || String(error),
                payloadPreview: safePreview(error?.result || error?.payload || null)
            });
            console.error(`[Tool: deepResearchSwarm] Error:`, error);
            if (socket) socket.emit('ai:agent:status', { status: null }); // Clear on error
            return {
                success: false,
                error: `The Swarm encountered a fatal error at ${classifyFailureCause(error)}: ${error.message}`,
                diagnostic: {
                    cause: classifyFailureCause(error),
                    name: error?.name || null,
                    statusCode: error?.statusCode || error?.status || null,
                    message: error?.message || String(error)
                }
            };
        } finally {
            clearInterval(interruptionWatcher);
            if (typeof signalCleanup === 'function') {
                signalCleanup();
            }
        }
    }
};