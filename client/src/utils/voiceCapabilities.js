// Feature detection for voice input. Capability-based only — no browser-name sniffing.
const API_URL = (() => {
  try {
    return import.meta.env?.VITE_API_URL || 'http://localhost:5000';
  } catch {
    return 'http://localhost:5000';
  }
})();

export const getSpeechRecognitionClass = () => {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
};

export const hasNativeSTT = () => Boolean(getSpeechRecognitionClass());

export const hasRecordingSTT = () => {
  if (typeof window === 'undefined') return false;
  if (!navigator?.mediaDevices?.getUserMedia) return false;
  return typeof window.MediaRecorder !== 'undefined';
};

// 'native'  -> browser SpeechRecognition (continuous, interim results)
// 'server'  -> mic recording + server transcription fallback
// 'unsupported' -> neither capability available
export const getVoiceMode = () => {
  if (hasNativeSTT()) return 'native';
  if (hasRecordingSTT()) return 'server';
  return 'unsupported';
};

export const pickRecordingMimeType = () => {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  try {
    if (typeof window !== 'undefined' && window.MediaRecorder?.isTypeSupported) {
      for (const candidate of candidates) {
        if (window.MediaRecorder.isTypeSupported(candidate)) return candidate;
      }
    }
  } catch {
    // ignore and fall through to browser default
  }
  return '';
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

// Sends a recorded clip to the server transcription endpoint and resolves the
// transcript text (possibly ''). Throws a single Error with server detail.
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
