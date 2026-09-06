// Feature-detected helpers for server-generated TTS audio playback.
// Capability-based only — no browser-name sniffing.

export const canPlayServerAudio = () => {
  try {
    if (typeof window === 'undefined') return false;
    if (typeof window.Audio !== 'function' && typeof window.Audio !== 'object') return false;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
    if (typeof Blob === 'undefined') return false;
    try {
      const probe = new window.Audio();
      if (probe && typeof probe.canPlayType === 'function') {
        const wav = String(probe.canPlayType('audio/wav') || '').toLowerCase();
        if (wav === '') return false;
      }
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

export const base64ToBlobUrl = (base64, mimeType = 'audio/wav') => {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
};

export const revokeBlobUrl = (url) => {
  try {
    if (url) URL.revokeObjectURL(url);
  } catch {
    // ignore — revocation is best-effort cleanup
  }
};
