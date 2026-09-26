// server/lib/conversationAccess.js
//
// THE authoritative conversation ownership boundary.
//
// Ownership rule (one rule, one place — every conversation read/write on the
// Socket.IO AI path and the REST path resolves through here):
//
//   A conversation is reachable if and only if
//     conversation._id  == the requested conversationId   AND
//     conversation.userId == the AUTHENTICATED actor id    (the authority)
//
// The workspace relationship is an attribution filter, never the security
// boundary: a workspace-scoped miss retries without the workspace filter
// (still actor-scoped) so conversations stored before workspace attribution
// stay reachable. A client-asserted workspaceId can therefore never widen
// access — it can only narrow a lookup that the actor already owns.
//
// Never trusted as identity: client userId / ownerId / workspaceId, and a bare
// conversationId. Identity always comes from the canonical actor
// (server/lib/actor.js), which is derived from the verified JWT at the
// auth boundary — there is deliberately no second identity system here.
//
// Error semantics are uniform for malformed, nonexistent, cross-actor and
// wrong-workspace ids: the caller cannot distinguish them, so existence of
// another actor's conversation is never disclosed. This mirrors the REST
// reference (conversationController → 404 CONVERSATION_NOT_FOUND).

const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const { getSocketActor, isGuestActor } = require('./actor');

// Same wording the REST layer already returns, so both transports behave
// identically. Never append the requested id, the owner, or a reason.
const CONVERSATION_NOT_FOUND_MESSAGE = 'Conversation not found';
const CONVERSATION_NOT_FOUND_CODE = 'CONVERSATION_NOT_FOUND';

const isValidConversationId = (value) => {
  if (value === null || value === undefined) return false;
  return mongoose.Types.ObjectId.isValid(String(value));
};

// The single ownership predicate. Every conversation query that can be
// influenced by a client-supplied id filters on this and nothing else.
const ownedConversationFilter = (userId, conversationId) => ({
  _id: conversationId,
  userId: String(userId),
});

const findOwnedConversation = async (userId, conversationId, workspaceId) => {
  if (!userId || !isValidConversationId(conversationId)) return null;
  const filter = ownedConversationFilter(userId, conversationId);
  if (workspaceId) {
    const scoped = await Conversation.findOne({ ...filter, workspaceId });
    if (scoped) return scoped;
  }
  return Conversation.findOne(filter);
};

const isConversationOwned = async (userId, conversationId) => {
  if (!userId || !isValidConversationId(conversationId)) return false;
  const doc = await Conversation.findOne(ownedConversationFilter(userId, conversationId))
    .select('_id')
    .lean();
  return Boolean(doc);
};

// The single conversation write primitive. Returns null when the id is not
// owned by the actor — a write can never land on a foreign conversation.
const updateOwnedConversation = async (userId, conversationId, update) => {
  if (!userId || !isValidConversationId(conversationId)) return null;
  return Conversation.findOneAndUpdate(ownedConversationFilter(userId, conversationId), update, {
    new: true,
  });
};

const conversationNotFound = () => ({
  ok: false,
  conversationId: null,
  code: CONVERSATION_NOT_FOUND_CODE,
  error: CONVERSATION_NOT_FOUND_MESSAGE,
});

// Socket.IO boundary resolver — the only entry point the ai:stt:final handler
// needs. Returns the verified conversationId to hand to AIService, or a
// uniform not-found denial. Guests own no conversation documents, so any id
// they send is dropped rather than resolved.
const resolveSocketConversation = async ({ socket, conversationId, workspaceId }) => {
  const actor = getSocketActor(socket);
  if (!actor || !actor.id) return conversationNotFound();

  if (!conversationId) return { ok: true, conversationId: null };
  if (isGuestActor(actor)) return { ok: true, conversationId: null };

  const owned = await findOwnedConversation(actor.id, conversationId, workspaceId || null);
  if (!owned) return conversationNotFound();
  return { ok: true, conversationId: String(owned._id) };
};

module.exports = {
  CONVERSATION_NOT_FOUND_MESSAGE,
  CONVERSATION_NOT_FOUND_CODE,
  isValidConversationId,
  ownedConversationFilter,
  findOwnedConversation,
  isConversationOwned,
  updateOwnedConversation,
  conversationNotFound,
  resolveSocketConversation,
};
