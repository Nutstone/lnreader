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

const DEFAULT_OPTIONS = {
  /** Threshold below which a sample counts as silent (linear). */
  silenceThreshold: 0.005,
  /** Keep this much silence on each end after trimming (samples). */
  silenceTailSamples: 240, // 10ms @ 24kHz
  /** Target RMS amplitude for normalization (linear). */
  targetRms: 0.1,
  /** Hard peak ceiling after normalization (linear). */
  peakCeiling: 0.95,
};

export type PostProcessOptions = typeof DEFAULT_OPTIONS;

export const postProcess = (
  samples: Float32Array,
  options: Partial<PostProcessOptions> = {},
): Float32Array => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmed = trimSilence(samples, opts);
  return normalize(trimmed, opts);
};

const trimSilence = (
  samples: Float32Array,
  opts: PostProcessOptions,
): Float32Array => {
  const { silenceThreshold, silenceTailSamples } = opts;
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < silenceThreshold) {
    start++;
  }
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) < silenceThreshold) {
    end--;
  }

  if (start === 0 && end === samples.length) {
    return samples;
  }

  const padStart = Math.max(0, start - silenceTailSamples);
  const padEnd = Math.min(samples.length, end + silenceTailSamples);
  return samples.subarray(padStart, padEnd);
};

const normalize = (
  samples: Float32Array,
  opts: PostProcessOptions,
): Float32Array => {
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

  let gain = opts.targetRms / rms;
  // Don't let normalization push peaks past the ceiling.
  const peakAfterGain = peak * gain;
  if (peakAfterGain > opts.peakCeiling) {
    gain *= opts.peakCeiling / peakAfterGain;
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
