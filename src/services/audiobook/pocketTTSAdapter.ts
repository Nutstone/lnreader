/**
 * PocketTTSAdapter — wraps onnxruntime-react-native for Pocket TTS.
 *
 * Pocket TTS is an autoregressive token-based TTS:
 *   text → tokenizer → text token ids
 *   speaker prompt → encoded speaker state (precomputed per voice)
 *   model.run({ text, speaker_state }) → audio samples (float32 @ 24kHz)
 *
 * ── KNOWN GAP (verified against Hugging Face, 2026-07) ──────────
 * kyutai ships NO ONNX export of Pocket TTS. kyutai/pocket-tts and
 * the ungated kyutai/pocket-tts-without-voice-cloning contain only
 * safetensors weights (`tts_b6369a24.safetensors`), a SentencePiece
 * `tokenizer.model` (not the tokenizer.json this adapter reads),
 * and precomputed speaker embeddings under `embeddings_v3/` as
 * safetensors. Until the project produces and hosts its own ONNX
 * export (with the tensor I/O names below) plus a JSON tokenizer —
 * or this adapter is rewritten around the real artifacts — this
 * class cannot run against a downloadable model. The surrounding
 * pipeline treats it as an injectable seam.
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { FileSystem } from 'react-native-file-access';
import NativeFile from '@specs/NativeFile';

const TEXT_INPUT_NAME = 'text_tokens';
const SPEAKER_INPUT_NAME = 'speaker_state';
const AUDIO_OUTPUT_NAME = 'audio';
const SAMPLE_RATE = 24000;

export class PocketTTSAdapter {
  private session: InferenceSession | null = null;
  private speakerStateCache = new Map<string, Float32Array>();
  private tokenizer: SimpleTokenizer | null = null;

  async load(modelPath: string, tokenizerPath: string): Promise<void> {
    if (this.session) {
      return;
    }
    this.session = await InferenceSession.create(modelPath);
    this.tokenizer = await SimpleTokenizer.fromFile(tokenizerPath);
  }

  async unload(): Promise<void> {
    if (this.session) {
      await this.session.release?.();
    }
    this.session = null;
    this.speakerStateCache.clear();
    this.tokenizer = null;
  }

  /**
   * Loads a precomputed speaker state (raw little-endian float32)
   * from disk, reading the bytes losslessly via base64. Cached after
   * the first call. See file-level note about the assumed format.
   */
  async loadSpeakerState(voiceClipPath: string): Promise<Float32Array> {
    const cached = this.speakerStateCache.get(voiceClipPath);
    if (cached) {
      return cached;
    }
    const base64 = await FileSystem.readFile(voiceClipPath, 'base64');
    const bytes = base64ToBytes(base64);
    const floats = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 4),
    );
    this.speakerStateCache.set(voiceClipPath, floats);
    return floats;
  }

  /** Run the TTS model and return mono float32 PCM samples. */
  async synthesize(
    text: string,
    speakerState: Float32Array,
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!this.session || !this.tokenizer) {
      throw new Error('PocketTTSAdapter not loaded');
    }

    const tokens = this.tokenizer.encode(text);
    const tokenTensor = new Tensor(
      'int64',
      BigInt64Array.from(tokens, t => BigInt(t)),
      [1, tokens.length],
    );
    const speakerTensor = new Tensor('float32', speakerState, [
      1,
      speakerState.length,
    ]);

    const result = await this.session.run({
      [TEXT_INPUT_NAME]: tokenTensor,
      [SPEAKER_INPUT_NAME]: speakerTensor,
    });

    return {
      samples: result[AUDIO_OUTPUT_NAME].data as Float32Array,
      sampleRate: SAMPLE_RATE,
    };
  }
}

// ── Base64 ──────────────────────────────────────────────────────

/* eslint-disable no-bitwise */
const B64_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  const abc =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < abc.length; i++) {
    table[abc.charCodeAt(i)] = i;
  }
  return table;
})();

const base64ToBytes = (base64: string): Uint8Array => {
  const clean = base64.replace(/[\r\n=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = B64_LOOKUP[clean.charCodeAt(i)];
    if (value < 0) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
};
/* eslint-enable no-bitwise */

// ── Tokenizer ───────────────────────────────────────────────────

/**
 * Minimal tokenizer that reads a Hugging Face tokenizer.json and
 * encodes via greedy longest-match against the vocab map. Sufficient
 * for audiobook narration; swap in a full BPE if you hit accuracy
 * issues on unusual text.
 */
class SimpleTokenizer {
  private vocab: Map<string, number>;
  private bos: number;
  private eos: number;

  constructor(vocab: Map<string, number>, bos: number, eos: number) {
    this.vocab = vocab;
    this.bos = bos;
    this.eos = eos;
  }

  static async fromFile(path: string): Promise<SimpleTokenizer> {
    const raw = NativeFile.readFile(path);
    const json = JSON.parse(raw) as {
      model: { vocab: Record<string, number> };
      added_tokens?: Array<{ id: number; content: string }>;
    };
    const vocab = new Map<string, number>(Object.entries(json.model.vocab));
    const bos = json.added_tokens?.find(t => t.content === '<s>')?.id ?? 1;
    const eos = json.added_tokens?.find(t => t.content === '</s>')?.id ?? 2;
    return new SimpleTokenizer(vocab, bos, eos);
  }

  encode(text: string): number[] {
    const tokens: number[] = [this.bos];
    let i = 0;
    while (i < text.length) {
      let matched = false;
      for (let len = Math.min(16, text.length - i); len >= 1; len--) {
        const id = this.vocab.get(text.slice(i, i + len));
        if (id !== undefined) {
          tokens.push(id);
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        i++;
      }
    }
    tokens.push(this.eos);
    return tokens;
  }
}
