// Explicit voice interaction state machine for Advanced Voice Mode.
//
// Half-duplex invariant enforced by this machine:
//   state === 'speaking'  → microphone capture MUST be stopped
//   state === 'listening' → TTS playback MUST NOT be active
//
// States: idle → listening → processing → speaking → listening → ...
//   - interrupted: transient barge-in state, always resolves to listening
//   - error:       terminal until the user re-toggles
//
// Every listening cycle gets a unique turn id. Entering any other state
// invalidates the previous turn, so late browser callbacks (recognition
// results, recorder onstop, transcription responses) that carry a stale
// turn id must be ignored by callers via isTurnValid().
//
// Framework-free and DOM-free so it can be unit-tested under Node.
// Timing delays (clean-restart boundaries) live with the caller; this
// machine transitions synchronously and deterministically.

export const VOICE_INTERACTION_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
});

export class VoiceInteractionMachine {
  constructor({ actions = {}, log = null } = {}) {
    this.actions = actions;
    this.log = typeof log === 'function' ? log : () => {};
    this.state = VOICE_INTERACTION_STATES.IDLE;
    this.turn = 0;
    this.active = false;
    this.errorMessage = null;
  }

  _emit(next, reason) {
    this.state = next;
    this.log(`[Advanced Voice] state: ${next} (turn ${this.turn})${reason ? ` - ${reason}` : ''}`);
    try {
      this.actions.onStateChange?.(next);
    } catch {
      // UI sync must never break the machine
    }
  }

  _nextTurn() {
    this.turn += 1;
    return this.turn;
  }

  isTurnValid(turn) {
    return this.active && turn === this.turn;
  }

  // OFF → LISTENING. Caller must have resolved the input mode already.
  activate(reason = 'activated') {
    this.active = true;
    this.errorMessage = null;
    const turn = this._nextTurn();
    this._emit(VOICE_INTERACTION_STATES.LISTENING, reason);
    try {
      this.actions.startCapture?.(turn);
    } catch {
      // capture failures are reported through onError by the caller
    }
    return turn;
  }

  // Single-button semantics per state. Returns what happened.
  toggle() {
    if (!this.active || this.state === VOICE_INTERACTION_STATES.IDLE) {
      this.activate();
      return 'activated';
    }
    if (this.state === VOICE_INTERACTION_STATES.SPEAKING) {
      this.bargeIn();
      return 'barged-in';
    }
    if (this.state === VOICE_INTERACTION_STATES.PROCESSING) {
      try {
        this.actions.interruptGeneration?.();
      } catch {
        // ignore
      }
      this.deactivate('cancelled during processing');
      return 'cancelled';
    }
    // listening / interrupted / error → exit fully
    this.deactivate('toggled off');
    return 'deactivated';
  }

  // A user utterance was finalized while listening. Returns true when the
  // caller should submit the command; false means "late/stale, drop it".
  onUtteranceSubmitted(turn) {
    if (!this.isTurnValid(turn) || this.state !== VOICE_INTERACTION_STATES.LISTENING) {
      return false;
    }
    this._nextTurn();
    this._emit(VOICE_INTERACTION_STATES.PROCESSING, 'utterance submitted');
    try {
      this.actions.stopCapture?.('processing');
    } catch {
      // ignore
    }
    return true;
  }

  // Authoritative "ARC started speaking" signal (canonical isSpeaking).
  onSpeechStarted() {
    if (!this.active) return false;
    if (
      this.state !== VOICE_INTERACTION_STATES.PROCESSING &&
      this.state !== VOICE_INTERACTION_STATES.LISTENING
    ) {
      return false;
    }
    this._nextTurn();
    this._emit(VOICE_INTERACTION_STATES.SPEAKING, 'ai speech started');
    try {
      this.actions.stopCapture?.('speaking');
    } catch {
      // ignore
    }
    return true;
  }

  // Authoritative "ARC finished and generation is done" signal. Caller must
  // only invoke when isSpeaking === false AND generation is settled.
  onSpeechEnded() {
    if (!this.active) return false;
    if (
      this.state !== VOICE_INTERACTION_STATES.SPEAKING &&
      this.state !== VOICE_INTERACTION_STATES.PROCESSING
    ) {
      return false;
    }
    const turn = this._nextTurn();
    this._emit(VOICE_INTERACTION_STATES.LISTENING, 'arc finished speaking');
    try {
      this.actions.startCapture?.(turn);
    } catch {
      // capture failures are reported through onError by the caller
    }
    return true;
  }

  // Stay in listening but start a fresh capture cycle with a new turn
  // (e.g. after an empty/silent cycle). Late callbacks from the previous
  // cycle carry the old turn and are discarded.
  restartListening(reason = 'cycle refresh') {
    if (!this.active || this.state !== VOICE_INTERACTION_STATES.LISTENING) {
      return false;
    }
    const turn = this._nextTurn();
    this.log(`[Advanced Voice] state: listening (turn ${turn}) - ${reason}`);
    try {
      this.actions.startCapture?.(turn);
    } catch {
      // capture failures are reported through onError by the caller
    }
    return true;
  }

  // SPEAKING → INTERRUPTED → LISTENING. Stays in voice mode; mic restarts.
  bargeIn() {
    if (!this.active || this.state !== VOICE_INTERACTION_STATES.SPEAKING) {
      return false;
    }
    this._emit(VOICE_INTERACTION_STATES.INTERRUPTED, 'user barge-in');
    try {
      this.actions.interruptGeneration?.();
    } catch {
      // ignore
    }
    const turn = this._nextTurn();
    this._emit(VOICE_INTERACTION_STATES.LISTENING, 'barge-in');
    try {
      this.actions.startCapture?.(turn);
    } catch {
      // capture failures are reported through onError by the caller
    }
    return true;
  }

  onError(message) {
    this._nextTurn();
    this.errorMessage = message || 'Voice error';
    this._emit(VOICE_INTERACTION_STATES.ERROR, this.errorMessage);
    try {
      this.actions.stopCapture?.('error');
    } catch {
      // ignore
    }
  }

  deactivate(reason = 'deactivated') {
    this.active = false;
    this._nextTurn();
    this._emit(VOICE_INTERACTION_STATES.IDLE, reason);
    try {
      this.actions.stopCapture?.('deactivated');
    } catch {
      // ignore
    }
  }
}
