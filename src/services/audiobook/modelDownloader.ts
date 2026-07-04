/**
 * Downloads and caches the Pocket TTS ONNX model and voice clips.
 *
 * Files are pulled from:
 *   - kyutai/pocket-tts-without-voice-cloning (ungated; the plain
 *     kyutai/pocket-tts repo is gated and would 401 without a HF
 *     token)
 *   - kyutai/tts-voices (voice clips / pre-encoded states)
 *   - any host the voice-zero clips reference via `clip.baseUrl`
 *
 * ── KNOWN GAP (verified against Hugging Face, 2026-07) ──────────
 * The ONNX filenames below do not exist upstream — kyutai ships
 * only safetensors weights and a SentencePiece tokenizer.model.
 * The project must produce and host its own export before
 * `ensureModel`/`ensureTokenizer` can succeed. Voice clip paths in
 * voiceBank.ts are also partly unverified — see that file.
 *
 * Everything lands under the supplied cache dir (typically the OS
 * external cache, so storage pressure can reclaim it). Downloads
 * are atomic: fetched to a `.part` file and renamed on completion,
 * so an interrupted transfer is never mistaken for a cached file.
 */

import NativeFile from '@specs/NativeFile';
import type { TTSPrecision, VoiceClip } from './types';

const MODEL_REPO_BASE =
  'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';
const VOICE_REPO_BASE = 'https://huggingface.co/kyutai/tts-voices/resolve/main';

/**
 * Mapping from precision tier to the ONNX file name in the
 * kyutai/pocket-tts repository. Adjust if the upstream filenames
 * change.
 */
const MODEL_FILENAMES: Record<TTSPrecision, string> = {
  q8: 'pocket_tts.q8.onnx',
  fp16: 'pocket_tts.fp16.onnx',
  fp32: 'pocket_tts.onnx',
};

const TOKENIZER_FILENAME = 'tokenizer.json';

export class ModelDownloader {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  /** Returns the local path to the model file, downloading on first use. */
  async ensureModel(precision: TTSPrecision): Promise<string> {
    const filename = MODEL_FILENAMES[precision];
    return this.ensureRemote(`${MODEL_REPO_BASE}/${filename}`, filename);
  }

  /** Returns the local path to the tokenizer JSON, downloading once. */
  async ensureTokenizer(): Promise<string> {
    return this.ensureRemote(
      `${MODEL_REPO_BASE}/${TOKENIZER_FILENAME}`,
      TOKENIZER_FILENAME,
    );
  }

  /**
   * Returns the local path to a voice clip, downloading once. Clips
   * default to the kyutai/tts-voices repo; voice-zero (and other)
   * sources override via `clip.baseUrl`.
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
    // Download to a temp name and rename once complete, so a
    // killed/interrupted download can't leave a truncated file that
    // exists() would treat as a valid cache hit forever after.
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
