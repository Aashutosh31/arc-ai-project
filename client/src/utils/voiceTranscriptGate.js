// Voice Runtime 4.0 — transcript gating decision.
//
// The server flags risky transcripts on `voice:stt:final` (§15 low-confidence
// corrections, §17 destructive commands). This pure helper decides whether the
// transcript must be confirmed before it is submitted to ARC. Kept free of DOM
// React so it is unit-testable headlessly.
export const shouldGateTranscript = (data) => {
  const raw = typeof data === 'string' ? { text: data } : (data || {});
  const text = String(raw?.text || '').trim();
  if (!text) return false;
  return Boolean(raw?.needsClarification);
};

// Human-readable reason the transcript was gated, for UI surfacing.
export const transcriptGateReason = (data) => {
  const raw = typeof data === 'string' ? { text: data } : (data || {});
  if (!shouldGateTranscript(raw)) return null;
  if (raw?.destructive) return `destructive-command:${raw.destructive.verb}`;
  if (raw?.reason) return String(raw.reason);
  return 'requires-confirmation';
};