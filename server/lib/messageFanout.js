// server/lib/messageFanout.js
//
// Realtime-sync design [planning doc 05] Phase A: the ONLY event family that
// broadcasts durable transcript content. Every device signed in as the actor
// (single user room, no per-conversation joining needed) receives
// `conversation.message.appended`; clients dedupe by the canonical message
// `_id` (append iff unseen, replace otherwise). The ORIGINATING socket is
// excluded by default — that device already holds its own optimistic/streamed
// copy, and exclusion keeps the live channel quiet while other devices of the
// same actor converge.
//
// Delivery is best-effort by design: the message row is already durable, and
// the reconnect/refocus catch-up (REST cursor fetch + reconcile) closes any
// gap. Fan-out must NEVER break the turn — everything is wrapped.

const safelyEmit = (emitter, event, payload) => {
  if (!emitter || typeof emitter.emit !== "function") return;
  try {
    emitter.emit(event, payload);
  } catch (err) {
    console.warn("[Sync] fan-out emit failed:", err?.message || err);
  }
};

const buildPayload = (conversationId, message, extra = {}) => {
  if (!message) return null;
  const metadata = message.metadata || {};
  return {
    conversationId: String(conversationId),
    message: {
      _id: String(message._id),
      role: message.role,
      content: message.content || "",
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : [],
      interrupted: Boolean(metadata.interrupted),
      streaming: Boolean(metadata.streaming),
      createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : new Date().toISOString(),
    },
    ...extra,
  };
};

/**
 * Broadcast one durable message to every OTHER socket of the owning actor.
 * No-op when socket.io is unavailable (boot, tests) or for guests (they own no
 * conversation documents — their user room can never be trusted to exist).
 */
const emitMessageAppended = (userId, conversationId, message, originSocketId = null) => {
  if (!userId || !message || typeof userId !== "string") return;
  try {
    if (userId.startsWith("guest_")) return;
    const io = global.io;
    if (!io) return;
    const payload = buildPayload(conversationId, message);
    if (!payload) return;
    let targets = io.sockets.in(`user:${userId}`);
    if (originSocketId && typeof originSocketId === "string") {
      targets = targets.except(originSocketId);
    }
    safelyEmit(targets, "conversation.message.appended", payload);
  } catch (err) {
    console.warn("[Sync] message fan-out failed:", err?.message || err);
  }
};

module.exports = { emitMessageAppended, buildPayload };
