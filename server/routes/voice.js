const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { consumeCredits } = require('../services/creditService');
const geminiProvider = require('../lib/llm/providers/GeminiProvider');

// ~4.5MB of base64 ≈ 3.3MB of audio, well above a typical voice command clip.
const MAX_AUDIO_BASE64_CHARS = 6_000_000;

// All voice routes require auth (guest sessions included)
router.use(protect);

// POST /api/voice/transcribe — server-side STT fallback for browsers without
// native SpeechRecognition (e.g. Firefox). Accepts base64 audio JSON so no
// multipart dependency is needed.
router.post('/transcribe', async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { audio, mimeType } = req.body || {};
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'Audio data is required.' });
    }
    if (audio.length > MAX_AUDIO_BASE64_CHARS) {
      return res.status(413).json({ error: 'Audio clip is too long. Keep voice commands under about a minute.' });
    }
    if (mimeType && (typeof mimeType !== 'string' || !mimeType.startsWith('audio/'))) {
      return res.status(400).json({ error: 'Unsupported audio format.' });
    }

    if (!geminiProvider.isAvailable()) {
      return res.status(503).json({
        error: 'Voice transcription is unavailable because the speech service is not configured. Native browser voice still works where supported.',
        code: 'VOICE_STT_UNAVAILABLE'
      });
    }

    const creditCharge = await consumeCredits(userId, 1, 'voice transcription');
    if (!creditCharge.success) {
      return res.status(402).json({ error: creditCharge.error || 'Out of credits.', code: 'INSUFFICIENT_CREDITS' });
    }

    const result = await geminiProvider.transcribeAudio({ audioBase64: audio, mimeType });
    return res.json({ text: result.text || '' });
  } catch (err) {
    // Never leak audio content, API keys, or provider internals to the client.
    console.error('[Voice] transcription failed:', err?.message || err);
    const status = Number(err?.statusCode) >= 400 && Number(err?.statusCode) < 600 ? err.statusCode : 500;
    return res.status(status).json({ error: 'Voice transcription failed. Please try again.' });
  }
});

module.exports = router;
