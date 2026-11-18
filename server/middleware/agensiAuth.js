'use strict';

// Agensi marketplace skill — static-token gate.
//
// This is a SEPARATE trust boundary from ARC-AI's user auth. It never reads
// JWTs, cookies, guest sessions, or req.user. The only credential it accepts is
// the marketplace skill token provisioned out-of-band by Agensi, compared in
// constant time against server-only environment variables.
//
// Token sources, in order:
//   1. JSON body `auth_token` (the documented SKILL.md contract)
//   2. `Authorization: Bearer <token>` (convenience for generic HTTP agents)
//
// Query-string tokens are deliberately NOT accepted: they leak through access
// logs, proxies, browser history, and referrers.
const crypto = require('crypto');

const MIN_SECRET_LENGTH = 24;
const MAX_TOKEN_CHARS = 512;

const getConfiguredSecrets = () => [
  process.env.AGENSI_SKILL_SECRET,
  process.env.AGENSI_SKILL_SECRET_PREVIOUS
]
  .map((value) => (typeof value === 'string' ? value.trim() : ''))
  .filter(Boolean);

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest();

// Hash-then-compare keeps the comparison fixed-width, so token length is not a
// timing oracle. Every configured secret is evaluated (no early exit on match).
const safeEqual = (left, right) => crypto.timingSafeEqual(hashToken(left), hashToken(right));

const extractToken = (req) => {
  const bodyToken = req.body && typeof req.body.auth_token === 'string'
    ? req.body.auth_token.trim()
    : '';
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const headerToken = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';

  if (bodyToken && headerToken && bodyToken !== headerToken) {
    return { token: '', conflict: true };
  }

  return { token: bodyToken || headerToken, conflict: false };
};

const unavailable = (res) => res.status(503).json({
  error: 'The Agensi skill endpoint is not available.',
  code: 'AGENSI.DISABLED'
});

const requireAgensiToken = (req, res, next) => {
  if (String(process.env.AGENSI_SKILL_ENABLED || 'true').toLowerCase() === 'false') {
    return unavailable(res);
  }

  const secrets = getConfiguredSecrets();
  if (secrets.length === 0) {
    console.error('[Agensi] AGENSI_SKILL_SECRET is not configured; failing closed.');
    return unavailable(res);
  }
  if (secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
    console.error(`[Agensi] AGENSI_SKILL_SECRET must be at least ${MIN_SECRET_LENGTH} characters; failing closed.`);
    return unavailable(res);
  }

  const { token, conflict } = extractToken(req);
  if (conflict) {
    return res.status(401).json({
      error: 'Conflicting skill tokens were supplied.',
      code: 'AGENSI.UNAUTHORIZED'
    });
  }
  if (!token || token.length > MAX_TOKEN_CHARS) {
    return res.status(401).json({
      error: 'A valid skill token is required.',
      code: 'AGENSI.UNAUTHORIZED'
    });
  }

  let matched = false;
  for (const secret of secrets) {
    matched = safeEqual(token, secret) || matched;
  }

  if (!matched) {
    return res.status(401).json({
      error: 'A valid skill token is required.',
      code: 'AGENSI.UNAUTHORIZED'
    });
  }

  // A buyer might paste the token into the prompt by mistake. Reject before the
  // query can reach an LLM provider or a log line. The token itself is never
  // logged or echoed.
  const query = req.body && typeof req.body.query === 'string' ? req.body.query : '';
  for (const secret of secrets) {
    if (query.includes(secret)) {
      console.warn('[Agensi] rejected a query that contained the skill token.');
      return res.status(400).json({
        error: 'Do not include the access token in the query.',
        code: 'AGENSI.TOKEN_IN_QUERY'
      });
    }
  }

  // Only a truncated hash is retained for correlation. The raw token is not
  // stored on the request, so downstream code and logs cannot leak it.
  req.agensi = { tokenHash: hashToken(token).toString('hex').slice(0, 12) };
  return next();
};

module.exports = {
  requireAgensiToken,
  getConfiguredSecrets,
  MIN_SECRET_LENGTH
};
