// client/src/config.js — single source of truth for API/socket endpoints.
//
// Production serves the frontend and API on DIFFERENT sites (frontend on the
// hosting provider, API on its own host). The auth session is an httpOnly
// cookie; for a cross-site request that cookie is THIRD-PARTY, which Safari
// and Firefox block by default and Chrome is phasing out — the exact reason
// conversations/workspace calls 401'd in production while dev (same-site
// localhost) worked.
//
// The fix: in production every REST call goes to the SAME ORIGIN under
// /api/**, which the hosting proxy (client/vercel.json rewrites) forwards to
// the backend. The cookie is then first-party in every browser.
//
//   dev  -> VITE_API_URL (default http://localhost:5000), direct
//   prod -> '' (relative), i.e. https://<frontend-host>/api/** via proxy
//
// The realtime Socket.IO connection cannot ride that proxy (WebSocket
// upgrades are not forwarded), so it connects DIRECTLY to the API host and
// authenticates with a one-time ticket fetched from the same-origin /api
// proxy — again no third-party cookie involved.

const DEV_API = import.meta.env.VITE_API_URL || 'http://localhost:5000';

/** Base URL for REST calls. '' in production = same-origin /api proxy. */
export const API_URL = import.meta.env.DEV ? DEV_API : '';

/**
 * Direct origin for the Socket.IO connection.
 * Production override: set VITE_SOCKET_URL on the hosting provider if the
 * API host differs from the default.
 */
export const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? DEV_API : 'https://arc-ai-backend.onrender.com');
