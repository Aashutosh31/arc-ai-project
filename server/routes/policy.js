'use strict';

// JARVIS Action Substrate — slice 4E item 2: operator policy management API.
//
// GET  /api/policy  -> the currently active operator policy + meta. Built
//                      ENTIRELY from the in-process cache; a GET never
//                      touches Mongo. Auto-hydrates less than a minute of
//                      fresh on the startup path; operator PUTs apply
//                      immediately.
// PUT  /api/policy  -> full-replace the operator policy (upsert THE ONE
//                      OperatorPolicy document) and apply it to the
//                      in-process policy immediately. Validation happens
//                      before any write; a malformed body is a 400 and never
//                      touches the store or the in-process policy. A
//                      malformed PERSISTED document is never applied and is
//                      repaired only by an operator PUT.
//
// Authorization: only operators. Guests are rejected hard (403 GATE.GUEST).
// A signed-in non-operator user is rejected too (403 GATE.OPERATOR).
// Operator determination is server-side and fail-closed: user.role
// operator/admin, or membership in OPERATOR_EMAILS / OPERATOR_USER_IDS
// (read from the environment at request time).
//
// Layering: this route talks ONLY to operatorPolicySource.js. It never reads
// or writes Mongo directly, never imports the pure authorization engine, and
// is the only HTTP surface for the operator policy.

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { getActor, isGuestActor } = require('../lib/actor');
const operatorPolicySource = require('../lib/capabilities/operatorPolicySource');

const MAX_BODY_BYTES = 64 * 1024;

const router = express.Router();

// Hard 64 KB body cap for policy PUTs, independent of the global 8 MB JSON
// parser. In production the router is mounted ABOVE the global parser so this
// parser is authoritative; the guard below re-checks (chunked bodies, test
// harnesses that parse before this router) and fails closed either way.
router.use(express.json({ limit: '64kb' }));

router.use(protect);

const isOperatorUser = (req, actor) => {
  if (!actor || !actor.id) return false;
  const role = req.user && req.user.role;
  if (role === 'operator' || role === 'admin') return true;
  const email = req.user && req.user.email ? String(req.user.email).toLowerCase() : null;
  const emails = (process.env.OPERATOR_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (email && emails.includes(email)) return true;
  const userIds = (process.env.OPERATOR_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return userIds.includes(actor.id);
};

// Fail-closed gate: exit early unless this request is an operator.
const gate = (req, res) => {
  const actor = getActor(req);
  if (!actor || !actor.id) {
    res.status(401).json({ error: 'Not authorized', code: 'AUTH_REQUIRED' });
    return null;
  }
  if (isGuestActor(actor)) {
    res.status(403).json({ error: 'Operator policy is not available to guest sessions.', code: 'GATE.GUEST' });
    return null;
  }
  if (!isOperatorUser(req, actor)) {
    res.status(403).json({ error: 'Operator policy management requires an operator account.', code: 'GATE.OPERATOR' });
    return null;
  }
  return actor;
};

// Hard size guard: rejects a policy body whose raw content-length OR
// serialized parsed body exceeds 64 KB, before any validation.
const enforceBodySize = (req, res, next) => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Operator policy request body exceeds 64 KB.', code: 'POLICY.TOO_LARGE' });
  }
  if (req.body && typeof req.body === 'object') {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'Operator policy request body exceeds 64 KB.', code: 'POLICY.TOO_LARGE' });
      }
    } catch (_) {
      // unstringifiable body — let validation reject it
    }
  }
  next();
};

router.get('/', (req, res) => {
  if (!gate(req, res)) return;
  res.json(operatorPolicySource.getSafeRepresentation());
});

router.put('/', enforceBodySize, async (req, res) => {
  if (!gate(req, res)) return;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : null;
  const input = body && body.policy ? body.policy : body;
  try {
    const out = await operatorPolicySource.replacePolicy(input);
    res.json({ policy: out.policy, meta: operatorPolicySource.getMeta() });
  } catch (err) {
    if (err && err.code === 'MALFORMED_POLICY') {
      return res.status(400).json({ error: err.message, code: 'POLICY.MALFORMED' });
    }
    if (err && err.code === 'POLICY_STORE_UNAVAILABLE') {
      return res.status(503).json({ error: err.message, code: 'POLICY_STORE_UNAVAILABLE' });
    }
    return res.status(500).json({ error: 'Failed to persist operator policy; in-process policy unchanged.', code: 'POLICY_STORE_ERROR' });
  }
});

module.exports = router;