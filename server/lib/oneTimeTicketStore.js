'use strict';

// One-time handshake tickets.
//
// Production serves the frontend and the API on DIFFERENT sites
// (frontend on the hosting proxy, API on its own host). The session cookie
// is therefore third-party for any DIRECT cross-site request, and Safari,
// Firefox (ETP) and phased-out Chrome configurations block it. Two flows
// must keep authenticating without third-party cookies:
//
//   kind 'socket' — the Socket.IO handshake connects directly to the API
//                   host (the hosting proxy cannot forward WebSocket
//                   upgrades). The client first fetches a socket ticket
//                   over the SAME-ORIGIN /api proxy (first-party cookie)
//                   and presents it in `handshake.auth.ticket`.
//
//   kind 'auth'   — the Google OAuth popup lands on the API host, which
//                   cannot set a cookie the frontend host will send. The
//                   callback instead redirects (inside the popup) to the
//                   frontend's /auth/callback page with a ticket; that
//                   page exchanges it through the same-origin proxy so the
//                   Set-Cookie is attributed to the frontend host.
//
// Tickets are single-use and short-lived; consumption deletes the entry
// immediately (replay-proof). The store is process-local — fine for the
// single-instance deployment; swap for the Redis store if the API ever
// scales horizontally.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 120 * 1000;

const stores = new Map(); // kind -> Map<ticket, data>

const sweep = (store) => {
    const now = Date.now();
    for (const [ticket, entry] of store) {
        if (entry.expiresAt <= now) store.delete(ticket);
    }
};

/**
 * Issue a single-use ticket for `kind`.
 * @param {string} kind e.g. 'socket' | 'auth'
 * @param {object} data payload returned on consume (must not be user-mutable)
 * @param {number} [ttlMs]
 * @returns {{ ticket: string, expiresInMs: number }}
 */
const issue = (kind, data, ttlMs = DEFAULT_TTL_MS) => {
    let store = stores.get(kind);
    if (!store) {
        store = new Map();
        stores.set(kind, store);
    }
    sweep(store);
    const ticket = crypto.randomBytes(24).toString('hex');
    store.set(ticket, { ...data, expiresAt: Date.now() + ttlMs });
    return { ticket, expiresInMs: ttlMs };
};

/**
 * Consume a ticket (single-use). Returns the stored data or null.
 * @param {string} kind
 * @param {string} ticket
 */
const consume = (kind, ticket) => {
    if (typeof ticket !== 'string' || ticket.length < 16) return null;
    const store = stores.get(kind);
    if (!store) return null;
    const entry = store.get(ticket);
    if (!entry) return null;
    store.delete(ticket); // single-use: a replay finds nothing
    if (entry.expiresAt <= Date.now()) return null;
    const data = { ...entry };
    delete data.expiresAt;
    return data;
};

module.exports = { issue, consume };
