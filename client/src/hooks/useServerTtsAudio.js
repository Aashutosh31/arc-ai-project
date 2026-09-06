import { useCallback, useEffect, useRef } from 'react';
import { useChat } from '../contexts/ChatContext';
import { canPlayServerAudio, base64ToBlobUrl, revokeBlobUrl } from '../utils/ttsAudio';

// Client-side queue for server-generated TTS audio segments.
//
// Voice state machine (audio side):
//   idle → speaking → idle
//   speaking → interrupted → idle
// A new request (or terminal event) always returns to idle via reset().
// `isSpeaking` is true ONLY while audio is audibly playing or queued behind
// a playing segment — never while merely waiting for segments.
//
// Guarantees: order preserved (index-sorted), no overlap (single chain),
// no stale audio after a new request (session ids), per-chunk errors skip
// forward instead of wedging, Blob URLs revoked after use.
export const useServerTtsAudio = () => {
  const { setIsSpeaking } = useChat();
  const queueRef = useRef([]);
  const currentRef = useRef(null);
  const preloadedRef = useRef(null);
  const sessionRef = useRef(0);
  const setIsSpeakingRef = useRef(setIsSpeaking);

  useEffect(() => {
    setIsSpeakingRef.current = setIsSpeaking;
  }, [setIsSpeaking]);

  const setSpeaking = useCallback((value) => {
    try {
      setIsSpeakingRef.current(Boolean(value));
    } catch {
      // state updates must never break audio teardown
    }
  }, []);

  const clearPreloaded = useCallback(() => {
    if (preloadedRef.current) {
      try {
        preloadedRef.current.el?.pause?.();
      } catch {
        // ignore
      }
      revokeBlobUrl(preloadedRef.current.url);
      preloadedRef.current = null;
    }
  }, []);

  const finishSession = useCallback((session) => {
    if (session !== sessionRef.current) return;
    currentRef.current = null;
    clearPreloaded();
    if (queueRef.current.length === 0) {
      setSpeaking(false);
    }
  }, [clearPreloaded, setSpeaking]);

  const advance = useCallback((session) => {
    if (session !== sessionRef.current) return;
    const finished = currentRef.current;
    currentRef.current = null;
    if (finished) {
      try {
        finished.el?.pause?.();
      } catch {
        // ignore
      }
      revokeBlobUrl(finished.url);
    }

    queueRef.current.sort((a, b) => a.index - b.index);
    const next = queueRef.current.shift();
    if (!next) {
      finishSession(session);
      return;
    }

    let element = null;
    if (preloadedRef.current && preloadedRef.current.url === next.url) {
      element = preloadedRef.current.el;
      preloadedRef.current = null;
    } else {
      clearPreloaded();
      try {
        element = new window.Audio(next.url);
      } catch {
        advance(session);
        return;
      }
    }

    currentRef.current = { url: next.url, el: element };
    setSpeaking(true);

    element.onended = () => advance(session);
    element.onerror = () => {
      console.debug('[ServerTTS] segment playback failed, skipping ahead');
      advance(session);
    };

    // Pre-buffer the following segment while this one plays.
    const following = queueRef.current[0];
    if (following && (!preloadedRef.current || preloadedRef.current.url !== following.url)) {
      try {
        const pre = new window.Audio(following.url);
        pre.preload = 'auto';
        try {
          pre.load();
        } catch {
          // some browsers throw on explicit load(); playback still works
        }
        preloadedRef.current = { url: following.url, el: pre };
      } catch {
        // pre-buffering is best-effort only
      }
    }

    try {
      const playPromise = element.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          // Autoplay blocked (no user gesture yet): end speaking state
          // instead of wedging the UI in "Speaking" forever.
          console.debug('[ServerTTS] playback blocked, ending audio session');
          if (session === sessionRef.current) {
            queueRef.current = [];
            finishSession(session);
          }
        });
      }
    } catch {
      advance(session);
    }
  }, [clearPreloaded, finishSession, setSpeaking]);

  const enqueueSegment = useCallback((segment) => {
    if (!segment || !segment.audio) return false;
    if (!canPlayServerAudio()) return false;
    const session = sessionRef.current;
    let url = null;
    try {
      url = base64ToBlobUrl(segment.audio, segment.mimeType || 'audio/wav');
    } catch {
      return false;
    }
    queueRef.current.push({ index: Number(segment.index) || 0, url });
    if (!currentRef.current) {
      advance(session);
    }
    return true;
  }, [advance]);

  // Drop everything: pause playback, revoke URLs, bump the session so any
  // in-flight 'ended'/play promises become harmless no-ops.
  const reset = useCallback(() => {
    sessionRef.current += 1;
    if (currentRef.current) {
      try {
        currentRef.current.el?.pause?.();
      } catch {
        // ignore
      }
      revokeBlobUrl(currentRef.current.url);
      currentRef.current = null;
    }
    clearPreloaded();
    for (const item of queueRef.current) revokeBlobUrl(item.url);
    queueRef.current = [];
    setSpeaking(false);
  }, [clearPreloaded, setSpeaking]);

  // Release resources on unmount.
  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      try {
        currentRef.current?.el?.pause?.();
      } catch {
        // ignore during unmount
      }
      if (currentRef.current) revokeBlobUrl(currentRef.current.url);
      if (preloadedRef.current) revokeBlobUrl(preloadedRef.current.url);
      for (const item of queueRef.current) revokeBlobUrl(item.url);
      queueRef.current = [];
    };
  }, []);

  return { enqueueSegment, resetAudio: reset, flushAudio: reset, canPlayServerAudio };
};
