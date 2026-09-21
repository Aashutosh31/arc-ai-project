// Feature detection for voice input. Capability-based only — no browser-name
// sniffing, and NO browser-side recognition APIs: the browser only captures
// microphone audio (getUserMedia → PCM frames over the socket) and the ARC
// server performs transcription. 'server' = streaming STT.
const API_URL = (() => {
  try {
    return import.meta.env?.VITE_API_URL || 'http://localhost:5000';
  } catch {
    return 'http://localhost:5000';
  }
})();

// Microphone capture + Web Audio (input AudioWorklet framing). The ONLY
// client-side requirement for streaming STT.
export const hasUserMediaAudio = () => {
  if (typeof window === 'undefined') return false;
  if (!navigator?.mediaDevices?.getUserMedia) return false;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return typeof Ctx !== 'undefined';
};

export const getVoiceMode = () => {
  if (hasUserMediaAudio()) return 'server';
  return 'unsupported';
};

export const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  try {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error('Failed to read the recording.'));
    reader.readAsDataURL(blob);
  } catch (err) {
    reject(err);
  }
});

// Legacy single-shot blob transcription (kept for non-streaming callers).
export const transcribeAudioBlob = async (blob, { signal } = {}) => {
  const base64 = await blobToBase64(blob);
  const token = localStorage.getItem('token');
  const response = await fetch(`${API_URL}/api/voice/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ audio: base64, mimeType: blob?.type || undefined }),
    signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `Voice transcription failed (HTTP ${response.status}).`);
    error.code = data?.code || null;
    error.status = response.status;
    throw error;
  }
  return String(data?.text || '').trim();
};