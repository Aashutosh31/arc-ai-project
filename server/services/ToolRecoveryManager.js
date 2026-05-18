const TaskExecutor = require('./TaskExecutor');

const TRANSIENT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /rate limit/i,
  /capacity exceeded/i,
  /temporar/i,
  /unavailable/i,
  /503/i,
  /502/i,
  /500/i
];

const AUTH_PATTERNS = [/unauthori[sz]ed/i, /forbidden/i, /api key/i, /auth/i, /permission/i];
const PARSE_PATTERNS = [/parse/i, /malformed/i, /invalid json/i, /unexpected token/i];
const NOT_FOUND_PATTERNS = [/404/i, /not found/i, /failed to access website/i, /http status:\s*404/i];

const safeText = (value) => String(value || '').trim();

const failureText = (result, error) => {
  if (error) return safeText(error?.message || error);
  if (!result) return '';
  return safeText(result.error || result.message || result.summary || result.content || '');
};

const matchesAny = (text, patterns) => patterns.some((pattern) => pattern.test(text));

const slugFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).join(' ');
  } catch {
    return String(url || '').replace(/^https?:\/\//i, '').replace(/[/?#&=_-]+/g, ' ');
  }
};

const buildScrapeCandidates = (url) => {
  const candidates = [];
  try {
    const parsed = new URL(url);
    const root = `${parsed.protocol}//${parsed.host}`;
    const segments = parsed.pathname.split('/').filter(Boolean);

    const add = (candidate) => {
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };

    add(url);
    add(`${root}${parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`}`);
    if (segments.length > 1) {
      add(`${root}/${segments.slice(0, -1).join('/')}/`);
    }
    if (segments.length > 2) {
      add(`${root}/${segments.slice(0, -2).join('/')}/`);
    }
    add(root);
    return candidates;
  } catch {
    return [url];
  }
};

class ToolRecoveryManager {
  classifyFailure({ toolName, args = {}, result = null, error = null }) {
    const text = failureText(result, error);
    const lower = text.toLowerCase();

    if (result?.blocked || result?.status === 'BLOCKED' || lower.includes('out of credits') || lower.includes('insufficient credits')) {
      return {
        type: 'blocked',
        shouldRetry: false,
        shouldFallback: false,
        shouldReplan: false,
        strategy: 'blocked',
        reason: text || 'insufficient credits'
      };
    }

    if (!text) {
      return {
        type: 'unknown',
        shouldRetry: false,
        shouldFallback: false,
        shouldReplan: true,
        strategy: 'replan',
        reason: 'empty failure payload'
      };
    }

    if (matchesAny(text, AUTH_PATTERNS)) {
      return { type: 'auth', shouldRetry: false, shouldFallback: false, shouldReplan: true, strategy: 'replan', reason: text };
    }

    if (matchesAny(text, PARSE_PATTERNS)) {
      return { type: 'parse', shouldRetry: true, shouldFallback: true, shouldReplan: false, strategy: 'retry-or-fallback', reason: text };
    }

    if (matchesAny(text, TRANSIENT_PATTERNS)) {
      return { type: 'transient', shouldRetry: true, shouldFallback: true, shouldReplan: false, strategy: 'retry', reason: text };
    }

    if (matchesAny(text, NOT_FOUND_PATTERNS)) {
      if (toolName === 'scrapeWebsite') {
        return { type: 'http_404', shouldRetry: true, shouldFallback: true, shouldReplan: false, strategy: 'scrape-fallback', reason: text };
      }
      return { type: 'not_found', shouldRetry: false, shouldFallback: false, shouldReplan: true, strategy: 'replan', reason: text };
    }

    if (lower.includes('invalid') || lower.includes('bad request') || lower.includes('malformed')) {
      return { type: 'malformed', shouldRetry: true, shouldFallback: true, shouldReplan: false, strategy: 'retry-or-fallback', reason: text };
    }

    return { type: 'unknown', shouldRetry: false, shouldFallback: false, shouldReplan: true, strategy: 'replan', reason: text };
  }

  async recoverToolResult({ toolName, args = {}, result = null, error = null, userId, socket = null, signal = null, retryCount = 0, workspaceId = null }) {
    const classification = this.classifyFailure({ toolName, args, result, error });
    console.log('[ToolRecoveryManager] decision', {
      toolName,
      retryCount,
      classification,
      hasError: Boolean(error),
      hasResult: Boolean(result),
      cancelled: Boolean(signal?.aborted)
    });
    const update = {
      retryCount,
      failureReason: classification.reason,
      recovered: false,
      recoveryStrategy: classification.strategy
    };

    const canRetry = classification.shouldRetry && retryCount < 2;

    if (classification.type === 'blocked') {
      console.log('[ToolRecoveryManager] blocked without recovery', {
        toolName,
        reason: classification.reason
      });
      return {
        ...update,
        shouldReplan: false,
        classification,
        result: result || error || null,
        blocked: true
      };
    }

    if (canRetry) {
      if (socket) {
        socket.emit('ai:agent:status', {
          status: 'recovery',
          detail: `Retrying ${toolName} after ${classification.type} failure.`
        });
      }

      const retryResult = await TaskExecutor.executeTool(toolName, args, userId, socket, { signal, skipCreditCharge: true, workspaceId });
      if (retryResult?.success) {
        console.log('[ToolRecoveryManager] retry success', {
          toolName,
          retryCount: retryCount + 1,
          strategy: 'retry'
        });
        return {
          ...update,
          retryCount: retryCount + 1,
          recovered: true,
          recoveryStrategy: 'retry',
          result: retryResult,
          classification
        };
      }

      const nestedFailure = this.classifyFailure({ toolName, args, result: retryResult, error: null });
      update.retryCount = retryCount + 1;
      update.failureReason = nestedFailure.reason;
      update.recoveryStrategy = nestedFailure.strategy;
    }

    if (classification.type === 'http_404' && toolName === 'scrapeWebsite') {
      const candidates = buildScrapeCandidates(args.url);
      for (const candidateUrl of candidates.slice(1)) {
        if (socket) {
          socket.emit('ai:agent:status', {
            status: 'recovery',
            detail: `Trying alternate route for ${candidateUrl}`
          });
        }

        const scrapeResult = await TaskExecutor.executeTool(
          'scrapeWebsite',
          { ...args, url: candidateUrl },
          userId,
          socket,
          { signal, skipCreditCharge: true, workspaceId }
        );

        if (scrapeResult?.success) {
          console.log('[ToolRecoveryManager] fallback success', {
            toolName,
            strategy: 'scrape-fallback',
            candidateUrl
          });
          return {
            ...update,
            recovered: true,
            recoveryStrategy: 'scrape-fallback',
            result: scrapeResult,
            classification
          };
        }
      }

      const searchQuery = slugFromUrl(args.url);
      if (searchQuery) {
        if (socket) {
          socket.emit('ai:agent:status', {
            status: 'recovery',
            detail: `Searching for an alternate source for ${searchQuery}`
          });
        }

        const searchResult = await TaskExecutor.executeTool(
          'webSearch',
          { query: searchQuery },
          userId,
          socket,
          { signal, skipCreditCharge: true, workspaceId }
        );

        if (searchResult?.success) {
          console.log('[ToolRecoveryManager] fallback success', {
            toolName,
            strategy: 'fallback:webSearch',
            query: searchQuery
          });
          return {
            ...update,
            recovered: true,
            recoveryStrategy: 'fallback:webSearch',
            result: searchResult,
            classification
          };
        }
      }
    }

    console.log('[ToolRecoveryManager] recovery exhausted', {
      toolName,
      classification,
      retryCount,
      shouldReplan: classification.shouldReplan
    });

    return {
      ...update,
      shouldReplan: classification.shouldReplan,
      classification,
      result: result || error || null
    };
  }
}

module.exports = new ToolRecoveryManager();
