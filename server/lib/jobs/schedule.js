'use strict';

// JARVIS Phase 4 — deterministic trigger math.
//
// Pure functions only: no DB, no scheduler state. Kept separate so the
// scheduling contract can be tested offline and reused by both the create
// path and the ticker.

const cronParser = require('cron-parser');

const TRIGGER_TYPES = Object.freeze(['schedule', 'once']);
const DEFAULT_TIMEZONE = 'UTC';

const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const isValidCron = (expression, timezone = DEFAULT_TIMEZONE) => {
  if (!expression || typeof expression !== 'string') return false;
  try {
    cronParser.parseExpression(expression, { tz: timezone || DEFAULT_TIMEZONE });
    return true;
  } catch {
    return false;
  }
};

const isValidTimezone = (timezone) => {
  if (!timezone) return true;
  try {
    // Luxon (cron-parser's engine) accepts IANA names via Intl in the host.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

// Validate/normalize a client-supplied trigger. `now` is injectable for tests.
const normalizeTrigger = (input, { now = new Date() } = {}) => {
  const raw = input && typeof input === 'object' ? input : {};
  const type = TRIGGER_TYPES.includes(raw.type) ? raw.type : 'schedule';
  const timezone = String(raw.timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;

  if (!isValidTimezone(timezone)) {
    return { ok: false, code: 'INVALID_TIMEZONE', error: `Unknown timezone: ${timezone}` };
  }

  if (type === 'once') {
    const runAt = toDate(raw.runAt);
    if (!runAt) {
      return { ok: false, code: 'INVALID_RUN_AT', error: 'runAt must be a valid date.' };
    }
    if (runAt.getTime() <= now.getTime()) {
      return { ok: false, code: 'RUN_AT_IN_PAST', error: 'runAt must be in the future.' };
    }
    return {
      ok: true,
      trigger: { type: 'once', cron: null, runAt, timezone }
    };
  }

  const cron = String(raw.cron || '').trim();
  if (!isValidCron(cron, timezone)) {
    return { ok: false, code: 'INVALID_CRON', error: 'cron must be a valid 5-field cron expression.' };
  }
  return {
    ok: true,
    trigger: { type: 'schedule', cron, runAt: null, timezone }
  };
};

// Next occurrence strictly after `from` (or exactly at `from` for a one-shot
// that has not fired yet). Returns null when the trigger has no future run.
const computeNextRun = (trigger, from = new Date()) => {
  if (!trigger || typeof trigger !== 'object') return null;
  const base = toDate(from) || new Date();

  if (trigger.type === 'once') {
    const runAt = toDate(trigger.runAt);
    if (!runAt) return null;
    return runAt.getTime() >= base.getTime() ? runAt : null;
  }

  if (trigger.type === 'schedule') {
    try {
      const iterator = cronParser.parseExpression(trigger.cron, {
        currentDate: base,
        tz: trigger.timezone || DEFAULT_TIMEZONE
      });
      return iterator.next().toDate();
    } catch {
      return null;
    }
  }

  return null;
};

const describeTrigger = (trigger) => {
  if (!trigger || typeof trigger !== 'object') return 'No trigger';
  if (trigger.type === 'once') {
    const at = toDate(trigger.runAt);
    return at ? `Once at ${at.toISOString()}` : 'Once';
  }
  if (trigger.type === 'schedule') {
    return `Cron ${trigger.cron}${trigger.timezone && trigger.timezone !== DEFAULT_TIMEZONE ? ` (${trigger.timezone})` : ''}`;
  }
  return 'No trigger';
};

module.exports = {
  TRIGGER_TYPES,
  DEFAULT_TIMEZONE,
  isValidCron,
  isValidTimezone,
  normalizeTrigger,
  computeNextRun,
  describeTrigger
};
