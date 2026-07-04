/**
 * Downloads and caches the Pocket TTS ONNX bundle, predefined voice
 * embeddings, and voice-cloning reference clips.
 *
 * Sources (all verified reachable without authentication, 2026-07):
 *   - KevinAHM/pocket-tts-onnx — the exported ONNX bundle (MIT
 *     inference code; bundle artifacts under upstream Kyutai terms).
 *     The gated kyutai/pocket-tts repo has NO ONNX export; this
 *     community export is the one that exists.
 *   - kyutai/pocket-tts-without-voice-cloning — ungated precomputed
 *     voice prompt states (languages/<lang>/embeddings/*.safetensors).
 *   - kyutai/tts-voices — Expresso emotional reference WAVs for
 *     on-device voice cloning.
 *
 * Downloads are atomic: fetched to a `.part` file and renamed on
 * completion, so an interrupted transfer is never mistaken for a
 * cached file. Everything lands under the supplied cache dir
 * (typically the OS external cache, so storage pressure can reclaim
 * it).
 */

import NativeFile from '@specs/NativeFile';
import type { TTSPrecision, VoiceClip } from './types';

const BUNDLE_REPO_BASE =
  'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main';
const EMBEDDINGS_REPO_BASE =
  'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';
const VOICE_REPO_BASE = 'https://huggingface.co/kyutai/tts-voices/resolve/main';

export const BUNDLE_LANGUAGE = 'english_2026-04';

/** Files that make up a runnable bundle, per precision tier. */
const BUNDLE_FILES: Record<TTSPrecision, string[]> = {
  // ~146 MB total
  int8: [
    'bundle.json',
    'tokenizer.model',
    'bos_before_voice.npy',
    'flow_lm_main_int8.onnx',
    'flow_lm_flow_int8.onnx',
    'mimi_decoder_int8.onnx',
    'mimi_encoder_int8.onnx',
    'text_conditioner_int8.onnx',
  ],
  // ~440 MB total
  fp32: [
    'bundle.json',
    'tokenizer.model',
    'bos_before_voice.npy',
    'flow_lm_main.onnx',
    'flow_lm_flow.onnx',
    'mimi_decoder.onnx',
    'mimi_encoder.onnx',
    'text_conditioner.onnx',
  ],
};

export interface BundlePaths {
  dir: string;
  metadata: string;
  tokenizer: string;
  bosBeforeVoice: string;
  flowLmMain: string;
  flowLmFlow: string;
  mimiDecoder: string;
  mimiEncoder: string;
  textConditioner: string;
}

export class ModelDownloader {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /**
   * Ensures every file of the bundle is present locally and returns
   * their paths. Progress is reported per file.
   */
  async ensureBundle(
    precision: TTSPrecision,
    onProgress?: (file: string, index: number, total: number) => void,
  ): Promise<BundlePaths> {
    const files = BUNDLE_FILES[precision] ?? BUNDLE_FILES.int8;
    const bundleDir = `bundles/${BUNDLE_LANGUAGE}`;
    const local: Record<string, string> = {};
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.(file, i, files.length);
      local[file] = await this.ensureRemote(
        `${BUNDLE_REPO_BASE}/onnx/${BUNDLE_LANGUAGE}/${file}`,
        `${bundleDir}/${file}`,
      );
    }
    const suffix = precision === 'int8' ? '_int8' : '';
    return {
      dir: `${this.cacheDir}/${bundleDir}`,
      metadata: local['bundle.json'],
      tokenizer: local['tokenizer.model'],
      bosBeforeVoice: local['bos_before_voice.npy'],
      flowLmMain: local[`flow_lm_main${suffix}.onnx`],
      flowLmFlow: local[`flow_lm_flow${suffix}.onnx`],
      mimiDecoder: local[`mimi_decoder${suffix}.onnx`],
      mimiEncoder: local[`mimi_encoder${suffix}.onnx`],
      textConditioner: local[`text_conditioner${suffix}.onnx`],
    };
  }

  /**
   * Ensures a predefined-voice prompt state (a few MB) is present
   * locally, e.g. `ensureVoiceEmbedding('alba')`.
   */
  async ensureVoiceEmbedding(name: string): Promise<string> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return this.ensureRemote(
      `${EMBEDDINGS_REPO_BASE}/languages/${BUNDLE_LANGUAGE}/embeddings/${name}.safetensors`,
      `embeddings/${safeName}.safetensors`,
    );
  }

  /**
   * Ensures a voice-cloning reference clip is present locally. Clips
   * default to the kyutai/tts-voices repo; other sources override via
   * `clip.baseUrl`.
   */
  async ensureVoiceClip(clip: VoiceClip): Promise<string> {
    const base = clip.baseUrl ?? VOICE_REPO_BASE;
    const sourceTag = clip.baseUrl ? hashString(clip.baseUrl) : 'kyutai';
    const safeName = clip.path.replace(/[^a-zA-Z0-9._-]/g, '_');
    return this.ensureRemote(
      `${base}/${clip.path}`,
      `voices/${sourceTag}_${safeName}`,
    );
  }

  private async ensureRemote(
    url: string,
    relativePath: string,
  ): Promise<string> {
    const localPath = `${this.cacheDir}/${relativePath}`;
    if (NativeFile.exists(localPath)) {
      return localPath;
    }
    const parent = localPath.slice(0, localPath.lastIndexOf('/'));
    if (!NativeFile.exists(parent)) {
      NativeFile.mkdir(parent);
    }
    const partPath = `${localPath}.part`;
    if (NativeFile.exists(partPath)) {
      NativeFile.unlink(partPath);
    }
    await NativeFile.downloadFile(url, partPath, 'GET', {});
    NativeFile.moveFile(partPath, localPath);
    return localPath;
  }
}

/* eslint-disable no-bitwise */
const hashString = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
};
/* eslint-enable no-bitwise */
