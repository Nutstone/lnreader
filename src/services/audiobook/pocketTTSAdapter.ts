/**
 * PocketTTSAdapter — binds the runtime-agnostic PocketTTSEngine to
 * React Native: onnxruntime-react-native for inference and
 * react-native-file-access for lossless binary file reads.
 *
 * Voice-conditioning states are cached per VoiceSpec key, so a
 * character's voice is prepared once per session and reused across
 * segments and chapters.
 */

import * as ort from 'onnxruntime-react-native';
import { FileSystem } from 'react-native-file-access';
import { PocketTTSEngine, BundleMetadata, OrtModule } from './pocketTTS/engine';
import NativeFile from '@specs/NativeFile';
import type { BundlePaths } from './modelDownloader';
import type { VoiceSpec } from './types';

/**
 * Voice prompts only need a short stretch of reference audio; longer
 * clips just cost encode time. Matches what the reference runtime's
 * predefined states were built from (~10-20s prompts).
 */
const MAX_CLONE_SECONDS = 15;

type VoiceState = Awaited<
  ReturnType<PocketTTSEngine['voiceStateFromSafetensors']>
>;

export class PocketTTSAdapter {
  private engine: PocketTTSEngine | null = null;
  private voiceStateCache = new Map<string, VoiceState>();

  get sampleRate(): number {
    return this.engine?.sampleRate ?? 24000;
  }

  get loaded(): boolean {
    return this.engine !== null;
  }

  async load(paths: BundlePaths): Promise<void> {
    if (this.engine) {
      return;
    }
    const metadata = JSON.parse(
      NativeFile.readFile(paths.metadata),
    ) as BundleMetadata;
    this.engine = await PocketTTSEngine.load(
      ort as unknown as OrtModule,
      metadata,
      {
        flowLmMain: paths.flowLmMain,
        flowLmFlow: paths.flowLmFlow,
        mimiDecoder: paths.mimiDecoder,
        mimiEncoder: paths.mimiEncoder,
        textConditioner: paths.textConditioner,
      },
      readFileBytes,
      paths.tokenizer,
      paths.bosBeforeVoice,
    );
  }

  async unload(): Promise<void> {
    await this.engine?.release();
    this.engine = null;
    this.voiceStateCache.clear();
  }

  /**
   * Prepares (and caches) the voice-conditioning state for a spec.
   * `localPath` is the already-downloaded file for the spec.
   */
  async prepareVoiceState(
    spec: VoiceSpec,
    localPath: string,
  ): Promise<VoiceState> {
    const engine = this.requireEngine();
    const key = voiceKey(spec);
    const cached = this.voiceStateCache.get(key);
    if (cached) {
      return cached;
    }
    const bytes = await readFileBytes(localPath);
    const state =
      spec.kind === 'embedding'
        ? await engine.voiceStateFromSafetensors(bytes)
        : await engine.voiceStateFromWav(bytes, MAX_CLONE_SECONDS);
    this.voiceStateCache.set(key, state);
    return state;
  }

  /** Synthesizes text with a prepared voice state → mono f32 PCM. */
  async synthesize(
    text: string,
    voiceState: VoiceState,
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    const engine = this.requireEngine();
    const samples = await engine.synthesize(text, voiceState);
    return { samples, sampleRate: engine.sampleRate };
  }

  private requireEngine(): PocketTTSEngine {
    if (!this.engine) {
      throw new Error('PocketTTSAdapter not loaded');
    }
    return this.engine;
  }
}

export const voiceKey = (spec: VoiceSpec): string =>
  spec.kind === 'embedding'
    ? `embedding:${spec.name}`
    : `clip:${spec.clip.baseUrl ?? ''}|${spec.clip.path}`;

// ── RN file reading ─────────────────────────────────────────────

async function readFileBytes(path: string): Promise<Uint8Array> {
  const base64 = await FileSystem.readFile(path, 'base64');
  return base64ToBytes(base64);
}

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

export const base64ToBytes = (base64: string): Uint8Array => {
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
