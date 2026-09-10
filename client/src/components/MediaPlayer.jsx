/**
 * ARC floating media mini-player.
 *
 * Consumes the PLAY_MEDIA / STOP_MEDIA protocol: `mediaData` from ChatContext
 * (`{ videoId, title }`, set by useSocket on `ai:client:action`). Renders
 * nothing when there is no media. Uses the YouTube IFrame Player API so we
 * get genuine playback states (playing/paused/ended/error) instead of a
 * blind embed.
 *
 * Autoplay policy: browsers may block unmuted autoplay without a prior user
 * gesture. We attempt autoplay once; if the player is still idle shortly
 * after load we show an explicit "Tap to play" overlay (a real user gesture
 * unlocks it). No retry loops, no hidden-audio hacks.
 */
import React, { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useChat } from '../contexts/ChatContext';
import { isValidYouTubeId } from '../utils/media.js';

const YT_API_SRC = 'https://www.youtube.com/iframe_api';

let apiPromise = null;
const loadYouTubeApi = () => {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = YT_API_SRC;
      tag.async = true;
      tag.onerror = () => {
        apiPromise = null;
        reject(new Error('YouTube API failed to load'));
      };
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(window.YT);
      };
      document.head.appendChild(tag);
      setTimeout(() => reject(new Error('YouTube API load timed out')), 15000);
    });
  }
  return apiPromise;
};

const ERROR_TEXT = {
  2: 'This video cannot be played (invalid request).',
  5: 'The video player failed to load this video.',
  100: 'This video was not found or is private.',
  101: 'The owner does not allow this video to be embedded.',
  150: 'The owner does not allow this video to be embedded.',
};

const Shell = styled.div`
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1400;
  width: min(320px, calc(100vw - 32px));
  border-radius: var(--radius-md);
  /* Compact screens: float above the composer + voice dock instead of
     sitting on the input. */
  @media (max-width: 1024px) {
    right: 12px;
    bottom: 156px;
  }
  border: 1px solid var(--border);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
`;

const Bar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
`;

const Title = styled.div`
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Status = styled.div`
  font-size: 11px;
  color: var(--foreground-subtle);
  white-space: nowrap;
`;

const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--foreground-muted);
  font-size: 14px;
  cursor: pointer;
  &:hover { color: var(--foreground); background: rgba(255, 255, 255, 0.06); }
`;

const FrameWrap = styled.div`
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  ${({ $hidden }) => ($hidden ? 'display: none;' : '')}
`;

const GestureOverlay = styled.button`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
`;

const ErrorBox = styled.div`
  padding: 12px;
  font-size: 12.5px;
  color: var(--destructive-soft);
`;

const COMPACT_QUERY = '(max-width: 1024px)';

const MediaPlayer = () => {
  const { mediaData, setMediaData } = useChat();
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading|ready|playing|paused|ended|error
  const [error, setError] = useState(null);
  // Compact mini-bar on small/medium screens so the player never covers the
  // composer; full card on wide screens. Resets per video, user can override.
  const [minimized, setMinimized] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(COMPACT_QUERY).matches
  );
  const userToggledRef = useRef(false);

  const videoId = mediaData?.videoId;
  const title = mediaData?.title || 'Media';
  const valid = isValidYouTubeId(videoId);

  useEffect(() => {
    userToggledRef.current = false;
    if (typeof window !== 'undefined' && window.matchMedia) {
      setMinimized(window.matchMedia(COMPACT_QUERY).matches);
    }
  }, [videoId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(COMPACT_QUERY);
    const onChange = (e) => {
      if (!userToggledRef.current) setMinimized(e.matches);
    };
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  const setMinimizedUser = (v) => {
    userToggledRef.current = true;
    setMinimized(v);
  };

  useEffect(() => {
    if (!mediaData || !valid) return;
    let cancelled = false;
    let player = null;
    let gestureTimer = null;
    setStatus('loading');
    setError(null);

    loadYouTubeApi().then(
      (YT) => {
        if (cancelled || !mountRef.current) return;
        player = new YT.Player(mountRef.current, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, rel: 0 },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              // Single-shot check: if autoplay was blocked the player stays
              // idle, so surface an explicit tap-to-play action for the user.
              gestureTimer = setTimeout(() => {
                if (!cancelled) {
                  try {
                    const s = playerRef.current?.getPlayerState?.();
                    if (s !== 1) setStatus('ready');
                  } catch {
                    setStatus('ready');
                  }
                }
              }, 1800);
              try {
                e.target.playVideo();
              } catch {
                setStatus('ready');
              }
            },
            onStateChange: (e) => {
              if (cancelled) return;
              const s = e.data;
              if (s === 1) setStatus('playing');
              else if (s === 2) setStatus('paused');
              else if (s === 0) setStatus('ended');
            },
            onError: (e) => {
              if (cancelled) return;
              setError(ERROR_TEXT[e.data] || 'This video could not be played.');
              setStatus('error');
            },
          },
        });
        playerRef.current = player;
      },
      (err) => {
        if (cancelled) return;
        setError(err?.message || 'Media player failed to load.');
        setStatus('error');
      }
    );

    return () => {
      cancelled = true;
      if (gestureTimer) clearTimeout(gestureTimer);
      try {
        player?.destroy?.();
      } catch {
        // ignore teardown errors
      }
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [mediaData, valid, videoId]);

  if (!mediaData) return null;

  const close = () => {
    try {
      playerRef.current?.stopVideo?.();
    } catch {
      // ignore
    }
    setMediaData(null);
  };

  const toggle = () => {
    try {
      const s = playerRef.current?.getPlayerState?.();
      if (s === 1) playerRef.current.pauseVideo();
      else playerRef.current?.playVideo?.();
    } catch {
      // ignore
    }
  };

  const statusText =
    status === 'playing' ? 'Playing'
    : status === 'paused' ? 'Paused'
    : status === 'ended' ? 'Ended'
    : status === 'error' ? 'Error'
    : 'Loading…';

  return (
    <Shell role="region" aria-label={`Media player: ${title}`}>
      <Bar>
        <Title title={title}>{title}</Title>
        <Status>{statusText}</Status>
        <IconButton
          onClick={toggle}
          aria-label={status === 'playing' ? 'Pause' : 'Play'}
          disabled={status === 'error' || status === 'loading'}
        >
          {status === 'playing' ? '❚❚' : '▶'}
        </IconButton>
        <IconButton
          onClick={() => setMinimizedUser(!minimized)}
          aria-label={minimized ? 'Expand player' : 'Minimize player'}
        >
          {minimized ? '⛶' : '−'}
        </IconButton>
        <IconButton onClick={close} aria-label="Stop and close player">✕</IconButton>
      </Bar>
      {valid ? (
        <FrameWrap $hidden={minimized}>
          <div key={videoId} ref={mountRef} style={{ width: '100%', height: '100%' }} />
          {(status === 'ready' || status === 'loading') && !error && !minimized ? (
            <GestureOverlay onClick={toggle} aria-label="Tap to play">
              <span style={{ fontSize: 28 }}>▶</span>
              <span>{status === 'loading' ? 'Loading player…' : 'Tap to play'}</span>
            </GestureOverlay>
          ) : null}
          {error && !minimized ? <ErrorBox>{error}</ErrorBox> : null}
        </FrameWrap>
      ) : (
        <ErrorBox>Could not play this media (invalid video reference).</ErrorBox>
      )}
    </Shell>
  );
};

export default MediaPlayer;
