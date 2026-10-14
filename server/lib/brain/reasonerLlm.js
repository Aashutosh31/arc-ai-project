'use strict';

// ARC Brain — the semantic reasoner.
//
// The deterministic reasoner in reasoner.js is the safety net: it is fast,
// free, and correct for the cases where the user's intent is grammatical rather
// than semantic. It cannot be the whole answer, because "is this project
// trending" and "what is trending in tech" differ by a single clause, and only a
// model can reliably weigh that.
//
// This module is the seam. It takes a `complete` FUNCTION from its host — not a
// provider SDK — so lib/brain stays provider-independent and the whole reasoner
// is testable with a stub. The host (AIService) injects a function that calls
// the existing LLM router; swapping Groq for Gemini, or a local model, changes
// nothing here.
//
// TRUST MODEL
//   The model's output is INPUT to the guard rails, never a decision. A model
//   that returns prose, invents fields, or asks for news the user did not ask
//   for is corrected or rejected downstream in interpretation.js. That is why
//   the news bug cannot come back through a model.

const {
  INTERPRETATION_CONTRACT, buildDecisionSystemPrompt, buildDecisionUserPrompt,
} = require('./reasoner');

const MAX_DECISION_TOKENS = 400;
// A decision is a small object. If the model needs more than this to classify a
// turn, it is answering instead of deciding, which is the wrong job.
const MAX_DECISION_CHARS = 2000;

/**
 * Pull the first complete JSON object out of a model response.
 * Tolerates markdown fences and leading prose, because models emit both even
 * when told not to.
 */
const extractJson = (text) => {
  const raw = String(text || '').slice(0, MAX_DECISION_CHARS);
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  if (start === -1) return null;
  // Brace-counting, so a nested object or a "}" inside a string does not end
  // the scan early.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/**
 * @param {object} options
 * @param {(args: {system:string,user:string,maxTokens:number}) => Promise<{text?:string}|string>} options.complete
 *   Injected host function. Required — this module never imports a provider.
 * @param {number} [options.timeoutMs]
 * @param {object} [options.logger]
 * @returns {{name:string, interpret:Function}}
 */
const createLlmReasoner = ({ complete, timeoutMs = 6000, logger = console } = {}) => {
  if (typeof complete !== 'function') {
    throw new TypeError('createLlmReasoner requires a complete() function');
  }
  return {
    name: 'llm',
    async interpret(ctx = {}) {
      const {
        userText, relation = 'new_task', priorTopic = null, priorTaskType = null,
        pendingClarification = null,
      } = ctx;
      const hasPriorTopic = Boolean(priorTopic);
      const hasPriorNews = priorTaskType === 'current_news';

      const system = buildDecisionSystemPrompt({ hasPriorTopic, hasPriorNews, correction: relation === 'correction' });
      const user = buildDecisionUserPrompt({
        userText,
        relation,
        priorTopic,
        priorTaskType,
        pendingClarification,
        contract: INTERPRETATION_CONTRACT,
      });

      let raw;
      try {
        const response = await withTimeout(
          Promise.resolve(complete({ system, user, maxTokens: MAX_DECISION_TOKENS })),
          timeoutMs,
        );
        raw = typeof response === 'string' ? response : response?.text;
      } catch (error) {
        // A provider failure is reported, never thrown: the runtime falls back
        // to the deterministic reasoner and then to a safe no-op plan.
        return {
          ok: false,
          candidate: null,
          problems: [`llm_reasoner_unavailable:${String(error?.message || error).slice(0, 60)}`],
        };
      }

      const parsed = extractJson(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, candidate: null, problems: ['llm_reasoner_unparseable'] };
      }
      // Do not echo the model's text into logs; only the fact that it parsed.
      logger?.log?.('[Brain] llm interpretation accepted');
      return { ok: true, candidate: parsed, problems: [] };
    },
  };
};

/**
 * Run the deterministic reasoner first, then the model, and keep the model's
 * answer ONLY when it is structurally sound. The deterministic result is the
 * floor; the model can improve the goal, not weaken the guards.
 *
 * @param {object} options
 * @param {object} [options.llm] the LLM reasoner; omitted => deterministic only
 * @param {object} [options.deterministic]
 */
const createHybridReasoner = ({ llm, deterministic } = {}) => {
  const base = deterministic || require('./reasoner').createDeterministicReasoner();
  if (!llm) return base;
  return {
    name: 'hybrid',
    async interpret(ctx = {}) {
      const fallback = await base.interpret(ctx);
      try {
        const decision = await llm.interpret(ctx);
        if (!decision || !decision.ok || !decision.candidate) {
          return { ...fallback, problems: [...(fallback.problems || []), ...((decision && decision.problems) || ['llm_declined'])] };
        }
        // The model's own subject is preferred, but an absent subject falls
        // back to the deterministic extraction rather than losing the subject.
        const candidate = { ...decision.candidate };
        if (!candidate.topic && fallback.candidate && fallback.candidate.topic) {
          candidate.topic = fallback.candidate.topic;
        }
        if (typeof candidate.confidence !== 'number' && fallback.candidate?.confidence != null) {
          candidate.confidence = fallback.candidate.confidence;
        }
        return { ok: true, candidate, problems: decision.problems || [] };
      } catch (error) {
        return { ...fallback, problems: [...(fallback.problems || []), 'llm_reasoner_threw'] };
      }
    },
  };
};

const withTimeout = (promise, ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('decision_timeout')), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
};

module.exports = {
  createLlmReasoner,
  createHybridReasoner,
  extractJson,
  MAX_DECISION_TOKENS,
  MAX_DECISION_CHARS,
};
