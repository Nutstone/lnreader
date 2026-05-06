/**
 * Post-processing for synthesized audio segments.
 *
 * Two passes, in order:
 *  1. Silence trim — strip leading and trailing samples below an
 *     amplitude threshold. Pocket TTS often pads its outputs with
 *     a few hundred ms of low-level noise; trimming tightens the
 *     pacing between segments without dropping audible content.
 *  2. Loudness normalization — scale samples so RMS hits a target
 *     level, then peak-limit to avoid clipping. Cheaper than EBU
 *     R128 and ~95% as effective for spoken content.
 *
 * Pure functions over Float32Array PCM. Idempotent; safe to call
 * multiple times. Latency is dominated by the synthesis itself,
 * so the lookahead buffer hides this work entirely.
 */

/** Threshold below which a sample counts as silent (linear). */
const SILENCE_THRESHOLD = 0.005;
/** Keep this much silence on each end after trimming (10ms @ 24kHz). */
const SILENCE_TAIL_SAMPLES = 240;
/** Target RMS amplitude for normalization (linear). */
const TARGET_RMS = 0.1;
/** Hard peak ceiling after normalization (linear). */
const PEAK_CEILING = 0.95;

export const postProcess = (samples: Float32Array): Float32Array => {
  return normalize(trimSilence(samples));
};

const trimSilence = (samples: Float32Array): Float32Array => {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < SILENCE_THRESHOLD) {
    start++;
  }
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) < SILENCE_THRESHOLD) {
    end--;
  }

  if (start === 0 && end === samples.length) {
    return samples;
  }

  const padStart = Math.max(0, start - SILENCE_TAIL_SAMPLES);
  const padEnd = Math.min(samples.length, end + SILENCE_TAIL_SAMPLES);
  return samples.subarray(padStart, padEnd);
};

const normalize = (samples: Float32Array): Float32Array => {
  if (samples.length === 0) {
    return samples;
  }

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSquares += s * s;
    const abs = Math.abs(s);
    if (abs > peak) {
      peak = abs;
    }
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms === 0) {
    return samples;
  }

  let gain = TARGET_RMS / rms;
  // Don't let normalization push peaks past the ceiling.
  const peakAfterGain = peak * gain;
  if (peakAfterGain > PEAK_CEILING) {
    gain *= PEAK_CEILING / peakAfterGain;
  }

  if (Math.abs(gain - 1) < 0.01) {
    return samples;
  }

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * gain;
  }
  return out;
};
