/**
 * Stable chapter cache key.
 *
 * Plugins occasionally reorder chapter lists (when a missing chapter is
 * filled in, when paginated indexes are refreshed). Indexing the cache
 * by integer position breaks those caches. Use a hash of the
 * plugin-stable `path` instead.
 */

/**
 * Tiny non-cryptographic 16-char hash. Deterministic; small; stable
 * across runs. Don't use for security — only for cache keys.
 *
 * Implementation: 32-bit FNV-1a × 2 with different seeds, hex-encoded.
 */
export function hashChapterPath(path: string): string {
  /* eslint-disable no-bitwise */
  const fnv = (seed: number) => {
    let h = seed;
    for (let i = 0; i < path.length; i++) {
      h ^= path.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const hi = fnv(2166136261);
  const lo = fnv(2654435769);
  /* eslint-enable no-bitwise */
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

export function chapterKeyFor(path: string | undefined | null): string {
  if (!path) return 'unknown';
  return hashChapterPath(path);
}
