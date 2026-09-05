// Canonical actor abstraction.
//
// Every authentication method (local login, guest session, Google OAuth, future
// providers) must resolve to ONE shape at the auth boundary:
//
//   { type: 'user' | 'guest', id: string }
//
// - users:      id = User._id as a hex string
// - guests:     id = GuestSession.sessionId (e.g. "guest_<uuid>")
//
// Downstream services (conversations, workspaces, messages, memory, credits,
// search, Socket.IO) must use this actor instead of guessing what
// req.user.id / socket.userId contains. In particular they must never assume:
// User ObjectId vs GuestSession ObjectId vs sessionId vs OAuth subject.
//
// Field-type rule: String-typed identity fields (Conversation.userId) take
// actor.id directly. ObjectId-typed fields (Workspace.owner, AIMemory.userId,
// UserFact.userId) can only reference real users — use actorUserId() which
// returns null for guests; guests own no documents in those collections.
const GUEST_PREFIX = 'guest_';

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value);
  return str.length > 0 ? str : null;
};

const inferType = (authType, id) => {
  if (authType === 'guest' || authType === 'user') return authType;
  if (id && id.startsWith(GUEST_PREFIX)) return 'guest';
  return 'user';
};

const fromParts = (authType, rawId) => {
  const id = normalizeId(rawId);
  if (!id) return null;
  return { type: inferType(authType, id), id };
};

// Canonical actor for an Express request. Prefers req.actor set by the auth
// boundary; derives it otherwise so un-migrated paths keep working.
const getActor = (req) => {
  if (req?.actor && req.actor.id) {
    return { type: req.actor.type === 'guest' ? 'guest' : 'user', id: String(req.actor.id) };
  }
  return fromParts(req?.authType, req?.user?.id || req?.user?.userId);
};

// Canonical actor for a Socket.IO socket (same shape as REST).
const getSocketActor = (socket) => {
  if (socket?.actor && socket.actor.id) {
    return { type: socket.actor.type === 'guest' ? 'guest' : 'user', id: String(socket.actor.id) };
  }
  return fromParts(null, socket?.userId);
};

const isGuestActor = (actor) => actor?.type === 'guest';

// ObjectId-typed collections (Workspace.owner, AIMemory.userId,
// UserFact.userId) reference real users only. Returns the user id string for
// users, null for guests (guests own no documents there).
const actorUserId = (actor) => (actor && !isGuestActor(actor) ? actor.id : null);

module.exports = {
  GUEST_PREFIX,
  getActor,
  getSocketActor,
  isGuestActor,
  actorUserId
};
