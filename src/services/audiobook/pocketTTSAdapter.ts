/**
 * PocketTTSAdapter — wraps onnxruntime-react-native for Pocket TTS.
 *
 * Pocket TTS is an autoregressive token-based TTS:
 *   text → tokenizer → text token ids
 *   speaker prompt → encoded speaker state (precomputed per voice)
 *   model.run({ text, speaker_state }) → audio samples (float32 @ 24kHz)
 *
 * Tensor I/O names below match the official `pocket-tts-onnx-export`.
 * If you ever swap to a different export, update the constants here.
 *
 * KNOWN GAP: `loadSpeakerState` reads voice files via
 * `NativeFile.readFile`, which decodes the bytes as UTF-8. Raw
 * binary files (multi-byte sequences) round-trip lossily — the
 * voice repo would need to ship its speaker states as base64 text
 * (or NativeFile would need a binary-read mode) before this works
 * end-to-end against a real ONNX export.
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';
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
   * Loads a precomputed speaker state from disk. Cached after the
   * first call. See file-level note about the assumed format.
   */
  async loadSpeakerState(voiceClipPath: string): Promise<Float32Array> {
    const cached = this.speakerStateCache.get(voiceClipPath);
    if (cached) {
      return cached;
    }
    const raw = NativeFile.readFile(voiceClipPath);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i) & 0xff;
    }
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
