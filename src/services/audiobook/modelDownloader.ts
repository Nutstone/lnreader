/**
 * Downloads and caches the Pocket TTS ONNX model and voice clips.
 *
 * Files are pulled from Hugging Face mirrors of:
 *   - kyutai/pocket-tts (model weights, ONNX export)
 *   - kyutai/tts-voices (voice clips / pre-encoded states)
 *
 * Both live in the app's external cache directory so the OS can
 * reclaim them under storage pressure.
 */

import NativeFile from '@specs/NativeFile';
import type { TTSPrecision, VoiceClip } from './types';

const DEFAULT_REPO_BASE =
  'https://huggingface.co/kyutai/pocket-tts/resolve/main';
const VOICE_REPO_BASE =
  'https://huggingface.co/kyutai/tts-voices/resolve/main';

/**
 * Mapping from the user-facing precision tier to the ONNX file
 * name in the kyutai/pocket-tts repository. The community export
 * conventions are q8 / fp16 / fp32 — adjust here if the upstream
 * filenames change.
 */
const MODEL_FILENAMES: Record<TTSPrecision, string> = {
  q8: 'pocket_tts.q8.onnx',
  fp16: 'pocket_tts.fp16.onnx',
  fp32: 'pocket_tts.onnx',
};

const TOKENIZER_FILENAME = 'tokenizer.json';

export interface DownloaderConfig {
  cacheDir: string;
  modelRepoUrl?: string;
  voiceRepoUrl?: string;
}

export class ModelDownloader {
  private modelRepo: string;
  private voiceRepo: string;
  private cacheDir: string;

  constructor(config: DownloaderConfig) {
    this.modelRepo = config.modelRepoUrl ?? DEFAULT_REPO_BASE;
    this.voiceRepo = config.voiceRepoUrl ?? VOICE_REPO_BASE;
    this.cacheDir = config.cacheDir;
  }

  /** Returns the local path to the model file, downloading on first use. */
  async ensureModel(precision: TTSPrecision): Promise<string> {
    const filename = MODEL_FILENAMES[precision];
    const localPath = `${this.cacheDir}/${filename}`;
    if (!NativeFile.exists(localPath)) {
      await this.ensureDir(this.cacheDir);
      await NativeFile.downloadFile(
        `${this.modelRepo}/${filename}`,
        localPath,
        'GET',
        {},
      );
    }
    return localPath;
  }

  /** Returns the local path to the tokenizer JSON, downloading once. */
  async ensureTokenizer(): Promise<string> {
    const localPath = `${this.cacheDir}/${TOKENIZER_FILENAME}`;
    if (!NativeFile.exists(localPath)) {
      await this.ensureDir(this.cacheDir);
      await NativeFile.downloadFile(
        `${this.modelRepo}/${TOKENIZER_FILENAME}`,
        localPath,
        'GET',
        {},
      );
    }
    return localPath;
  }

  /**
   * Returns the local path to a voice clip, downloading once.
   * Clips can come from the default kyutai/tts-voices repo or
   * from a different host (e.g. voice-zero on GitHub) via
   * `clip.baseUrl`.
   */
  async ensureVoiceClip(clip: VoiceClip): Promise<string> {
    const base = clip.baseUrl ?? this.voiceRepo;
    const sourceTag = clip.baseUrl ? hashString(clip.baseUrl) : 'kyutai';
    const safeName = clip.path.replace(/[^a-zA-Z0-9._-]/g, '_');
    const localPath = `${this.cacheDir}/voices/${sourceTag}_${safeName}`;
    if (!NativeFile.exists(localPath)) {
      await this.ensureDir(`${this.cacheDir}/voices`);
      await NativeFile.downloadFile(
        `${base}/${clip.path}`,
        localPath,
        'GET',
        {},
      );
    }
    return localPath;
  }

  private async ensureDir(path: string): Promise<void> {
    if (!NativeFile.exists(path)) {
      NativeFile.mkdir(path);
    }
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
