'use strict';

// JARVIS Phase 4 — job event fan-out.
//
// Deliberately tiny and dependency-free so services can notify without
// importing index.js (which would create a cycle). Bound once after the
// Socket.IO server is created. Every event targets the user room that Phase A
// sync already uses, so all of a user's devices see the same job state.

let ioRef = null;

const bind = (io) => {
  ioRef = io || null;
};

const getIo = () => ioRef;

const emitToUser = (userId, event, payload) => {
  if (!ioRef || !userId) return;
  try {
    ioRef.to(`user:${userId}`).emit(event, payload);
  } catch (error) {
    console.error(`[Jobs] ${event} emit failed:`, error?.message || error);
  }
};

const jobUpdated = (userId, job) => emitToUser(userId, 'job.updated', { job });

const jobNotification = (userId, payload) =>
  emitToUser(userId, 'job.notification', payload);

module.exports = {
  bind,
  getIo,
  emitToUser,
  jobUpdated,
  jobNotification
};
