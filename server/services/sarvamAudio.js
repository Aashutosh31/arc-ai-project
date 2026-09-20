// Sarvam STT audio bridging (pure, provider-side).
//
// The ARC voice wire format is PCM signed 16-bit little-endian, mono, 24 kHz
// (VOICE_MIC_FORMAT / STT_SESSION_FORMAT). The Sarvam realtime STT endpoint
// accepts mono linear16 at 8 kHz or 16 kHz. Every adapter owns exactly one
// resample stage — nothing else in the pipeline resamples — so endianness,
// channel mixing, and clipping are handled in exactly one place.
const SARVAM_STT_SAMPLE_RATE = 16000;

const clampSample = (value) => (value < -32768 ? -32768 : value > 32767 ? 32767 : value);

// Linear-interpolation mono PCM16 resampler. Handles odd byte counts by
// truncating to whole samples; returns an empty buffer for degenerate input.
// `fromRate === toRate` short-circuits to a byte copy (no work, no drift).
const resamplePcm16Mono = (buffer, fromRate, toRate) => {
  if (!buffer) return Buffer.alloc(0);
  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (src.length === 0) return Buffer.alloc(0);
  const from = Number(fromRate);
  const to = Number(toRate);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return Buffer.alloc(0);
  if (from === to) return Buffer.from(src);
  const inSamples = Math.floor(src.length / 2);
  if (inSamples < 2) return Buffer.alloc(0);
  const ratio = from / to;
  const outSamples = Math.max(0, Math.floor(inSamples / ratio));
  const out = Buffer.alloc(outSamples * 2);
  for (let o = 0; o < outSamples; o += 1) {
    const source = o * ratio;
    const i0 = Math.floor(source);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = source - i0;
    const sample = src.readInt16LE(i0 * 2) * (1 - frac) + src.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(clampSample(Math.round(sample)), o * 2);
  }
  return out;
};

module.exports = {
  SARVAM_STT_SAMPLE_RATE,
  resamplePcm16Mono,
};