// ARC does not speak.
//
// Text-to-speech OUTPUT was removed on 2026-10-19 (product decision: ARC must
// not dictate replies aloud on web or mobile). Microphone/STT input is
// unaffected — voice input keeps working.
//
// This hook is kept as a deliberately inert adapter so existing call sites
// (useSocket's streaming + reminder paths) stay unchanged: it exposes the same
// surface but never produces audio and never reports "speaking". The browser
// speechSynthesis path is gone entirely.
import { useCallback } from 'react';

const noop = () => {};

export const useTextToSpeech = () => {
  const processStreamChunk = useCallback(noop, []);
  const stop = useCallback(noop, []);
  const speak = useCallback(noop, []);

  return { speak, processStreamChunk, stop, stopSpeech: stop };
};
