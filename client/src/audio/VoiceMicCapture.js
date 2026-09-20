// Voice Runtime FINAL — microphone capture engine.
//
// The browser captures REAL microphone audio via getUserMedia (the only
// standardized primitive) and ships it as 24 kHz mono PCM16 frames to the
// ARC backend.  The browser NEVER performs speech recognition.
//
// Input pipeline:
//   getUserMedia({ audio: { echoCancellation, noiseSuppression,
//                           autoGainControl } })
//     → AudioContext (device default rate — never forced)
//     → static-same-origin /voice-mic-worklet.js (Blob fallback)
//     → AudioWorkletNode (mono) resamples to 24 kHz and frames PCM16
//     → main thread onFrame(packet) → authenticated socket
//
// Fallbacks (never browser-name specific):
//   * If AudioWorklet init fails, a ScriptProcessorNode performs the same
//     resampling+packing on the main thread.
//
// Diagnostics/counters only — raw microphone audio is never logged.
import { resampleFloat32 } from "./VoiceAudioEngine.js";
import {
  VOICE_MIC_WORKLET_NAME,
  VOICE_MIC_FORMAT,
  VOICE_MIC_WORKLET_SOURCE,
} from "./voiceMicWorklet.js";

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const FRAME_FLOAT_SAMPLES = VOICE_MIC_FORMAT.sampleRate / 10; // 2400

const floatToInt16 = (samples) => {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return int16;
};

const isDevOrTest = () => {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) return true;
  } catch {
    /* ignore */
  }
  try {
    return (
      typeof window !== "undefined" &&
      /(^\?|&)test=1/.test(window.location?.search || "")
    );
  } catch {
    /* ignore */
  }
  return false;
};

export class VoiceMicCapture {
  constructor({ allowInject = null } = {}) {
    this.allowInject =
      allowInject === null ? isDevOrTest() : Boolean(allowInject);
    this.stream = null;
    this.audioCtx = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.workletSink = null;
    this.scriptNode = null;
    this.analyser = null;
    this.workletUsed = null; // 'static' | 'blob' | 'script' | null
    this.framingEnabled = true;
    this.seq = 0;
    this.counters = {
      framesEmitted: 0,
      bytesEmitted: 0,
      framesDropped: 0,
      workletFrames: 0,
    };
    this._onFrame = null;
    this._vadRunning = false;
    // ScriptProcessor fallback accumulator (headless-safe).
    this._floatPending = [];
    this._harnessInjected = [];
    // Generation guard for the start/stop lifecycle. start() captures the
    // current generation, then every async continuation (getUserMedia →
    // _initGraph → worklet addModule) re-validates it. A concurrent stop()
    // increments the generation so any stale continuation aborts WITHOUT
    // touching audio nodes — the previous code could resume into
    // createMediaStreamSource(null) and throw "Argument 1 is not an object"
    // (surfaced as VOICE_MIC_FAILED despite a healthy mic).
    this._gen = 0;
  }

  _genIsCurrent(gen) {
    return gen === this._gen && this.stream instanceof MediaStream;
  }

  get running() {
    return Boolean(
      this.stream && this.stream.active && this.audioCtx && this.sourceNode,
    );
  }

  // ---- Lifecycle ----------------------------------------------------------
  // Starts capture (idempotent): onFrame({ seq, format, bytes }) where bytes
  // is an Int16Array of PCM16 LE mono 24 kHz. Throws on permission errors;
  // onError is invoked for async failures after start.
  async start({ onFrame = null, onError = null } = {}) {
    if (!onFrame && !onError) {
      // Programmatic re-entrancy guard: a second start() while an earlier
      // start() is still awaiting getUserMedia must NOT race stop(). Handled
      // by the generation stamp below instead of a naive running() check.
    }
    const gen = this._gen + 1;
    this._gen = gen;
    if (onFrame) this._onFrame = onFrame;
    let got;
    try {
      got = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      onError?.(err);
      throw err;
    }
    // A stop() (or a superseding restart) landing during the getUserMedia
    // await invalidates this start; drop the freshly-acquired track so it is
    // never mistaken for an active session. NOTE: only the generation stamp
    // is checked here — this.stream is assigned two lines below, so the
    // stream-instance check would abort EVERY first start.
    if (gen !== this._gen) {
      try {
        for (const t of got?.getTracks?.() || []) t.stop();
      } catch {
        /* ignore */
      }
      return { ok: false, aborted: true };
    }
    this.stream = got;
    try {
      await this._initGraph(gen);
      if (!this._genIsCurrent(gen)) {
        // stop() arrived mid-graph; tear down whatever _initGraph built.
        await this.stop();
        return { ok: false, aborted: true };
      }
    } catch (err) {
      await this.stop();
      onError?.(err);
      throw err;
    }
    return { ok: true, reused: false };
  }

  async _initGraph() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx)
      throw Object.assign(
        new Error("Web Audio is not available in this browser."),
        { code: "VOICE_NO_WEB_AUDIO" },
      );
    this.audioCtx = new Ctx(); // device default rate
    if (this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch {
        /* resume may need a gesture; VAD waits for frames */
      }
    }
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.sourceRate = this.audioCtx.sampleRate || 48000;

    // VAD source: AnalyserNode reads main-thread RMS for silence-submit and
    // barge-in. No recognition involved — energy only.
    try {
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.sourceNode.connect(this.analyser);
    } catch {
      this.analyser = null;
    }

    let workletOk = false;
    if (this.audioCtx.audioWorklet) {
      try {
        // Primary: static same-origin module (best Firefox worklet support).
        const staticUrl = new URL(
          "/voice-mic-worklet.js",
          window.location.origin,
        ).href;
        await this.audioCtx.audioWorklet.addModule(staticUrl);
        this.workletUsed = "static";
        workletOk = true;
      } catch {
        try {
          // Fallback: identical Blob-sourced module.
          const blobUrl = URL.createObjectURL(
            new Blob([VOICE_MIC_WORKLET_SOURCE], { type: "text/javascript" }),
          );
          await this.audioCtx.audioWorklet.addModule(blobUrl);
          this.workletUsed = "blob";
          workletOk = true;
        } catch {
          this.workletUsed = null;
        }
      }
    }

    this.connected = this.sourceNode;

    if (workletOk) {
      try {
        this.workletNode = new AudioWorkletNode(
          this.audioCtx,
          VOICE_MIC_WORKLET_NAME,
          {
            numberOfInputs: 1,
            // Keep the node in a pulled audio graph. Some engines suspend a
            // zero-output processor even when its input is connected, which
            // looks like a healthy worklet but yields no microphone frames.
            // Its output is routed through a zero-gain sink, so this does not
            // create a second capture path or audible loopback.
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
          },
        );
      } catch {
        this.workletNode = null;
        workletOk = false;
      }
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = (event) => {
        const data = event?.data || {};
        if (this.framingEnabled && data.type === "frames" && this._onFrame) {
          this.counters.framesEmitted += 1;
          this.counters.bytesEmitted += data.bytes?.byteLength || 0;
          this.counters.workletFrames += 1;
          if (this.counters.framesEmitted === 1) {
            console.debug(
              "[Voice] microphone worklet emitted first PCM frame",
              {
                bytes: data.bytes?.byteLength || 0,
                sampleRate:
                  data.format?.sampleRate || VOICE_MIC_FORMAT.sampleRate,
              },
            );
          }
          this._onFrame({
            seq: data.seq,
            format: data.format || VOICE_MIC_FORMAT,
            bytes: data.bytes,
            sourceRate: this.sourceRate,
          });
        } else if (!this.framingEnabled && data.type === "frames") {
          this.counters.framesDropped += 1;
        }
      };
      this.connected.connect(this.workletNode);
      this.workletSink = this.audioCtx.createGain();
      this.workletSink.gain.value = 0;
      this.workletNode.connect(this.workletSink);
      this.workletSink.connect(this.audioCtx.destination);
      return;
    }

    // ScriptProcessor fallback: same deterministic framing on main thread.
    const sourceRate = this.sourceRate;
    this.scriptNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.scriptNode.onaudioprocess = (event) => {
      if (!this.framingEnabled) {
        this.counters.framesDropped += 1;
        return;
      }
      const input = event?.inputBuffer?.getChannelData?.(0);
      if (!input) return;
      const resampled = resampleFloat32(
        input,
        sourceRate,
        VOICE_MIC_FORMAT.sampleRate,
      );
      this._floatPending.push(Array.from(resampled));
      this._drainPending();
    };
    this.connected.connect(this.scriptNode);
    const silent = this.audioCtx.createGain();
    silent.gain.value = 0;
    this.scriptNode.connect(silent);
    silent.connect(this.audioCtx.destination);
  }

  _drainPending() {
    while (this._floatPending.length) {
      let combined = [];
      while (
        combined.length < FRAME_FLOAT_SAMPLES &&
        this._floatPending.length
      ) {
        const next = this._floatPending.shift();
        combined = combined.concat(next);
      }
      if (combined.length >= FRAME_FLOAT_SAMPLES) {
        const frame = combined.slice(0, FRAME_FLOAT_SAMPLES);
        const rest = combined.slice(FRAME_FLOAT_SAMPLES);
        if (rest.length) this._floatPending.unshift(rest);
        this._emitFrame(frame);
      } else {
        this._floatPending.unshift(combined);
        break;
      }
    }
  }

  _emitFrame(floatSamples) {
    if (!this.framingEnabled || !this._onFrame) {
      this.counters.framesDropped += 1;
      return;
    }
    this.counters.framesEmitted += 1;
    this.counters.bytesEmitted += floatSamples.length * 2;
    this._onFrame({
      seq: this.seq++,
      format: VOICE_MIC_FORMAT,
      bytes: floatToInt16(new Float32Array(floatSamples)),
      sourceRate: this.sourceRate,
    });
  }

  // Stops framing to transport (keeps mic live for barge-in VAD).
  setFramingEnabled(enabled) {
    this.framingEnabled = Boolean(enabled);
    if (this.framingEnabled) {
      this._floatPending = [];
      this._floatPending.length = 0;
    }
  }

  getAnalyser() {
    return this.analyser || null;
  }

  // Must be called from a user gesture when the context is suspended.
  async ensureFromGesture() {
    if (!this.audioCtx) return false;
    try {
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      return this.audioCtx.state === "running";
    } catch {
      return false;
    }
  }

  async stop() {
    const tracks = this.stream?.getTracks?.() || [];
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    this.stream = null;
    try {
      this.workletNode?.port?.postMessage?.(null); // not supported; no-op
    } catch {
      /* ignore */
    }
    try {
      if (this.scriptNode) {
        this.scriptNode.onaudioprocess = null;
        this.scriptNode.disconnect();
      }
    } catch {
      /* ignore */
    }
    this.scriptNode = null;
    try {
      this.workletNode?.disconnect?.();
      this.workletSink?.disconnect?.();
    } catch {
      /* ignore */
    }
    this.workletNode = null;
    this.workletSink = null;
    this.sourceNode = null;
    this.analyser = null;
    try {
      await this.audioCtx?.close?.();
    } catch {
      /* ignore */
    }
    this.audioCtx = null;
    this._floatPending = [];
  }

  // ---- Test-injection hook (dev/harness only) -----------------------------
  // Injects Float32Array PCM samples AS IF they had just been captured and
  // resampled to 24 kHz by the worklet. Exercises framing → transport → STT
  // exactly like real mic audio. Never enabled in production builds.
  __injectFloat24k(samples) {
    if (!this.allowInject) return false;
    const f = Array.from(samples || []);
    this._floatPending.push(f);
    this._drainPending();
    return true;
  }

  // ---- Diagnostics --------------------------------------------------------
  getDiagnostics() {
    return {
      running: this.running,
      contextState: this.audioCtx?.state || null,
      sampleRate: this.audioCtx?.sampleRate || this.sourceRate || null,
      workletUsed: this.workletUsed,
      counters: { ...this.counters },
    };
  }
}

export const createVoiceMicCapture = (options) => new VoiceMicCapture(options);
export { VOICE_MIC_FORMAT };
