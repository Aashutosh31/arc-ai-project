// Voice Runtime 3.0 — development telemetry.
//
// Measures: LLM first meaningful sentence → first TTS audio chunk →
// first audible playback, plus totals, underruns, and interruption:
// interruptRequestedAt → audioActuallyStoppedAt (<100ms perceived target).
// Also carries network-audio counters (stream starts, chunks, bytes,
// frames received/rendered) for the acceptance gate.
// Never logs message text — counts and timings only.

export class VoiceTelemetry {
  constructor() {
    this.reset();
  }
  reset() {
    this.llmFirstSentenceAt = null;
    this.ttsFirstByteAt = null;
    this.audioPlaybackStartAt = null;
    this.ttsEndAt = null;
    this.bufferUnderruns = 0;
    this.interruptRequestedAt = null;
    this.audioActuallyStoppedAt = null;
    this.interruptCompletedAt = null;
    // Network audio path counters (mirrored from socket/engine events).
    this.ttsStreamStarted = 0;
    this.ttsAudioChunks = 0;
    this.ttsAudioBytes = 0;
    this.audioFramesReceived = 0;
    this.audioFramesRendered = 0;
  }
  markLlmFirstSentence(at = Date.now()) {
    if (this.llmFirstSentenceAt == null) this.llmFirstSentenceAt = at;
  }
  markTtsFirstByte(at = Date.now()) {
    if (this.ttsFirstByteAt == null) this.ttsFirstByteAt = at;
  }
  markPlaybackStart(at = Date.now()) {
    if (this.audioPlaybackStartAt == null) this.audioPlaybackStartAt = at;
  }
  markTtsEnd(at = Date.now()) {
    this.ttsEndAt = at;
  }
  addUnderruns(count) {
    this.bufferUnderruns += Number(count) || 0;
  }
  markInterruptRequest(at = Date.now()) {
    this.interruptRequestedAt = at;
    this.audioActuallyStoppedAt = null;
    this.interruptCompletedAt = null;
  }
  // Engine flush timestamp (performance.now or Date.now) — the moment
  // scheduled playback actually stopped.
  markAudioStopped(at = null) {
    const value = at != null ? at : Date.now();
    if (this.audioActuallyStoppedAt == null) this.audioActuallyStoppedAt = value;
  }
  markInterruptComplete(at = Date.now()) {
    this.interruptCompletedAt = at;
  }
  countStreamStart() {
    this.ttsStreamStarted += 1;
  }
  countAudioChunk(bytes = 0) {
    this.ttsAudioChunks += 1;
    this.ttsAudioBytes += Number(bytes) || 0;
  }
  setFrames({ received = null, rendered = null } = {}) {
    if (received != null) this.audioFramesReceived = received;
    if (rendered != null) this.audioFramesRendered = rendered;
  }
  snapshot() {
    const ttsFirstByteMs = this.llmFirstSentenceAt != null && this.ttsFirstByteAt != null
      ? this.ttsFirstByteAt - this.llmFirstSentenceAt : null;
    const audioPlaybackStartMs = this.ttsFirstByteAt != null && this.audioPlaybackStartAt != null
      ? this.audioPlaybackStartAt - this.ttsFirstByteAt : null;
    const ttsTotalMs = this.ttsFirstByteAt != null && this.ttsEndAt != null
      ? this.ttsEndAt - this.ttsFirstByteAt : null;
    // Request and stop share the Date.now() clock; completion is a
    // fallback when the engine timestamp is unavailable.
    const interruptLatencyMs = this.interruptRequestedAt != null && this.audioActuallyStoppedAt != null
      ? this.audioActuallyStoppedAt - this.interruptRequestedAt
      : (this.interruptRequestedAt != null && this.interruptCompletedAt != null
        ? this.interruptCompletedAt - this.interruptRequestedAt : null);
    return {
      ttsFirstByteMs,
      audioPlaybackStartMs,
      ttsTotalMs,
      bufferUnderruns: this.bufferUnderruns,
      interruptLatencyMs,
      ttsStreamStarted: this.ttsStreamStarted,
      ttsFirstAudioByte: this.ttsFirstByteAt,
      ttsAudioChunks: this.ttsAudioChunks,
      ttsAudioBytes: this.ttsAudioBytes,
      audioFramesReceived: this.audioFramesReceived,
      audioFramesRendered: this.audioFramesRendered,
      interruptStart: this.interruptRequestedAt,
      interruptComplete: this.audioActuallyStoppedAt ?? this.interruptCompletedAt,
    };
  }
  log(prefix = '[VoiceTelemetry]') {
    try {
      const snapshot = this.snapshot();
      console.debug(prefix, snapshot);
      return snapshot;
    } catch {
      return this.snapshot();
    }
  }
}
