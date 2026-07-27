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

import NativeFile from '@modules/native-file';
import { downloadFile } from '@plugins/helpers/fetch';
import type { TTSPrecision, VoiceClip } from './types';

const BUNDLE_REPO_BASE =
  'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main';
const EMBEDDINGS_REPO_BASE =
  'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main';
const VOICE_REPO_BASE = 'https://huggingface.co/kyutai/tts-voices/resolve/main';

export const BUNDLE_LANGUAGE = 'english_2026-04';

/**
 * Files that make up a runnable bundle, per precision tier, with
 * their approximate sizes (measured from the upstream repo, 2026-07).
 * Sizes only weight the progress fraction — a drifted upstream file
 * still downloads fine, the bar is just slightly off.
 */
interface BundleFile {
  name: string;
  bytes: number;
}

const SHARED_FILES: BundleFile[] = [
  { name: 'bundle.json', bytes: 24_400 },
  { name: 'tokenizer.model', bytes: 59_300 },
  { name: 'bos_before_voice.npy', bytes: 4_200 },
];

const BUNDLE_FILES: Record<TTSPrecision, BundleFile[]> = {
  // ~146 MB total
  int8: [
    ...SHARED_FILES,
    { name: 'flow_lm_main_int8.onnx', bytes: 76_341_000 },
    { name: 'flow_lm_flow_int8.onnx', bytes: 9_963_000 },
    { name: 'mimi_decoder_int8.onnx', bytes: 22_684_000 },
    { name: 'mimi_encoder_int8.onnx', bytes: 20_780_000 },
    { name: 'text_conditioner_int8.onnx', bytes: 16_388_000 },
  ],
  // ~440 MB total
  fp32: [
    ...SHARED_FILES,
    { name: 'flow_lm_main.onnx', bytes: 302_742_000 },
    { name: 'flow_lm_flow.onnx', bytes: 39_097_000 },
    { name: 'mimi_decoder.onnx', bytes: 41_472_000 },
    { name: 'mimi_encoder.onnx', bytes: 39_768_000 },
    { name: 'text_conditioner.onnx', bytes: 16_388_000 },
  ],
};

export interface BundleDownloadProgress {
  /** File currently being fetched ('' once everything is present). */
  file: string;
  /** Fraction of total bundle bytes already present, 0..1. */
  fraction: number;
  /**
   * Bytes of completed files — the in-progress file is not counted
   * (the native downloader has no byte-level callbacks), so display
   * these as "X / Y MB" rather than a percent that appears frozen
   * while the dominant model file transfers.
   */
  doneBytes: number;
  totalBytes: number;
}

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
   * their paths. Progress is byte-weighted across files and resumes
   * at file granularity: already-downloaded files are skipped, so an
   * interrupted first run only re-fetches the file it died on.
   */
  async ensureBundle(
    precision: TTSPrecision,
    onProgress?: (progress: BundleDownloadProgress) => void,
  ): Promise<BundlePaths> {
    const files = BUNDLE_FILES[precision] ?? BUNDLE_FILES.int8;
    const bundleDir = `bundles/${BUNDLE_LANGUAGE}`;
    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
    const local: Record<string, string> = {};
    let doneBytes = 0;
    for (const file of files) {
      onProgress?.({
        file: file.name,
        fraction: doneBytes / totalBytes,
        doneBytes,
        totalBytes,
      });
      local[file.name] = await this.ensureRemote(
        `${BUNDLE_REPO_BASE}/onnx/${BUNDLE_LANGUAGE}/${file.name}`,
        `${bundleDir}/${file.name}`,
      );
      doneBytes += file.bytes;
    }
    onProgress?.({ file: '', fraction: 1, doneBytes: totalBytes, totalBytes });
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
    if (await NativeFile.exists(localPath)) {
      return localPath;
    }
    const parent = localPath.slice(0, localPath.lastIndexOf('/'));
    if (!(await NativeFile.exists(parent))) {
      await NativeFile.mkdir(parent);
    }
    const partPath = `${localPath}.part`;
    if (await NativeFile.exists(partPath)) {
      await NativeFile.unlink(partPath);
    }
    try {
      // Use the app's shared wrapper — it passes the TurboModule's
      // full 5-argument signature. The new-architecture bridge
      // enforces exact arity at runtime (calling with 4 args throws
      // "expected argument count: 5" on device), which neither jest
      // mocks nor Node harnesses catch.
      await downloadFile(url, partPath);
    } catch (error) {
      // Never leave a truncated .part behind; the next attempt would
      // delete it anyway, but a clean failure keeps cache dirs tidy.
      try {
        if (await NativeFile.exists(partPath)) {
          await NativeFile.unlink(partPath);
        }
      } catch {
        // Cleanup is best-effort.
      }
      throw new Error(
        `Download failed for ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await NativeFile.moveFile(partPath, localPath);
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
