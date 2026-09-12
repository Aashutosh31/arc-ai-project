// Canonical client history helpers — Stage 2 (cursor pagination).
//
// Pure ESM module: zero imports, no JSX, no React. Safe to unit-test with
// plain node (`node tests/historyLoader.test.mjs`).
//
// DESIGN RULES (from the Stage 0 audit):
// - Server history is authoritative persisted history. NEVER filter by
//   metadata.state / streaming / partial / content shape here. A completed
//   assistant message whose metadata still says state:'streaming' (the
//   success-update write path) is a VALID completed message.
// - Message identity is the database _id. Never dedupe by text/timestamp/index.
// - One normalization path for history loads (initial + older pages).

export const CURSOR_PAGE_SIZE = 40;

// Markdown-structure-safe sanitizer. Must stay behavior-identical to
// sanitizeForDisplay in contexts/ChatContext.jsx (history text and the
// streaming finalizer must agree, or reloads visibly alter messages).
export const sanitizeHistoryText = (text) => {
  if (!text || typeof text !== 'string') return text;
  let t = String(text);
  t = t.replace(/\r\n|\r/g, '\n');
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
};

// Canonical client message shape:
//   { id, sender, text, isStreaming, interrupted, attachments?, image?, documentName? }
// `id` is the database _id when the message came from history, null for
// live socket messages (which carry no identity yet). Accepts both server
// ({role, content}) and socket ({sender, text}) raw shapes so one helper
// covers history and live messages without rewriting socket payloads.
export function normalizeHistoryMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = raw.content ?? raw.text ?? '';
  const id = raw._id ?? raw.id ?? null;
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const hasText = content !== null && content !== undefined && String(content) !== '';
  // Genuinely invalid: no identity, no text, no attachments, no media echo.
  if (id === null && !hasText && attachments.length === 0 && !raw.image && !raw.documentName) return null;
  const role = raw.role ?? raw.sender ?? 'ai';
  return {
    id: id === null || id === undefined ? null : String(id),
    sender: role === 'user' ? 'user' : 'ai',
    text: sanitizeHistoryText(String(content ?? '')),
    isStreaming: false,
    interrupted: Boolean(raw.interrupted ?? raw.metadata?.interrupted ?? false),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(raw.image ? { image: raw.image } : {}),
    ...(raw.documentName ? { documentName: raw.documentName } : {})
  };
}

export function normalizeHistoryPage(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  const out = [];
  for (const raw of rawMessages) {
    const msg = normalizeHistoryMessage(raw);
    if (msg) out.push(msg);
  }
  return out;
}

// Prepend older messages ahead of current, chronological, deduped by id.
// Live (id-less) messages are always kept — they have no server identity yet
// and prepend only touches the head, so the live tail is never at risk.
// Apply inside a functional setState so races with streaming appends dedupe
// against the latest state, not a stale snapshot.
export function prependMessages(current, fresh) {
  const list = Array.isArray(current) ? current : [];
  const incoming = Array.isArray(fresh) ? fresh : [];
  if (incoming.length === 0) return list;
  const known = new Set();
  for (const m of list) {
    if (m && m.id !== null && m.id !== undefined) known.add(String(m.id));
  }
  const novel = incoming.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    if (m.id === null || m.id === undefined) return true;
    return !known.has(String(m.id));
  });
  if (novel.length === 0) return list;
  return [...novel, ...list];
}

const staleError = () => {
  const err = new Error('stale history request superseded');
  err.code = 'STALE';
  return err;
};

const noMoreError = () => {
  const err = new Error('no older history available');
  err.code = 'NO_MORE';
  return err;
};

function linkSignal(external, controller) {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

// Cursor history loader. Owns per-conversation pagination bookkeeping
// (oldestId / hasMore / total), request sequencing (stale protection) and
// cancellation (AbortController). Holds no message content and no cache:
// every conversation open re-fetches the latest page from the server.
export class HistoryLoader {
  constructor(fetchPage) {
    if (typeof fetchPage !== 'function') throw new Error('HistoryLoader requires a fetchPage function');
    this.fetchPage = fetchPage;
    this.conversationId = null;
    this.oldestId = null;
    this.hasMore = false;
    this.total = 0;
    this.seq = 0;
    this.controller = null;
  }

  reset() {
    this.abort();
    this.conversationId = null;
    this.oldestId = null;
    this.hasMore = false;
    this.total = 0;
  }

  abort() {
    if (this.controller) {
      try { this.controller.abort(); } catch { /* ignore */ }
      this.controller = null;
    }
  }

  throwIfStale(captured) {
    if (captured !== this.seq) throw staleError();
  }

  beginRequest(externalSignal) {
    // New request supersedes any in-flight one: abort + invalidate its seq.
    this.abort();
    const captured = ++this.seq;
    const controller = new AbortController();
    this.controller = controller;
    const unlink = linkSignal(externalSignal, controller);
    return { captured, controller, unlink };
  }

  endRequest(controller, unlink) {
    try { unlink(); } catch { /* ignore */ }
    if (this.controller === controller) this.controller = null;
  }

  // Latest page bootstrap. First tries a single small page: conversations at
  // or under one page resolve in ONE request. Larger histories use the
  // server-reported total to anchor a skip-based latest-page fetch (the
  // legacy path is unchanged server-side), then cursor `before` pages after.
  // Bounded re-anchor loop covers messages arriving mid-bootstrap.
  async loadLatest(conversationId, { signal } = {}) {
    const { captured, controller, unlink } = this.beginRequest(signal);
    try {
      this.conversationId = conversationId;
      let first = await this.fetchPage(conversationId, {
        limit: CURSOR_PAGE_SIZE, skip: 0, signal: controller.signal
      });
      this.throwIfStale(captured);
      let total = Number(first?.total || 0);
      let messages = normalizeHistoryPage(first?.messages);
      let hasMore = Boolean(first?.hasMore);

      let attempts = 0;
      while (hasMore && attempts < 3) {
        attempts += 1;
        const skip = Math.max(0, total - CURSOR_PAGE_SIZE);
        first = await this.fetchPage(conversationId, {
          limit: CURSOR_PAGE_SIZE, skip, signal: controller.signal
        });
        this.throwIfStale(captured);
        total = Number(first?.total ?? total);
        messages = normalizeHistoryPage(first?.messages);
        hasMore = Boolean(first?.hasMore);
      }

      this.oldestId = messages.length > 0 ? messages[0].id : null;
      // hasMore means "older messages exist beyond this page". The legacy
      // skip window's hasMore only covers its own slice (an anchored latest
      // page of a 95-message history reports false), so derive it from the
      // authoritative total: anything beyond the loaded tail is older.
      this.hasMore = total > messages.length || hasMore;
      this.total = total;
      return { messages, oldestId: this.oldestId, hasMore: this.hasMore, total };
    } finally {
      this.endRequest(controller, unlink);
    }
  }

  // Older page strictly before the oldest loaded message. `current` is the
  // visible list at call time (used for id dedupe); callers must ALSO apply
  // prependMessages() functionally so streaming appends that land mid-fetch
  // cannot produce duplicates.
  async loadOlder(current, { signal } = {}) {
    if (!this.hasMore || !this.oldestId) throw noMoreError();
    const { captured, controller, unlink } = this.beginRequest(signal);
    try {
      const res = await this.fetchPage(this.conversationId, {
        limit: CURSOR_PAGE_SIZE, before: this.oldestId, signal: controller.signal
      });
      this.throwIfStale(captured);
      const normalized = normalizeHistoryPage(res?.messages);
      const known = new Set();
      for (const m of Array.isArray(current) ? current : []) {
        if (m && m.id !== null && m.id !== undefined) known.add(String(m.id));
      }
      const fresh = normalized.filter((m) => m.id === null || m.id === undefined || !known.has(String(m.id)));
      // Advance the cursor from server truth (not the deduped set) so a
      // fully-duplicate page still chains correctly.
      this.oldestId = normalized.length > 0 ? normalized[0].id : this.oldestId;
      this.hasMore = Boolean(res?.hasMore);
      if (typeof res?.total === 'number') this.total = res.total;
      return { messages: fresh, oldestId: this.oldestId, hasMore: this.hasMore };
    } finally {
      this.endRequest(controller, unlink);
    }
  }
}
