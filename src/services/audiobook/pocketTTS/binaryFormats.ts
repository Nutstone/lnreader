/**
 * Parsers for the binary formats the Pocket TTS bundle uses:
 * safetensors (voice prompt states), npy (bos-before-voice
 * embedding), and 16-bit PCM WAV (voice-cloning reference audio).
 */

import { utf8Decode } from './sentencepiece';

// ── safetensors ─────────────────────────────────────────────────

export interface SafeTensor {
  dtype: string;
  shape: number[];
  /** float32 tensors → Float32Array; int64 → BigInt64Array. */
  data: Float32Array | BigInt64Array;
}

export function parseSafetensors(bytes: Uint8Array): Map<string, SafeTensor> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  const header = JSON.parse(
    utf8Decode(bytes.subarray(8, 8 + headerLength)),
  ) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const dataStart = 8 + headerLength;

  const tensors = new Map<string, SafeTensor>();
  for (const [name, info] of Object.entries(header)) {
    if (name === '__metadata__') {
      continue;
    }
    const [begin, end] = info.data_offsets;
    const raw = bytes.slice(dataStart + begin, dataStart + end);
    let data: Float32Array | BigInt64Array;
    switch (info.dtype) {
      case 'F32':
        data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        break;
      case 'I64':
        data = new BigInt64Array(
          raw.buffer,
          raw.byteOffset,
          raw.byteLength / 8,
        );
        break;
      default:
        throw new Error(`Unsupported safetensors dtype: ${info.dtype}`);
    }
    tensors.set(name, { dtype: info.dtype, shape: info.shape, data });
  }
  return tensors;
}

// ── npy ─────────────────────────────────────────────────────────

export interface NpyArray {
  shape: number[];
  data: Float32Array;
}

export function parseNpy(bytes: Uint8Array): NpyArray {
  if (bytes[0] !== 0x93 || utf8Decode(bytes.subarray(1, 6)) !== 'NUMPY') {
    throw new Error('Not an npy file');
  }
  const major = bytes[6];
  const headerLength =
    major >= 2
      ? new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true)
      : new DataView(bytes.buffer, bytes.byteOffset + 8, 2).getUint16(0, true);
  const headerStart = major >= 2 ? 12 : 10;
  const header = utf8Decode(
    bytes.subarray(headerStart, headerStart + headerLength),
  );

  const descrMatch = header.match(/'descr':\s*'([^']+)'/);
  if (!descrMatch || descrMatch[1] !== '<f4') {
    throw new Error(`Unsupported npy dtype: ${descrMatch?.[1]}`);
  }
  const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);
  const shape = (shapeMatch?.[1] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number);

  const dataStart = headerStart + headerLength;
  const raw = bytes.slice(dataStart);
  return {
    shape,
    data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
  };
}

// ── WAV ─────────────────────────────────────────────────────────

export interface WavAudio {
  sampleRate: number;
  /** Mono float32 samples in [-1, 1]. */
  samples: Float32Array;
}

export function parseWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (utf8Decode(bytes.subarray(0, 4)) !== 'RIFF') {
    throw new Error('Not a RIFF/WAV file');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = utf8Decode(bytes.subarray(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ') {
      const format = view.getUint16(offset + 8, true);
      if (format !== 1) {
        throw new Error(`Unsupported WAV format ${format} (need PCM)`);
      }
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || dataOffset < 0) {
    throw new Error('Malformed WAV: missing fmt/data chunk');
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample} (need 16)`);
  }

  const frameCount = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += view.getInt16(dataOffset + (i * channels + c) * 2, true);
    }
    samples[i] = sum / channels / 32768;
  }
  return { sampleRate, samples };
}

/**
 * Linear-interpolation resampler. Adequate for voice-conditioning
 * prompts (the model only extracts speaker identity from them); not
 * meant for playback audio, which is already generated at the
 * bundle's native rate.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) {
    return samples;
  }
  const outLength = Math.floor((samples.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = src - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}
