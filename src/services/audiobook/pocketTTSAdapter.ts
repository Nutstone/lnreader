/**
 * PocketTTSAdapter — wraps onnxruntime-react-native for Pocket TTS.
 *
 * Pocket TTS is an autoregressive token-based TTS:
 *   text → tokenizer → text token ids
 *   speaker prompt → encoded speaker state (precomputed per voice)
 *   model.run({ text, speaker_state }) → audio samples (float32 @ 24kHz)
 *
 * The exact tensor names and shapes vary slightly between community
 * ONNX exports of Pocket TTS. The constants at the top of this file
 * are the values the official `pocket-tts-onnx-export` uses; if you
 * point `modelRepoUrl` at a different export, override them via
 * `PocketTTSAdapter.setIOSpec`.
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import NativeFile from '@specs/NativeFile';

const DEFAULT_IO_SPEC = {
  textInputName: 'text_tokens',
  speakerInputName: 'speaker_state',
  audioOutputName: 'audio',
  sampleRate: 24000,
};

export type PocketTTSIOSpec = typeof DEFAULT_IO_SPEC;

export class PocketTTSAdapter {
  private session: InferenceSession | null = null;
  private spec: PocketTTSIOSpec = DEFAULT_IO_SPEC;
  private speakerStateCache = new Map<string, Float32Array>();
  private tokenizer: SimpleTokenizer | null = null;

  setIOSpec(spec: Partial<PocketTTSIOSpec>): void {
    this.spec = { ...this.spec, ...spec };
  }

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
   * Loads a precomputed speaker state from disk. Pocket TTS voice
   * files are .safetensors / .npy / .wav depending on the export;
   * we read the raw float32 contents and trust the export ships
   * them as flat arrays. Cached after the first call.
   */
  async loadSpeakerState(
    voiceClipPath: string,
  ): Promise<Float32Array> {
    const cached = this.speakerStateCache.get(voiceClipPath);
    if (cached) {
      return cached;
    }
    const base64 = NativeFile.readFile(voiceClipPath);
    const bytes = base64ToUint8Array(base64);
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

    const feeds: Record<string, Tensor> = {
      [this.spec.textInputName]: tokenTensor,
      [this.spec.speakerInputName]: speakerTensor,
    };

    const result = await this.session.run(feeds);
    const audioTensor = result[this.spec.audioOutputName];
    const samples = audioTensor.data as Float32Array;

    return { samples, sampleRate: this.spec.sampleRate };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

const base64ToUint8Array = (b64: string): Uint8Array => {
  const binary =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Minimal tokenizer that reads a Hugging Face tokenizer.json and
 * encodes text via its `vocab` map. Pocket TTS uses a simple
 * BPE/SentencePiece scheme; this implementation handles the
 * common-case greedy longest-match path which is sufficient for
 * audiobook narration. Replace with a full BPE if you hit
 * accuracy issues.
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
    const bos =
      json.added_tokens?.find(t => t.content === '<s>')?.id ?? 1;
    const eos =
      json.added_tokens?.find(t => t.content === '</s>')?.id ?? 2;
    return new SimpleTokenizer(vocab, bos, eos);
  }

  encode(text: string): number[] {
    const tokens: number[] = [this.bos];
    let i = 0;
    while (i < text.length) {
      let matched = false;
      for (let len = Math.min(16, text.length - i); len >= 1; len--) {
        const chunk = text.slice(i, i + len);
        const id = this.vocab.get(chunk);
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
