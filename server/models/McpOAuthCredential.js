'use strict';

// Dedicated server-side store for per-user MCP OAuth credentials.
//
// STATIC CONFIG (McpServerConfig: endpoint, transport, auth mode, scope,
// policy) is deliberately separated from USER AUTH STATE (this model).
//
// One document per (ARC user, MCP server config, authorization-server
// issuer). Tokens AND OAuth client information share the same encrypted blob
// so client secrets are never persisted in plaintext either.
//
// Security properties:
//  - `encryptedBlob` is AES-256-GCM (see server/lib/mcp/secureTokens.js).
//    Plaintext tokens/client secrets never touch Mongo.
//  - `ownerUserId` scoping: two ARC users connecting the same MCP server get
//    distinct documents and MUST NOT share tokens (enforced at query time).
//  - Safe metadata (issuer, scope, expiry, token type) lives OUTSIDE the blob
//    so status endpoints can report it without decrypting.
//  - Guests never receive documents: guests cannot own configs and the routes
//    forbid guest access to OAuth endpoints.

const mongoose = require('mongoose');

const mcpOAuthCredentialSchema = new mongoose.Schema(
  {
    // ARC user who completed authorization (User ObjectId hex string).
    userId: { type: String, required: true, index: true },
    // McpServerConfig _id hex string.
    configId: { type: String, required: true, index: true },
    // Authorization-server issuer the credentials are bound to (SDK stamps
    // StoredOAuthTokens/StoredOAuthClientInformation with `issuer`; we key
    // on it per RFC 6749 §2.2).
    issuer: { type: String, required: true },
    // AES-256-GCM base64 blob: { tokens, clientInfo }.
    encryptedBlob: { type: String, required: true },
    // ---- safe metadata (redactable, shown in Settings UI) ----
    scope: { type: String, default: null },
    tokenType: { type: String, default: null },
    // Epoch ms when the access token expires (null when unknown).
    expiresAt: { type: Number, default: null },
    // OAuth client_id (public identifier, safe to display).
    clientId: { type: String, default: null },
    // Account identity when safely known (e.g. provider userinfo sub);
    // informational only, never used for auth decisions.
    accountLabel: { type: String, default: null },
    lastAuthorizedAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    toJSON: { virtuals: false, versionKey: false },
    toObject: { virtuals: false, versionKey: false }
  }
);

mcpOAuthCredentialSchema.index({ userId: 1, configId: 1, issuer: 1 }, { unique: true });
mcpOAuthCredentialSchema.index({ updatedAt: 1 });

let _Model = null;
try {
  const modelName = 'McpOAuthCredential';
  _Model = mongoose.models[modelName] || mongoose.model(modelName, mcpOAuthCredentialSchema);
} catch {
  _Model = null;
}

module.exports = _Model;
