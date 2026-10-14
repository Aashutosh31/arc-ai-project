// Voice Runtime 3.0 — playback ownership arbitration (pure state machine).
//
// One assistant response can produce audio over TWO concurrent channels:
//   - primary:  binary `voice:tts:audio` (PCM16) → shared AudioWorklet engine
//   - legacy:   `ai:tts:audio` (base64 WAV)       → HTMLAudioElement queue
//
// The server intentionally emits both so old clients keep working; a single
// tab must therefore play exactly ONE of them. Suppressing future legacy
// enqueues once the worklet delivers audio is NOT enough: the legacy queue
// installs + plays synchronously while the worklet path holds audio behind a
// pre-roll (~0.35s) before it becomes audible, so a WAV segment can already
// be open when the worklet's first chunk arrives. That is the intra-tab
// double-voice race — two speaking voices for one response.
//
// This module owns the transition rule so it is testable without React:
//   - a legacy WAV segment may play only while the worklet owns nothing;
//   - the FIRST worklet chunk for a response preempts any live legacy audio
//     (the hook calls its `resetAudio()`), so the hand-off is immediate,
//     not mute-only; subsequent legacy segments are dropped outright.
//   - reset() returns the machine to the "no owner" state for a new
//     response / mode announcement / interrupt / disconnect.
//
// Stream lifecycle (added for the duplicate-voice fix): a NEW STREAM is not
// necessarily a NEW RESPONSE. `voice:tts:start` used to reset() unconditionally,
// which cleared `legacyLive` — the exact bit `onWorkletChunk()` needs to
// preempt an already-playing WAV element. A second stream inside one response
// therefore re-opened the legacy path while the worklet was still speaking.
// beginStream() resets only when no stream is live, so ownership survives a
// within-response stream change while a genuine new response still starts
// clean.
export const createVoiceOwnership = () => {
  let workletSeen = false;
  let legacyLive = false;
  let streamLive = false;

  return {
    // Legacy WAV arrival: may it open/continue? True while the worklet has
    // delivered nothing for this response (legacy remains the fallback).
    legacyShouldPlay() {
      return !workletSeen;
    },
    // The legacy queue admitted a segment (caller actually enqueued it).
    // Only meaningful while the worklet owns nothing.
    markLegacyLive() {
      if (!workletSeen) legacyLive = true;
    },
    // A worklet chunk was accepted (played or staged). Returns whether this
    // is the first such chunk and — crucially — whether a legacy segment is
    // already live and must be preempted by the caller.
    onWorkletChunk() {
      const first = !workletSeen;
      workletSeen = true;
      const preemptLegacy = first && legacyLive;
      legacyLive = false;
      return { first, preemptLegacy };
    },
    workletOwns() {
      return workletSeen;
    },
    // A `voice:tts:start` arrived.
    //   continuation === false -> first stream of this response; stale state
    //                             was cleared here so the response starts
    //                             with no owner.
    //   continuation === true  -> another stream inside the SAME response
    //                             (a superseding session). Ownership is
    //                             deliberately PRESERVED: clearing it would
    //                             re-admit the legacy WAV path on top of the
    //                             voice already playing.
    beginStream() {
      const continuation = streamLive;
      if (!continuation) {
        workletSeen = false;
        legacyLive = false;
      }
      streamLive = true;
      return { continuation, first: !continuation };
    },
    // The stream finished (or was cancelled). The response itself is over, so
    // the next beginStream() must be treated as a fresh response again.
    endStream() {
      streamLive = false;
    },
    isStreamLive() {
      return streamLive;
    },
    reset() {
      workletSeen = false;
      legacyLive = false;
      streamLive = false;
    },
  };
};
