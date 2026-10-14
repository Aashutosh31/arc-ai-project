'use strict';

// ARC Brain — entity typing for relevance judgement.
//
// WHY THIS EXISTS
// Lexical overlap cannot tell "Paperclip" the open-source project from
// "Paperclip" the short film, because both contain the string "Paperclip" once.
// Scoring overlap alone therefore accepts a wrong-entity result, which is worse
// than useless: it produces a confidently wrong answer.
//
// So relevance is judged on three axes, not one:
//
//   1. IDENTITY  — is this the same named thing the user asked about?
//   2. TYPE      — is it the same KIND of thing? (project vs film vs company)
//   3. GOAL      — does it cover what the user actually asked for?
//
// THIS IS A TYPE MODEL, NOT A BLOCKLIST
// The model infers an entity's type from structural cues and then compares
// families. Nothing enumerates "bad" results: the same comparison that rejects
// "Paperclip (film)" for a technology goal rejects "Paperclip (novel)",
// "Paperclip (restaurant)" and "Paperclip (band)" without any of them being
// written down. Adding a new type is one row in FAMILY_BY_TYPE.
//
// UNKNOWN IS NOT A MISMATCH
// A result with no type cue is `generic`, and a goal that expresses no type
// expectation yields an empty expected set. Neither is a mismatch, because
// penalising ignorance is how a relevance filter starts hiding real answers.
// The result of "I cannot type either side" is AMBIGUITY, which the caller
// resolves by asking, not by guessing.
//
// NO CHAIN OF THOUGHT
// Nothing here returns prose reasoning. `signals` is a fixed set of booleans,
// counts and enum values only, so a log line can never leak deliberation.

const FAMILY_MEDIA = 'media';
const FAMILY_TECHNOLOGY = 'technology';
const FAMILY_ORGANIZATION = 'organization';
const FAMILY_PERSON = 'person';
const FAMILY_ACADEMIC = 'academic';
const FAMILY_PLACE = 'place';
const FAMILY_EVENT = 'event';
const FAMILY_GENERIC = 'generic';

const TYPE_SOFTWARE_PROJECT = 'software_project';
const TYPE_DOCUMENTATION = 'documentation';
const TYPE_DEVELOPER_TOOL = 'developer_tool';
const TYPE_API = 'api';
const TYPE_PRODUCT_RELEASE = 'product_release';
const TYPE_FILM = 'film';
const TYPE_TV_SERIES = 'tv_series';
const TYPE_NOVEL = 'novel';
const TYPE_MUSIC = 'music';
const TYPE_GAME = 'game';
const TYPE_COMPANY = 'company';
const TYPE_NONPROFIT = 'nonprofit';
const TYPE_PRODUCT_BRAND = 'product_brand';
const TYPE_PERSON = 'person';
const TYPE_ACADEMIC_WORK = 'academic_work';
const TYPE_PLACE = 'place';
const TYPE_EVENT = 'event';
const TYPE_GENERIC = 'generic';

const FAMILY_BY_TYPE = Object.freeze({
  [TYPE_SOFTWARE_PROJECT]: FAMILY_TECHNOLOGY,
  [TYPE_DOCUMENTATION]: FAMILY_TECHNOLOGY,
  [TYPE_DEVELOPER_TOOL]: FAMILY_TECHNOLOGY,
  [TYPE_API]: FAMILY_TECHNOLOGY,
  [TYPE_PRODUCT_RELEASE]: FAMILY_TECHNOLOGY,
  [TYPE_FILM]: FAMILY_MEDIA,
  [TYPE_TV_SERIES]: FAMILY_MEDIA,
  [TYPE_NOVEL]: FAMILY_MEDIA,
  [TYPE_MUSIC]: FAMILY_MEDIA,
  [TYPE_GAME]: FAMILY_MEDIA,
  [TYPE_COMPANY]: FAMILY_ORGANIZATION,
  [TYPE_NONPROFIT]: FAMILY_ORGANIZATION,
  [TYPE_PRODUCT_BRAND]: FAMILY_ORGANIZATION,
  [TYPE_PERSON]: FAMILY_PERSON,
  [TYPE_ACADEMIC_WORK]: FAMILY_ACADEMIC,
  [TYPE_PLACE]: FAMILY_PLACE,
  [TYPE_EVENT]: FAMILY_EVENT,
  [TYPE_GENERIC]: FAMILY_GENERIC,
});

// Cue phrases -> type. Matched on word boundaries, longest cue first so
// "open source project" wins over "project".
const TYPE_CUES = Object.freeze([
  // technology
  ['open source project', TYPE_SOFTWARE_PROJECT],
  ['open-source project', TYPE_SOFTWARE_PROJECT],
  ['github repository', TYPE_SOFTWARE_PROJECT],
  ['github repo', TYPE_SOFTWARE_PROJECT],
  ['source repository', TYPE_SOFTWARE_PROJECT],
  ['open source', TYPE_SOFTWARE_PROJECT],
  ['open-source', TYPE_SOFTWARE_PROJECT],
  ['free software', TYPE_SOFTWARE_PROJECT],
  ['web app', TYPE_SOFTWARE_PROJECT],
  ['web application', TYPE_SOFTWARE_PROJECT],
  ['mobile app', TYPE_SOFTWARE_PROJECT],
  ['note-taking app', TYPE_SOFTWARE_PROJECT],
  // Broad technology vocabulary. These are the words a real description of a
  // software thing actually uses. They are deliberately a bit loose ("tool",
  // "app", "web"): a loose cue yields a REFINEMENT discount, not a confident
  // match, so over-triggering costs confidence rather than correctness.
  ['software', TYPE_SOFTWARE_PROJECT],
  ['web', TYPE_SOFTWARE_PROJECT],
  ['app', TYPE_SOFTWARE_PROJECT],
  ['application', TYPE_SOFTWARE_PROJECT],
  ['extension', TYPE_SOFTWARE_PROJECT],
  ['plugin', TYPE_SOFTWARE_PROJECT],
  ['browser', TYPE_SOFTWARE_PROJECT],
  ['database', TYPE_SOFTWARE_PROJECT],
  ['clipboard', TYPE_SOFTWARE_PROJECT],
  ['tool', TYPE_DEVELOPER_TOOL],
  ['developer', TYPE_DEVELOPER_TOOL],
  ['cloud', TYPE_SOFTWARE_PROJECT],
  ['github', TYPE_SOFTWARE_PROJECT],
  ['repository', TYPE_SOFTWARE_PROJECT],
  ['codebase', TYPE_SOFTWARE_PROJECT],
  ['source code', TYPE_SOFTWARE_PROJECT],
  ['npm package', TYPE_SOFTWARE_PROJECT],
  ['pypi package', TYPE_SOFTWARE_PROJECT],
  ['library', TYPE_SOFTWARE_PROJECT],
  ['framework', TYPE_SOFTWARE_PROJECT],
  ['sdk', TYPE_DEVELOPER_TOOL],
  ['cli tool', TYPE_DEVELOPER_TOOL],
  ['developer tool', TYPE_DEVELOPER_TOOL],
  ['command line tool', TYPE_DEVELOPER_TOOL],
  ['developer documentation', TYPE_DOCUMENTATION],
  ['api reference', TYPE_DOCUMENTATION],
  ['api docs', TYPE_DOCUMENTATION],
  ['user manual', TYPE_DOCUMENTATION],
  ['getting started', TYPE_DOCUMENTATION],
  ['readme', TYPE_DOCUMENTATION],
  ['documentation', TYPE_DOCUMENTATION],
  ['reference manual', TYPE_DOCUMENTATION],
  ['tutorial', TYPE_DOCUMENTATION],
  ['changelog', TYPE_PRODUCT_RELEASE],
  ['release notes', TYPE_PRODUCT_RELEASE],
  ['release announcement', TYPE_PRODUCT_RELEASE],
  ['api', TYPE_API],
  // organization
  ['technology company', TYPE_COMPANY],
  ['tech company', TYPE_COMPANY],
  ['startup', TYPE_COMPANY],
  ['company', TYPE_COMPANY],
  ['corporation', TYPE_COMPANY],
  ['nonprofit', TYPE_NONPROFIT],
  ['non-profit', TYPE_NONPROFIT],
  ['charity', TYPE_NONPROFIT],
  // media
  ['short film', TYPE_FILM],
  ['feature film', TYPE_FILM],
  ['film', TYPE_FILM],
  ['movie', TYPE_FILM],
  ['documentary', TYPE_FILM],
  ['cinema', TYPE_FILM],
  ['tv series', TYPE_TV_SERIES],
  ['television series', TYPE_TV_SERIES],
  ['sitcom', TYPE_TV_SERIES],
  ['anime', TYPE_TV_SERIES],
  ['novel', TYPE_NOVEL],
  ['book', TYPE_NOVEL],
  ['poetry collection', TYPE_NOVEL],
  ['album', TYPE_MUSIC],
  ['single', TYPE_MUSIC],
  ['band', TYPE_MUSIC],
  ['musician', TYPE_MUSIC],
  ['video game', TYPE_GAME],
  ['mobile game', TYPE_GAME],
  ['board game', TYPE_GAME],
  // place / venue
  ['restaurant', TYPE_PLACE],
  ['cafe', TYPE_PLACE],
  ['coffee shop', TYPE_PLACE],
  ['hotel', TYPE_PLACE],
  ['museum', TYPE_PLACE],
  ['stadium', TYPE_PLACE],
  ['theatre', TYPE_PLACE],
  ['theater', TYPE_PLACE],
  ['cinema chain', TYPE_PLACE],
  ['island', TYPE_PLACE],
  ['town', TYPE_PLACE],
  ['village', TYPE_PLACE],
  ['city', TYPE_PLACE],
  ['country', TYPE_PLACE],
  ['county', TYPE_PLACE],
  // person
  ['actor', TYPE_PERSON],
  ['actress', TYPE_PERSON],
  ['director', TYPE_PERSON],
  ['author', TYPE_PERSON],
  ['singer', TYPE_PERSON],
  ['politician', TYPE_PERSON],
  ['biography of', TYPE_PERSON],
  // academic
  ['preprint', TYPE_ACADEMIC_WORK],
  ['research paper', TYPE_ACADEMIC_WORK],
  ['journal', TYPE_ACADEMIC_WORK],
  ['conference paper', TYPE_ACADEMIC_WORK],
  ['citation', TYPE_ACADEMIC_WORK],
  ['arxiv', TYPE_ACADEMIC_WORK],
]);

// Cue phrases that express a TYPE EXPECTATION in the user's own goal. Kept
// separate from TYPE_CUES: "project" alone is genuinely ambiguous (film project,
// building project), so an ambiguous goal cue widens the accepted set to a
// family instead of pinning one type.
const GOAL_FAMILY_CUES = Object.freeze([
  ['technology', FAMILY_TECHNOLOGY],
  ['technologies', FAMILY_TECHNOLOGY],
  ['tech', FAMILY_TECHNOLOGY],
  ['software', FAMILY_TECHNOLOGY],
  ['programming', FAMILY_TECHNOLOGY],
  ['developer', FAMILY_TECHNOLOGY],
  ['code', FAMILY_TECHNOLOGY],
  ['coding', FAMILY_TECHNOLOGY],
  ['opensource', FAMILY_TECHNOLOGY],
  ['opensource', FAMILY_TECHNOLOGY],
  ['app', FAMILY_TECHNOLOGY],
  ['application', FAMILY_TECHNOLOGY],
  ['startup ecosystem', FAMILY_ORGANIZATION],
  ['company', FAMILY_ORGANIZATION],
  ['business', FAMILY_ORGANIZATION],
  ['film', FAMILY_MEDIA],
  ['movie', FAMILY_MEDIA],
  ['cinema', FAMILY_MEDIA],
  ['music', FAMILY_MEDIA],
  ['band', FAMILY_MEDIA],
  ['album', FAMILY_MEDIA],
  ['book', FAMILY_MEDIA],
  ['novel', FAMILY_MEDIA],
  ['game', FAMILY_MEDIA],
  ['paper', FAMILY_ACADEMIC],
  ['research', FAMILY_ACADEMIC],
  ['study', FAMILY_ACADEMIC],
  ['city', FAMILY_PLACE],
  ['country', FAMILY_PLACE],
  ['restaurant', FAMILY_PLACE],
]);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CUE_RE = new RegExp(`(?:^|[^a-z0-9])(${TYPE_CUES.map(([cue]) => escapeRe(cue)).join('|')})(?![a-z0-9])`, 'i');
// Global variant, so every body cue is collected rather than just the first.
const CUE_RE_GLOBAL = new RegExp(CUE_RE.source, 'gi');
const GOAL_CUE_RE = new RegExp(`(?:^|[^a-z0-9])(${GOAL_FAMILY_CUES.map(([cue]) => escapeRe(cue)).join('|')})(?![a-z0-9])`, 'i');

const TYPE_BY_CUE = new Map(TYPE_CUES);
const FAMILY_BY_CUE = new Map(GOAL_FAMILY_CUES);

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// Matched cues, longest first, so "developer documentation" wins over
// "documentation" and "short film" wins over "film".
const orderedCues = () => [...TYPE_CUES].sort((a, b) => b[0].length - a[0].length);

/**
 * Infer the entity TYPE(S) of a result.
 *
 * A result is not always one thing: "an open-source note-taking app by
 * Paperclip Inc." is BOTH a software project AND a company story, and for a
 * technology goal that result is relevant. So this returns every candidate
 * type with the source that produced it, plus a primary type for display.
 *
 * Structural cues outrank body cues, and a title disambiguator ("Paperclip
 * (film)") is authoritative for the primary type — but it does not erase a
 * body cue, because a hybrid result is real and must not be misfiled.
 *
 * A result with no cue at all is `generic` with confidence 0, which means
 * explicitly "untyped", NOT "known to be generic".
 */
const inferEntityTypes = (text, { subject } = {}) => {
  const raw = String(text || '');
  if (!raw.trim()) {
    return Object.freeze({ candidates: Object.freeze([]), primary: Object.freeze({ type: TYPE_GENERIC, family: FAMILY_GENERIC, source: 'none', confidence: 0 }) });
  }

  const lines = uniq(raw.split(/\n/).map((l) => l.trim()).filter(Boolean));
  const lead = lines[0] || raw;
  const cues = orderedCues();
  const candidates = [];
  const push = (type, source, confidence) => {
    if (!type) return;
    if (candidates.some((c) => c.type === type)) return;
    candidates.push(Object.freeze({ type, family: FAMILY_BY_TYPE[type], source, confidence }));
  };
  const matchCue = (haystack) => {
    for (const [cue, type] of cues) {
      if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(cue)}(?![a-z0-9])`, 'i').test(haystack)) return type;
    }
    return null;
  };

  // 1. Parenthetical disambiguator. Structural and near-certain: this is how
  //    encyclopedic titles carry the qualifier ("Paperclip (film)").
  const paren = /\(([^)]{1,40})\)/.exec(lead);
  let primary = null;
  if (paren) {
    const inner = paren[1];
    const type = matchCue(inner);
    if (type) {
      push(type, 'parenthetical', 0.9);
      primary = { type, family: FAMILY_BY_TYPE[type], source: 'parenthetical', confidence: 0.9 };
    } else if (!/^\s*(19|20)\d{2}\s*$/.test(inner)) {
      // A non-year parenthetical we cannot type: a real disambiguation we
      // failed to read. Recorded so ambiguity is visible instead of lost.
      push(TYPE_GENERIC, 'parenthetical_unknown', 0.3);
      primary = { type: TYPE_GENERIC, family: FAMILY_GENERIC, source: 'parenthetical_unknown', confidence: 0.3 };
    }
  }

  // 2. Title separator. "Paperclip - short film" behaves like a parenthetical.
  if (!primary) {
    const sep = lead.split(/\s+[|\u2013\u2014-]\s+/);
    if (sep.length > 1) {
      const type = matchCue(sep.slice(1).join(' '));
      if (type) {
        push(type, 'title_separator', 0.75);
        primary = { type, family: FAMILY_BY_TYPE[type], source: 'title_separator', confidence: 0.75 };
      }
    }
  }

  // 3. Every body cue, so a hybrid result keeps all of its types.
  for (const match of raw.matchAll(CUE_RE_GLOBAL)) {
    const type = TYPE_BY_CUE.get(String(match[1]).toLowerCase());
    push(type, 'body', 0.5);
  }
  if (!primary) {
    const first = candidates[0];
    primary = first
      ? { type: first.type, family: first.family, source: first.source, confidence: first.confidence }
      : { type: TYPE_GENERIC, family: FAMILY_GENERIC, source: 'untyped', confidence: 0 };
  }

  return Object.freeze({ candidates: Object.freeze(candidates), primary: Object.freeze(primary) });
};

/** Single-type convenience wrapper. */
const inferEntityType = (text, opts) => inferEntityTypes(text, opts).primary;

/**
 * What KIND of thing the user is asking about, from their own words.
 *
 * Returns an empty expected set when the goal expresses no type, which callers
 * must treat as "do not judge type", not as "reject".
 */
const inferExpectedTypes = ({ goal, query, userText, subject } = {}) => {
  // The subject itself is excluded: it carries the name, never the type, and
  // including it would let a name that happens to contain a cue pin the type.
  const parts = [goal, userText, query]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const subjectLower = String(subject || '').trim().toLowerCase();
  const text = parts
    .map((p) => (subjectLower && p.toLowerCase() === subjectLower ? '' : p))
    .filter(Boolean)
    .join(' \n ');

  const families = new Set();
  const types = new Set();
  if (text) {
    const m = GOAL_CUE_RE.exec(text);
    if (m) {
      const family = FAMILY_BY_CUE.get(m[1].toLowerCase());
      if (family) families.add(family);
      // A goal can legitimately name more than one acceptable family
      // ("the movie or the band"). Collect every cue, not just the first.
      for (const match of text.matchAll(new RegExp(GOAL_CUE_RE, 'gi'))) {
        const hit = FAMILY_BY_CUE.get(String(match[1]).toLowerCase());
        if (hit) families.add(hit);
      }
      // An explicit type noun in the goal is a stronger statement than a family.
      for (const match of text.matchAll(CUE_RE_GLOBAL)) {
        const type = TYPE_BY_CUE.get(String(match[1]).toLowerCase());
        if (type) types.add(type);
      }
    }
  }
  return Object.freeze({
    families: Object.freeze([...families]),
    types: Object.freeze([...types]),
    hasExpectation: families.size > 0 || types.size > 0,
  });
};

const COMPATIBLE = 'compatible';
const REFINEMENT = 'refinement';
const MISMATCH = 'mismatch';
const UNJUDGED = 'unjudged';

/**
 * Compare an inferred result type against the goal's expectation.
 *
 *   match     — same type
 *   refinement— same family, narrower kind (docs about a software project)
 *   mismatch  — different family (a film for a technology goal)
 *   unjudged  — either side is untyped, so no verdict is claimed
 */
const compareEntityType = (entity, expected) => {
  if (!entity || !expected || !expected.hasExpectation) {
    return Object.freeze({ compatibility: UNJUDGED, factor: 1, reason: 'no_goal_type_expectation' });
  }
  const candidates = (entity.candidates && entity.candidates.length)
    ? entity.candidates
    : (entity && entity.type ? [entity] : []);

  // ANY compatible candidate is enough. A result that is both a company and a
  // software project answers a technology question, so it must not be refused
  // for also mentioning the company.
  let sawRefinement = false;
  for (const candidate of candidates) {
    if (expected.types && expected.types.includes(candidate.type)) {
      return Object.freeze({ compatibility: COMPATIBLE, factor: 1, reason: 'exact_type_match' });
    }
    if (expected.families && expected.families.includes(candidate.family)) {
      if (candidate.family === FAMILY_BY_TYPE[candidate.type] && candidate.type === TYPE_GENERIC) continue;
      sawRefinement = true;
    }
  }
  if (sawRefinement) {
    return Object.freeze({ compatibility: REFINEMENT, factor: 0.9, reason: 'same_family_refinement' });
  }
  // We could not type the result at all. Judging it against a family we only
  // inferred for the GOAL side is how a filter starts refusing real answers.
  if (!candidates.length) {
    return Object.freeze({ compatibility: UNJUDGED, factor: 1, reason: 'result_is_untyped' });
  }
  // Nothing compatible, and nothing untyped: every candidate we could type sits
  // in a family the goal did not ask for. That is a genuine semantic mismatch.
  if (candidates.some((c) => c.type === TYPE_GENERIC)) {
    return Object.freeze({ compatibility: UNJUDGED, factor: 1, reason: 'result_is_untyped' });
  }
  return Object.freeze({ compatibility: MISMATCH, factor: 0, reason: 'entity_type_family_mismatch' });
};

/**
 * Did the result actually mention the requested subject at all? Word-boundary
 * matched so "paper" does not satisfy "paperclip".
 */
const identityMatch = (texts, subject) => {
  const subjectText = String(subject || '').trim();
  if (!subjectText) return Object.freeze({ matched: true, strength: 1, reason: 'no_subject_to_verify' });
  const haystack = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join(' \n ').toLowerCase();
  if (!haystack) return Object.freeze({ matched: false, strength: 0, reason: 'empty_observation' });
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRe(subjectText.toLowerCase())}(?![a-z0-9])`, 'i');
  if (pattern.test(haystack)) {
    return Object.freeze({ matched: true, strength: 1, reason: 'subject_present' });
  }
  return Object.freeze({ matched: false, strength: 0, reason: 'subject_absent' });
};

module.exports = {
  FAMILY_MEDIA,
  FAMILY_TECHNOLOGY,
  FAMILY_ORGANIZATION,
  FAMILY_PERSON,
  FAMILY_ACADEMIC,
  FAMILY_PLACE,
  FAMILY_EVENT,
  FAMILY_GENERIC,
  TYPE_SOFTWARE_PROJECT,
  TYPE_DOCUMENTATION,
  TYPE_DEVELOPER_TOOL,
  TYPE_API,
  TYPE_PRODUCT_RELEASE,
  TYPE_FILM,
  TYPE_TV_SERIES,
  TYPE_NOVEL,
  TYPE_MUSIC,
  TYPE_GAME,
  TYPE_COMPANY,
  TYPE_NONPROFIT,
  TYPE_PRODUCT_BRAND,
  TYPE_PERSON,
  TYPE_ACADEMIC_WORK,
  TYPE_PLACE,
  TYPE_EVENT,
  TYPE_GENERIC,
  FAMILY_BY_TYPE,
  COMPATIBLE,
  REFINEMENT,
  MISMATCH,
  UNJUDGED,
  inferEntityType,
  inferEntityTypes,
  inferExpectedTypes,
  compareEntityType,
  identityMatch,
};
