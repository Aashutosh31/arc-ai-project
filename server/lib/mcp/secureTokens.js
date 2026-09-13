'use strict';

// AES-256-GCM envelope encryption for MCP OAuth credentials.
//
// Mirrors the existing Google-Calendar token facility
// (server/services/googleCalendarService.js) so MCP OAuth credentials get the
// same fail-closed, encrypted-at-rest treatment in a dedicated store.
//
// Key resolution: MCP_TOKEN_ENCRYPTION_KEY, falling back to
// GOOGLE_TOKEN_ENCRYPTION_KEY (same deployment secret discipline). When
// neither is set, OAuth credential operations fail closed with a clear error
// and the server continues to boot; non-OAuth MCP keeps working.
//
// Wire format: base64(iv[12] || tag[16] || ciphertext) of JSON.

const crypto = require('crypto');

const getEncryptionKey = () => {
  const key = process.env.MCP_TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'MCP OAuth credential encryption is not configured. Set MCP_TOKEN_ENCRYPTION_KEY (or GOOGLE_TOKEN_ENCRYPTION_KEY).'
    );
  }
  return crypto.createHash('sha256').update(String(key)).digest();
};

const isEncryptionAvailable = () => Boolean(
  process.env.MCP_TOKEN_ENCRYPTION_KEY || process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
);

const encryptJson = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
};

const decryptJson = (blob) => {
  if (!blob) return null;
  const buffer = Buffer.from(String(blob), 'base64');
  if (buffer.length < 29) return null;
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
};

module.exports = {
  getEncryptionKey,
  isEncryptionAvailable,
  encryptJson,
  decryptJson
};
