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

    // Charge-first, no compensation -- intentionally IDENTICAL to the governed
    // path in TaskExecutor.executeTool, which also consumes before executing and
    // never refunds. `creditsRemaining` is decremented and never incremented
    // anywhere in the codebase, so this route is not an outlier: making it
    // refund would be inconsistent with every governed capability and would
    // under-charge work that actually ran (e.g. a transcription that succeeded
    // but whose response failed to serialize).
    //
    // Known, accepted limitation: this charge sits outside an execution
    // envelope, so it has no executionId, observability, or idempotency, and a
    // client retry loop can charge repeatedly. Closing that means adding a
    // credit-compensation primitive and a substrate-wide credit policy -- a
    // deliberate follow-up, not a Phase 1 fix. Do not special-case it here.
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

// GET /api/voice/tts-config — Voice Runtime 3.0 capability advertisement.
// Returns the streaming voice configuration WITHOUT provider credentials.
// The client uses this to select: streaming server TTS → alternate provider
// → browser SpeechSynthesis fallback, and server STT (never SpeechRecognition),
// and to surface truthful state.
router.get('/tts-config', async (req, res) => {
  try {
    const ttsService = require('../services/ttsService');
    const sttService = require('../services/sttService');
    const streaming = ttsService.isServerTtsActive();
    const stt = sttService.getConfig();
    return res.json({
      streamingAvailable: streaming,
      provider: streaming ? 'server' : 'browser-fallback',
      // Explicit wire format — the browser NEVER infers these values.
      format: ttsService.VOICE_STREAM_FORMAT || {
        encoding: 'pcm16',
        codec: 'pcm_s16le',
        sampleRate: ttsService.VOICE_PCM_SAMPLE_RATE || 24000,
        channels: ttsService.VOICE_PCM_CHANNELS || 1,
        bitDepth: 16,
        endianness: 'le',
      },
      events: ['voice:tts:start', 'voice:tts:audio', 'voice:tts:end', 'voice:tts:error', 'voice:tts:cancel'],
      fallback: 'speechSynthesis',
      // Server STT — browser SpeechRecognition is never used for input.
      stt,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Voice configuration unavailable.' });
  }
});

module.exports = router;
