/**
 * Generic OAuth UI-state helper for MCP server cards.
 *
 * Separates the three independent signals that one card renders:
 *   Transport:   disconnected | connected        (liveStatus.connectionState)
 *   Discovery:   no tools | tools discovered     (liveStatus.toolCount)
 *   Authorization: authorized | required | unknown (GET /oauth/status payload)
 *
 * Some OAuth MCP servers permit anonymous `initialize` + `tools/list` while
 * gating actual tool calls behind OAuth. For those servers the transport can
 * be CONNECTED with tools discovered while no credential exists. Treating
 * "connected" as "authorized" hides the only recovery path, so the Authorize
 * affordance MUST be driven by the authorization signal, never by the
 * transport/discovery signals.
 *
 * Pure + generic: no server names, URLs, or tool names appear here. Inputs
 * are the sanitized shapes the API already returns.
 */

/**
 * @param {object} args
 * @param {string} args.authType - sanitized `server.auth.type` ('oauth' | 'header' | 'none')
 * @param {string} args.connectionState - live status ('connected' | 'connecting' | 'disconnected')
 * @param {number} args.toolCount - live discovered tool count
 * @param {object|null|undefined} args.oauthStatus - GET /:id/oauth/status payload (undefined = not yet loaded)
 * @returns {{ connected: boolean, hasTools: boolean, authState: 'authorized'|'required'|'unknown'|'not_oauth'|'private', showAuthorize: boolean, authorizeLabel: 'Authorize'|'Reauthorize', statusTone: 'ok'|'warn'|'unknown' }}
 */
export const getOAuthUiState = ({ authType, connectionState, toolCount, oauthStatus } = {}) => {
  const connected = connectionState === 'connected';
  const hasTools = Number(toolCount) > 0;

  if (authType !== 'oauth') {
    return {
      connected,
      hasTools,
      authState: 'not_oauth',
      showAuthorize: false,
      authorizeLabel: 'Authorize',
      statusTone: 'unknown',
    };
  }

  // Authorization is private to the owning account; the API answers
  // { authorized: false, reason: 'not_owner' } — offering Authorize would
  // 403 on /oauth/start, so keep it hidden like the credential itself.
  if (oauthStatus && oauthStatus.reason === 'not_owner') {
    return {
      connected,
      hasTools,
      authState: 'private',
      showAuthorize: false,
      authorizeLabel: 'Authorize',
      statusTone: 'unknown',
    };
  }

  if (oauthStatus && oauthStatus.authorized === true) {
    return {
      connected,
      hasTools,
      authState: 'authorized',
      showAuthorize: false,
      authorizeLabel: 'Reauthorize',
      statusTone: 'ok',
    };
  }

  if (oauthStatus && oauthStatus.authorized === false) {
    return {
      connected,
      hasTools,
      // Explicitly unauthorized — Authorize stays visible EVEN when the
      // transport is already connected with tools discovered. The user must
      // be able to authorize an already-connected server (no disconnect first).
      authState: 'required',
      showAuthorize: true,
      authorizeLabel: oauthStatus.expired ? 'Reauthorize' : 'Authorize',
      statusTone: 'warn',
    };
  }

  // Status not yet loaded (unknown): preserve the legacy connected-gate so we
  // don't flash Authorize on every OAuth card before its status resolves.
  const showAuthorize = !(connected || hasTools);
  return {
    connected,
    hasTools,
    authState: 'unknown',
    showAuthorize,
    authorizeLabel: 'Authorize',
    statusTone: 'unknown',
  };
};

/**
 * Status-line copy for the OAuth metadata row. Same generic inputs.
 * @returns {{ tone: 'ok'|'warn'|'muted', text: string|null }}
 */
export const getOAuthStatusLine = ({ authType, connectionState, oauthStatus } = {}) => {  if (authType !== 'oauth') return { tone: 'muted', text: null };
  if (oauthStatus === undefined) return { tone: 'muted', text: null };
  if (!oauthStatus || oauthStatus.oauth === false) return { tone: 'muted', text: null };
  if (oauthStatus.reason === 'not_owner') {
    return { tone: 'muted', text: 'OAuth authorization is private to the owning account.' };
  }
  if (oauthStatus.authorized) return { tone: 'ok', text: null }; // caller renders the authorized detail line
  if (connectionState === 'connected') {
    return { tone: 'warn', text: 'Connected — authorization required — click Authorize to authorize this server.' };
  }
  return { tone: 'warn', text: 'Authorization required — connect, then authorize in your browser.' };
};

/**
 * User-first connection readiness. Transport, authorization, and discovery
 * are independent signals — CONNECTED with zero tools is NOT ready unless
 * discovery genuinely found nothing.
 *
 * @param {object} args
 * @param {string} args.connectionState - live status
 * @param {number} args.toolCount - live discovered tool count
 * @param {string} args.discoveryStatus - pending | ok | failed | idle | unknown
 * @param {object|null|undefined} args.oauthStatus - /oauth/status payload (undefined = unknown / non-OAuth unknown)
 * @param {string} args.authType - sanitized server.auth.type
 * @returns {'DISCONNECTED'|'AUTH_REQUIRED'|'DISCOVERING'|'READY'|'EMPTY'|'DISCOVERY_FAILED'}
 */
export const getConnectionUiState = ({ connectionState, toolCount, discoveryStatus, oauthStatus, authType } = {}) => {
  if (connectionState !== 'connected') return 'DISCONNECTED';
  // OAuth servers without a stored credential need Authorize — regardless of
  // transport/discovery. (Non-OAuth servers skip this gate.)
  if (authType === 'oauth' && oauthStatus && oauthStatus.reason !== 'not_owner' && oauthStatus.authorized === false) {
    return 'AUTH_REQUIRED';
  }
  if (discoveryStatus === 'failed') return 'DISCOVERY_FAILED';
  if (Number(toolCount) > 0) return 'READY';
  if (discoveryStatus === 'pending') return 'DISCOVERING';
  if (discoveryStatus === 'ok') return 'EMPTY'; // genuinely zero tools
  // Unknown/idle with no tools yet: still discovering on first connect.
  return 'DISCOVERING';
};

export default { getOAuthUiState, getOAuthStatusLine, getConnectionUiState };
