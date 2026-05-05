/**
 * Content-hashed cache for synthesized audio segments.
 *
 * Pocket TTS is deterministic given the same (text, speaker clip),
 * so re-renders during seek / replay / chapter restart are pure
 * waste. The cache stores the rendered WAV (base64-encoded so it
 * survives a text-only readFile) under the FNV hash of the inputs.
 *
 * Lives at `<dir>/<hash>.b64`. Eviction is manual (`clear()`); the
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

  /** Returns the cached base64 WAV, or null if not cached. */
  get(key: string): string | null {
    const path = this.pathFor(key);
    if (!NativeFile.exists(path)) {
      return null;
    }
    try {
      return NativeFile.readFile(path);
    } catch {
      this.evict(key);
      return null;
    }
  }

  set(key: string, base64Wav: string): void {
    this.ensureDir();
    NativeFile.writeFile(this.pathFor(key), base64Wav);
  }

  evict(key: string): void {
    const path = this.pathFor(key);
    if (NativeFile.exists(path)) {
      NativeFile.unlink(path);
    }
  }

  clear(): void {
    if (NativeFile.exists(this.dir)) {
      NativeFile.unlink(this.dir);
    }
    this.ensured = false;
  }

  private pathFor(key: string): string {
    return `${this.dir}/${key}.b64`;
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
