'use strict';

// JARVIS Action Substrate — per-response TTS mode announcer.
//
// `ai:tts:mode` is PER-RESPONSE state. The client treats each arrival as a
// new-response boundary: it hard-resets its playback-ownership machine
// (`workletSeen := false`) and its legacy WAV queue, then re-arms the legacy
// path as the fallback. It does NOT stop the AudioWorklet that may still be
// speaking.
//
// So emitting `ai:tts:mode` twice for ONE response re-admits the legacy
// `ai:tts:audio` (base64 WAV -> HTMLAudioElement) path while the streaming PCM
// path is still audible. The server synthesizes both channels from the same
// text, so the client then opens two `window.Audio`/worklet voices for the
// same sentence — the reported "same sentence, two different voices" bug.
//
// The invariant enforced here: exactly ONE announcement per response, and the
// first announcement wins (a later, contradictory mode must not flip the
// client mid-response).
//
// The announcement also carries a `responseId`. That is what makes ownership
// enforceable on the client: without identity, a re-announcement for the SAME
// response is indistinguishable from a genuinely new response, so the client is
// forced to either (a) reset and risk a second voice, or (b) never reset and
// risk a stale voice. With `responseId` the client can ignore a repeat for the
// response it is already playing, and still reset correctly for the next one.
//
// One announcer is created per processQuery call, so the "already announced"
// state cannot leak between responses or between users.

const crypto = require('crypto');

const newResponseId = () =>
  `resp_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;

/**
 * @param {object} options
 * @param {{ emit: (event: string, payload: object) => void } | null} options.socket
 * @param {string} [options.responseId] Per-response id; generated when omitted.
 */
const createTtsModeAnnouncer = ({ socket, responseId = newResponseId() } = {}) => {
  let announced = false;

  return {
    /** Stable id for this response, shared by every TTS event of this response. */
    responseId,
    /**
     * Announce the TTS mode for this response. Idempotent: only the first
     * call emits. Safe to call from every TTS decision point in a response.
     * @param {boolean} serverTtsActive
     * @returns {boolean} true if this call emitted, false if suppressed.
     */
    announce(serverTtsActive) {
      if (announced) return false;
      announced = true;
      if (!socket || typeof socket.emit !== 'function') return false;
      socket.emit('ai:tts:mode', {
        mode: serverTtsActive ? 'server' : 'browser',
        responseId,
      });
      return true;
    },
    /** True once a mode has been announced for this response. */
    hasAnnounced() {
      return announced;
    },
  };
};

module.exports = { createTtsModeAnnouncer, newResponseId };
