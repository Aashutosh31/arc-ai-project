'use strict';

// Agensi marketplace skill — isolated read-only HTTP surface.
//
// POST /api/agensi/skill/query
// Body: { "query": "string", "auth_token": "string" }
//
// This router is mounted ABOVE the global 8 MB JSON parser (see server/index.js)
// so its own 16 KB cap is authoritative. It is intentionally the only HTTP
// surface the packaged SKILL.md can reach. It cannot execute tools, run code,
// read the filesystem, call MCP servers, write conversations/memory, consume
// credits, or touch the JARVIS approval layers. The model call happens in
// AIService.answerAgensiQuery(), which is a dedicated method — NOT
// processQuery().
const express = require('express');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const AIService = require('../services/AIService');
const { requireAgensiToken } = require('../middleware/agensiAuth');

const MAX_BODY_BYTES = 16 * 1024;

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const MAX_QUERY_CHARS = clampInt(process.env.AGENSI_MAX_QUERY_CHARS, 2000, 1, 8000);
const REQUEST_TIMEOUT_MS = clampInt(process.env.AGENSI_REQUEST_TIMEOUT_MS, 30000, 1000, 120000);

const router = express.Router();

// Per-IP cost guard. This runs before token validation so an unauthenticated
// caller cannot brute-force the static token or burn provider spend.
const agensiRateLimiter = rateLimit({
  windowMs: clampInt(process.env.AGENSI_RATE_WINDOW_MS, 60000, 1000, 3600000),
  limit: clampInt(process.env.AGENSI_RATE_LIMIT_MAX, 20, 1, 10000),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many skill requests. Retry later.',
      code: 'AGENSI.RATE_LIMITED'
    });
  }
});

// Process-wide daily ceiling. This is a second, independent cost stop for
// token holders that rotate IPs. It is intentionally in-memory and therefore
// per-instance; a multi-instance deployment should back it with a shared
// counter (see agensi-security-review.md).
const dailyCap = (() => {
  const cap = clampInt(process.env.AGENSI_DAILY_REQUEST_CAP, 1000, 0, 1000000);
  let currentDay = new Date().toISOString().slice(0, 10);
  let count = 0;

  return (req, res, next) => {
    if (cap <= 0) return next();

    const today = new Date().toISOString().slice(0, 10);
    if (today !== currentDay) {
      currentDay = today;
      count = 0;
    }

    if (count >= cap) {
      return res.status(429).json({
        error: 'The daily skill quota has been reached. Retry tomorrow.',
        code: 'AGENSI.DAILY_CAP'
      });
    }

    count += 1;
    return next();
  };
})();

router.post('/skill/query', agensiRateLimiter, requireAgensiToken, dailyCap, async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  res.set('Cache-Control', 'no-store');
  res.set('X-Request-Id', requestId);
  res.set('X-Content-Type-Options', 'nosniff');

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : null;

  if (!body || typeof body.query !== 'string') {
    return res.status(400).json({
      error: 'A JSON body with a string "query" field is required.',
      code: 'AGENSI.INVALID_REQUEST',
      request_id: requestId
    });
  }

  const query = body.query.replace(/\u0000/g, ' ').trim();
  if (!query) {
    return res.status(400).json({
      error: 'The query must not be empty.',
      code: 'AGENSI.INVALID_REQUEST',
      request_id: requestId
    });
  }
  if (query.length > MAX_QUERY_CHARS) {
    return res.status(400).json({
      error: `The query must be ${MAX_QUERY_CHARS} characters or fewer.`,
      code: 'AGENSI.QUERY_TOO_LONG',
      request_id: requestId
    });
  }

  let timeoutHandle = null;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const timeoutError = new Error('The skill request timed out.');
        timeoutError.code = 'AGENSI.TIMEOUT';
        reject(timeoutError);
      }, REQUEST_TIMEOUT_MS);
    });

    const result = await Promise.race([
      AIService.answerAgensiQuery(query),
      timeoutPromise
    ]);

    if (!result || typeof result.answer !== 'string' || !result.answer.trim()) {
      const error = new Error('The model returned an empty answer.');
      error.code = 'AGENSI_EMPTY_RESPONSE';
      throw error;
    }

    return res.status(200).json({
      answer: result.answer,
      meta: {
        provider: result.provider || null,
        model: result.model || null,
        memory_used: Boolean(result.memoryUsed),
        request_id: requestId
      }
    });
  } catch (error) {
    if (error && error.code === 'AGENSI.TIMEOUT') {
      return res.status(504).json({
        error: 'The skill request timed out.',
        code: 'AGENSI.TIMEOUT',
        request_id: requestId
      });
    }

    // Provider/internal detail stays server-side. Buyers receive a stable,
    // non-enumerating error contract.
    console.error('[Agensi] query failed', {
      requestId,
      token: req.agensi ? req.agensi.tokenHash : null,
      code: error && error.code ? error.code : 'AGENSI.PROVIDER_ERROR',
      message: String(error && error.message ? error.message : error).slice(0, 240)
    });

    return res.status(502).json({
      error: 'The skill could not produce an answer. Retry later.',
      code: 'AGENSI.PROVIDER_ERROR',
      request_id: requestId
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Never log the query, the answer, or the token. Only shape and timing.
    console.info('[Agensi] query', {
      requestId,
      token: req.agensi ? req.agensi.tokenHash : null,
      chars: query.length,
      status: res.statusCode,
      ms: Date.now() - startedAt
    });
  }
});

// Body-parser failures (oversized or malformed JSON) must stay JSON, not the
// default Express HTML error page.
router.use((error, _req, res, next) => {
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'The request body is too large.',
      code: 'AGENSI.TOO_LARGE'
    });
  }
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'The request body is not valid JSON.',
      code: 'AGENSI.INVALID_JSON'
    });
  }
  return next(error);
});

module.exports = router;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
