'use strict';

// JARVIS Phase 4 — the proactive autonomy ticker.
//
// One timer per server process. The server runs on a single Render node, so
// the timer plus the persisted Job lease are sufficient: a second process
// cannot claim an occurrence that is already leased, and the unique
// JobRun.occurrenceKey is the final database-level guard.
//
// This module starts only after Mongo is connected (see index.js) and is
// disabled by PROACTIVE_JOBS_ENABLED=false for local/test environments.

const { randomUUID } = require('crypto');
const jobService = require('./jobService');
const notifier = require('../lib/jobs/notifier');

const INTERVAL_MS = Math.max(5000, Number(process.env.PROACTIVE_JOBS_INTERVAL_MS) || 30000);
const INSTANCE_ID = `${process.pid}:${randomUUID().slice(0, 8)}`;

let timer = null;
let startupTimer = null;
let ticking = false;
let started = false;

const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    const claimed = await jobService.claimDueJobs(new Date(), INSTANCE_ID);
    await Promise.allSettled(
      claimed.map(({ job, scheduledFor }) =>
        jobService.runJob(job, { trigger: 'schedule', scheduledFor }).catch((error) => {
          console.error(`[Jobs] scheduled run failed (${job._id}):`, error?.message || error);
        })
      )
    );
  } catch (error) {
    console.error('[Jobs] scheduler tick failed:', error?.message || error);
  } finally {
    ticking = false;
  }
};

const start = async ({ io } = {}) => {
  if (started) return { started: false, reason: 'already-started' };
  if (process.env.PROACTIVE_JOBS_ENABLED === 'false') {
    return { started: false, reason: 'disabled' };
  }
  started = true;
  notifier.bind(io);
  try {
    const recovered = await jobService.recoverOrphanedRuns();
    if (recovered) {
      console.warn(`[Jobs] recovered ${recovered} interrupted/orphaned scheduled job state(s).`);
    }
  } catch (error) {
    console.error('[Jobs] orphan recovery failed:', error?.message || error);
  }

  // Let the HTTP server finish booting before the first catch-up tick.
  startupTimer = setTimeout(() => {
    void tick();
  }, 5000);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[Jobs] proactive scheduler started (every ${Math.round(INTERVAL_MS / 1000)}s, instance ${INSTANCE_ID}).`);
  return { started: true, instanceId: INSTANCE_ID, intervalMs: INTERVAL_MS };
};

const stop = () => {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
  started = false;
};

module.exports = {
  INSTANCE_ID,
  INTERVAL_MS,
  tick,
  start,
  stop
};
