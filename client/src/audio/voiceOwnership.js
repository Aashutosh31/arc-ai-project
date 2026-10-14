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
//   - a legacy WAV segment may play only while the worklet owns nothing AND
//     no worklet stream has been announced (see legacyShouldPlay());
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
    // Legacy WAV arrival: may it open/continue? True only while the worklet
    // has delivered nothing AND no worklet stream is live for this response.
    //
    // Checking `streamLive` is essential: `voice:tts:start` fires on the
    // first LLM text push (synchronous), while the legacy WAV arrives only
    // after provider synthesis of the first sentence (~1-2s later). So when
    // a stream has been announced, the worklet WILL deliver audio imminently
    // — admitting the legacy opener here is the reported double-voice race:
    // the WAV speaks the first sentence, then the worklet's first chunk
    // preempts it mid-way and re-speaks the whole response from the start.
    // Legacy is only the true fallback when NO stream was announced (server
    // voice inactive, VoiceTtsStreamer init failed, or stream cancelled —
    // cancel/reset clears streamLive and re-admits it).
    legacyShouldPlay() {
      return !workletSeen && !streamLive;
    },
    // The legacy queue admitted a segment (caller actually enqueued it).
    // Deliberately NOT gated on streamLive: admission (legacyShouldPlay) is
    // the primary lock, but if a legacy segment ever IS audible, this bit
    // must record it so the first worklet chunk preempts it — dropping the
    // record would let two voices run. Only meaningful while the worklet
    // has delivered nothing.
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
    //   continuation === false -> first stream of this response; stale
    //                             worklet ownership was cleared here so the
    //                             response starts with no worklet owner.
    //   continuation === true  -> another stream inside the SAME response
    //                             (a superseding session).
    // `legacyLive` is deliberately PRESERVED in both cases: it records a WAV
    // segment that is actually audible right now (a WAV can open before any
    // stream is announced — it is the fallback). Clearing it would strand
    // that open segment: the first worklet chunk would find nothing to
    // preempt and the two voices would run together. A phantom from a
    // previous response is impossible (every response boundary — mode
    // announcement, cancel — runs reset()) and would only cost a harmless
    // extra resetAudio() anyway.
    beginStream() {
      const continuation = streamLive;
      if (!continuation) {
        workletSeen = false;
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
