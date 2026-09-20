// Shared Voice Runtime 2.0 engine singleton.
//
// useSocket (text path, interrupt, send) and useVoiceTtsChannel (audio path)
// must coordinate on ONE AudioWorklet engine: interrupt flushes the same
// buffer that audio chunks fill, and the first mic/send gesture activates
// the same AudioContext. A module singleton guarantees that without prop
// drilling through every consumer.
import { VoiceAudioEngine } from './VoiceAudioEngine.js';
import { VoiceTelemetry } from '../utils/voiceTelemetry.js';

let sharedEngine = null;
let sharedTelemetry = null;

export const getSharedVoiceEngine = () => {
  if (!sharedEngine && typeof window !== 'undefined') {
    sharedEngine = new VoiceAudioEngine({
      onStateChange: null,
      onUnderrun: (count) => {
        try { getSharedVoiceTelemetry().addUnderruns(1); } catch { /* ignore */ }
        void count;
      },
    });
  }
  return sharedEngine;
};

export const getSharedVoiceTelemetry = () => {
  if (!sharedTelemetry) sharedTelemetry = new VoiceTelemetry();
  return sharedTelemetry;
};
