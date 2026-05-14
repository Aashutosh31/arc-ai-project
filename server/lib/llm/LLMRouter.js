const providerRegistry = require('./providers');
const StreamingRuntime = require('./StreamingRuntime');
const {
  classifyProviderFailure,
  inferTaskProfile,
  extractTextFromContent
} = require('./utils');

class LLMRouter {
  constructor() {
    this.streamingRuntime = new StreamingRuntime();
    this.providerStats = new Map();
    this.defaultProvider = String(process.env.LLM_PRIMARY_PROVIDER || 'auto').toLowerCase();
    this.fallbackProvider = String(process.env.LLM_FALLBACK_PROVIDER || '').toLowerCase();
  }

  requestNeedsMultimodal(request = {}) {
    return Array.isArray(request.attachments) && request.attachments.some((attachment) => attachment?.type === 'image');
  }

  providerSupportsRequest(provider, request = {}) {
    if (!provider) return false;
    if (typeof provider.canHandleRequest === 'function') {
      return Boolean(provider.canHandleRequest(request));
    }

    const needsMultimodal = this.requestNeedsMultimodal(request);
    if (!needsMultimodal) return true;

    return Boolean(provider?.capabilities?.multimodal);
  }

  getProviderStats(providerId) {
    if (!this.providerStats.has(providerId)) {
      this.providerStats.set(providerId, {
        providerId,
        successCount: 0,
        failureCount: 0,
        rateLimitCount: 0,
        lastLatencyMs: null,
        lastUsedAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        lastRoute: null
      });
    }

    return this.providerStats.get(providerId);
  }

  recordSuccess(providerId, latencyMs, route) {
    const stats = this.getProviderStats(providerId);
    stats.successCount += 1;
    stats.lastLatencyMs = latencyMs;
    stats.lastUsedAt = new Date().toISOString();
    stats.lastRoute = route;
  }

  recordFailure(providerId, error, route) {
    const stats = this.getProviderStats(providerId);
    const failure = classifyProviderFailure(error);
    stats.failureCount += 1;
    if (failure.isRateLimit) stats.rateLimitCount += 1;
    stats.lastErrorAt = new Date().toISOString();
    stats.lastErrorMessage = failure.message;
    stats.lastRoute = route;
  }

  logFallback(fromProvider, toProvider, reason) {
    console.warn(`[LLMRouter] Falling back from ${fromProvider} to ${toProvider}: ${reason}`);
  }

  buildProviderOrder(request, primaryProviderId) {
    const availableProviders = providerRegistry.getAvailableProviders();
    const providersById = new Map(availableProviders.map((provider) => [provider.id, provider]));
    const order = [];
    const needsMultimodal = this.requestNeedsMultimodal(request);

    const addById = (providerId) => {
      const provider = providersById.get(providerId);
      if (provider && !order.includes(provider)) {
        if (!this.providerSupportsRequest(provider, request)) {
          console.warn(`[LLMRouter] Skipping provider '${provider.id}' for unsupported request capabilities.`);
          return;
        }
        order.push(provider);
      }
    };

    const preferred = String(request.preferredProvider || '').trim().toLowerCase();
    const forced = String(process.env.LLM_FORCE_PROVIDER || '').trim().toLowerCase();

    if (forced) addById(forced);
    if (preferred) addById(preferred);
    if (primaryProviderId) addById(primaryProviderId);

    for (const provider of availableProviders) {
      if (!order.includes(provider)) {
        if (!this.providerSupportsRequest(provider, request)) {
          continue;
        }
        order.push(provider);
      }
    }

    if (order.length === 0) {
      if (needsMultimodal) {
        throw new Error('No multimodal-capable LLM providers are available for this request.');
      }
      throw new Error('No LLM providers are available. Configure GEMINI_API_KEY or MISTRAL_API_KEY.');
    }

    return order;
  }

  choosePrimaryProvider(request = {}) {
    const taskProfile = inferTaskProfile(request);
    const route = {
      taskProfile,
      hasTools: Array.isArray(request.tools) && request.tools.length > 0,
      hasAttachments: Array.isArray(request.attachments) && request.attachments.length > 0,
      messagePreview: extractTextFromContent(request.messages?.[request.messages.length - 1]?.content).slice(0, 120)
    };

    if (this.defaultProvider && this.defaultProvider !== 'auto') {
      return { providerId: this.defaultProvider, route };
    }

    // Use Gemini for heavy workloads: complex reasoning, multimodal, tool orchestration, long context
    if (taskProfile === 'multimodal' || taskProfile === 'tool_orchestration' || taskProfile === 'long_context') {
      return { providerId: 'gemini', route };
    }

    // Use Mistral for reasoning tasks (fast, reliable, cost-effective for most reasoning)
    // Use Gemini only if this is marked as truly complex
    if (taskProfile === 'reasoning') {
      return { providerId: 'mistral', route };
    }

    // Default to Mistral for lightweight and memory compression
    if (taskProfile === 'lightweight' || taskProfile === 'memory_compression') {
      return { providerId: 'mistral', route };
    }

    return { providerId: 'mistral', route };
  }

  isRetryable(error) {
    const failure = classifyProviderFailure(error);
    return failure.isTransient;
  }

  async generate(request = {}) {
    const { providerId, route } = this.choosePrimaryProvider(request);
    const providerOrder = this.buildProviderOrder(request, providerId);
    const telemetryRoute = {
      ...route,
      requestedProvider: providerId,
      stream: Boolean(request.stream),
      tools: Array.isArray(request.tools) ? request.tools.length : 0
    };

    console.log('[LLMRouter] route.selected', {
      requestedProvider: providerId,
      selectedProvider: providerOrder[0]?.id,
      profile: telemetryRoute.taskProfile,
      stream: telemetryRoute.stream,
      tools: telemetryRoute.tools,
      hasAttachments: telemetryRoute.hasAttachments
    });

    if (!this.providerSupportsRequest(providerOrder[0], request)) {
      const error = new Error(`Selected provider '${providerOrder[0]?.id}' cannot handle request capabilities.`);
      error.statusCode = 400;
      throw error;
    }

    if (request.stream) {
      const stream = this.createFallbackStream(providerOrder, request, telemetryRoute);
      return {
        provider: providerOrder[0].id,
        model: providerOrder[0].defaultModel || null,
        route: telemetryRoute,
        stream
      };
    }

    let lastError = null;

    for (let index = 0; index < providerOrder.length; index += 1) {
      const provider = providerOrder[index];
      const startedAt = Date.now();

      try {
        const result = await provider.generate(request);
        this.recordSuccess(provider.id, result.latencyMs || Date.now() - startedAt, telemetryRoute);

        const fallbackUsed = index > 0;
        if (fallbackUsed) {
          this.logFallback(providerOrder[0].id, provider.id, 'primary provider unavailable or rate-limited');
        }

        console.log('[LLMRouter] route.completed', {
          provider: provider.id,
          fallbackUsed,
          latencyMs: result.latencyMs || Date.now() - startedAt,
          profile: telemetryRoute.taskProfile
        });

        return {
          ...result,
          route: telemetryRoute,
          fallbackUsed,
          provider: provider.id
        };
      } catch (error) {
        this.recordFailure(provider.id, error, telemetryRoute);
        lastError = error;

        if (!this.isRetryable(error) || index === providerOrder.length - 1) {
          throw error;
        }

        const nextProvider = providerOrder[index + 1];
        this.logFallback(provider.id, nextProvider.id, classifyProviderFailure(error).message || 'transient failure');
      }
    }

    throw lastError || new Error('LLM generation failed.');
  }

  createFallbackStream(providerOrder, request, route) {
    const self = this;

    return (async function* fallbackStream() {
      for (let index = 0; index < providerOrder.length; index += 1) {
        const provider = providerOrder[index];
        const startedAt = Date.now();

        try {
          const result = await provider.generate({ ...request, stream: true });
          const source = result?.stream || result;
          let emittedChunk = false;

          try {
            for await (const chunk of source) {
              emittedChunk = true;
              yield {
                ...chunk,
                provider: provider.id,
                model: result?.model || chunk?.model || null
              };
            }
          } catch (streamError) {
            self.recordFailure(provider.id, streamError, route);
            if (emittedChunk || !self.isRetryable(streamError) || index === providerOrder.length - 1) {
              throw streamError;
            }

            if (!self.providerSupportsRequest(providerOrder[index + 1], request)) {
              const blockedFallbackError = new Error(`Invalid fallback path: '${providerOrder[index + 1]?.id}' cannot handle request capabilities.`);
              blockedFallbackError.statusCode = 400;
              throw blockedFallbackError;
            }

            self.logFallback(provider.id, providerOrder[index + 1].id, classifyProviderFailure(streamError).message || 'stream failure');
            continue;
          }

          self.recordSuccess(provider.id, result?.latencyMs || Date.now() - startedAt, route);
          console.log('[LLMRouter] stream.completed', {
            provider: provider.id,
            fallbackUsed: index > 0,
            latencyMs: result?.latencyMs || Date.now() - startedAt,
            profile: route.taskProfile
          });
          return;
        } catch (error) {
          self.recordFailure(provider.id, error, route);
          if (!self.isRetryable(error) || index === providerOrder.length - 1) {
            throw error;
          }

          self.logFallback(provider.id, providerOrder[index + 1].id, classifyProviderFailure(error).message || 'generation failure');
        }
      }
    })();
  }

  getHealthSnapshot() {
    return Array.from(this.providerStats.values());
  }
}

module.exports = LLMRouter;