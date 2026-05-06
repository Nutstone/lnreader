/**
 * Content-hashed cache for synthesized audio segments.
 *
 * Pocket TTS is deterministic given the same (text, speaker clip),
 * so re-renders during seek / replay / chapter restart are pure
 * waste. The cache writes the rendered WAV (binary, decoded by
 * NativeFile's base64 encoding flag) once and the player reads it
 * back via `file://` URI — no read-decode-rewrite roundtrip.
 *
 * Lives at `<dir>/<hash>.wav`. Eviction is manual (`clear()`); the
 * dir is expected to sit under the OS external cache so storage
 * pressure can also reclaim it.
 */

import NativeFile from '@specs/NativeFile';

export class AudioCache {
  private dir: string;
  private ensured = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Stable key for the (text, voice clip) pair. */
  static keyFor(text: string, clipPath: string): string {
    return fnv1a(`${clipPath}␟${text}`);
  }

  /** Absolute path where the WAV for `key` lives (or would live). */
  pathFor(key: string): string {
    return `${this.dir}/${key}.wav`;
  }

  has(key: string): boolean {
    return NativeFile.exists(this.pathFor(key));
  }

  /** Decode the base64-encoded WAV and write it as binary on disk. */
  set(key: string, base64Wav: string): void {
    this.ensureDir();
    NativeFile.writeFile(this.pathFor(key), base64Wav, 'base64');
  }

  clear(): void {
    if (NativeFile.exists(this.dir)) {
      NativeFile.unlink(this.dir);
    }
    this.ensured = false;
  }

  private ensureDir(): void {
    if (this.ensured) {
      return;
    }
    if (!NativeFile.exists(this.dir)) {
      NativeFile.mkdir(this.dir);
    }
    this.ensured = true;
  }
}

/* eslint-disable no-bitwise */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};
/* eslint-enable no-bitwise */
