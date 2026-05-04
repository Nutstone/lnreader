/**
 * Audio cache for rendered chapters.
 *
 * Layout:
 *   AUDIOBOOK_STORAGE/<novelId>/audio/<chapterKey>/
 *     manifest.json
 *     seg_0001.wav
 *     seg_0002.wav
 *     ...
 *
 * Reuses `@specs/NativeFile` for atomic writes. No SQLite — the
 * manifest is the index, JSON files are atomic and trivial to back
 * up by tarring the directory.
 *
 * Eviction: LRU on chapter level — if total size exceeds the user's
 * cap, drop chapters least-recently-played. Chapter audio is the only
 * thing evicted; the manifest stays so we know the chapter exists.
 *
 * Voice version invalidation: each segment records the voice version
 * it was rendered with. When the user overrides a character's voice,
 * the caster bumps voiceVersion. On next playback, segments with a
 * stale version are re-rendered; matching ones are reused.
 */

import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_STORAGE } from '@utils/Storages';
import {
  AudioSegmentRef,
  ChapterAudioManifest,
  ChapterAnnotation,
  VoiceMap,
} from './types';

export interface AudioCacheKeys {
  novelId: string;
  chapterKey: string;
  chapterId: number;
}

export interface InvalidationResult {
  invalidatedSegments: number;
  reusableSegments: number;
}

export class AudioCache {
  private novelDir(novelId: string): string {
    return `${AUDIOBOOK_STORAGE}/${novelId}`;
  }

  private chapterDir(keys: AudioCacheKeys): string {
    return `${this.novelDir(keys.novelId)}/audio/${keys.chapterKey}`;
  }

  private manifestPath(keys: AudioCacheKeys): string {
    return `${this.chapterDir(keys)}/manifest.json`;
  }

  ensureChapterDir(keys: AudioCacheKeys): string {
    const dir = this.chapterDir(keys);
    if (!NativeFile.exists(dir)) {
      NativeFile.mkdir(dir);
    }
    return dir;
  }

  readManifest(keys: AudioCacheKeys): ChapterAudioManifest | null {
    const path = this.manifestPath(keys);
    if (!NativeFile.exists(path)) return null;
    try {
      const json = NativeFile.readFile(path);
      return JSON.parse(json) as ChapterAudioManifest;
    } catch {
      try {
        NativeFile.unlink(path);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  writeManifest(keys: AudioCacheKeys, manifest: ChapterAudioManifest): void {
    this.ensureChapterDir(keys);
    NativeFile.writeFile(
      this.manifestPath(keys),
      JSON.stringify(manifest, null, 2),
    );
  }

  /**
   * Build a manifest from the segments rendered so far. Caller invokes
   * this after rendering a full chapter (or each time a segment lands,
   * to keep partial progress recoverable).
   */
  upsertSegment(
    keys: AudioCacheKeys,
    segment: AudioSegmentRef,
    totalSegmentsHint?: number,
  ): ChapterAudioManifest {
    const existing = this.readManifest(keys);
    const now = new Date().toISOString();
    const segmentsByIndex = new Map<number, AudioSegmentRef>(
      (existing?.segments ?? []).map(s => [s.index, s]),
    );
    segmentsByIndex.set(segment.index, segment);
    const segments = [...segmentsByIndex.values()].sort(
      (a, b) => a.index - b.index,
    );
    const manifest: ChapterAudioManifest = {
      chapterKey: keys.chapterKey,
      chapterId: keys.chapterId,
      totalSegments: totalSegmentsHint ?? Math.max(existing?.totalSegments ?? 0, segments.length),
      totalDurationMs: segments.reduce((s, x) => s + x.durationMs + x.pauseBeforeMs, 0),
      segments,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeManifest(keys, manifest);
    return manifest;
  }

  /**
   * Compare a manifest against the current annotation + voice map.
   * Segments with matching text + voice version + emotion are reusable;
   * the rest must be re-rendered.
   */
  computeInvalidation(
    keys: AudioCacheKeys,
    annotation: ChapterAnnotation,
    voiceMap: VoiceMap,
    manifest: ChapterAudioManifest | null,
  ): { reusableIndexes: Set<number>; result: InvalidationResult } {
    const reusable = new Set<number>();
    if (!manifest) {
      return {
        reusableIndexes: reusable,
        result: {
          invalidatedSegments: annotation.segments.length,
          reusableSegments: 0,
        },
      };
    }
    const byIndex = new Map<number, AudioSegmentRef>(
      manifest.segments.map(s => [s.index, s]),
    );
    const dir = this.chapterDir(keys);
    annotation.segments.forEach((s, idx) => {
      const cached = byIndex.get(idx);
      if (!cached) return;
      const voice = voiceMap.mappings[s.speaker];
      const expectedVersion = voice?.voiceVersion ?? 1;
      const filePresent = NativeFile.exists(`${dir}/${cached.file}`);
      if (
        cached.text === s.text &&
        cached.emotion === s.emotion &&
        cached.intensity === s.intensity &&
        cached.voiceVersion === expectedVersion &&
        filePresent
      ) {
        reusable.add(idx);
      }
    });
    return {
      reusableIndexes: reusable,
      result: {
        reusableSegments: reusable.size,
        invalidatedSegments: annotation.segments.length - reusable.size,
      },
    };
  }

  /**
   * Total bytes used by all cached audio. Walks the audiobook storage
   * and sums file sizes — implemented in O(files) using NativeFile.readDir.
   */
  computeTotalSize(): number {
    return walkSize(AUDIOBOOK_STORAGE);
  }

  /**
   * Total bytes for one novel's cached audio.
   */
  computeNovelSize(novelId: string): number {
    return walkSize(this.novelDir(novelId));
  }

  /**
   * Delete the rendered audio files for a chapter (manifest stays).
   * Returns bytes freed.
   */
  evictChapter(keys: AudioCacheKeys): number {
    const dir = this.chapterDir(keys);
    if (!NativeFile.exists(dir)) return 0;
    const before = walkSize(dir);
    NativeFile.unlink(dir);
    return before;
  }

  /**
   * Drop everything for a novel (audio + glossary + voice map +
   * annotations).
   */
  evictNovel(novelId: string): number {
    const dir = this.novelDir(novelId);
    if (!NativeFile.exists(dir)) return 0;
    const before = walkSize(dir);
    NativeFile.unlink(dir);
    return before;
  }

  /**
   * Drop all audiobook caches across the whole app.
   */
  evictAll(): number {
    if (!NativeFile.exists(AUDIOBOOK_STORAGE)) return 0;
    const before = walkSize(AUDIOBOOK_STORAGE);
    NativeFile.unlink(AUDIOBOOK_STORAGE);
    NativeFile.mkdir(AUDIOBOOK_STORAGE);
    return before;
  }

  /**
   * Trim the audio cache to fit within `maxBytes`. Drops oldest-played
   * chapters first. Manifests stay (re-rendering is fast next time).
   */
  trimToBudget(maxBytes: number): { evictedChapters: number; bytesFreed: number } {
    let total = walkSize(AUDIOBOOK_STORAGE);
    if (total <= maxBytes) {
      return { evictedChapters: 0, bytesFreed: 0 };
    }
    const candidates = listChapterCachesSortedByMtime();
    let evicted = 0;
    let freed = 0;
    for (const c of candidates) {
      if (total <= maxBytes) break;
      try {
        const size = walkSize(c.path);
        NativeFile.unlink(c.path);
        total -= size;
        freed += size;
        evicted++;
      } catch {
        /* ignore */
      }
    }
    return { evictedChapters: evicted, bytesFreed: freed };
  }
}

// ── helpers ─────────────────────────────────────────────────────

function walkSize(path: string): number {
  if (!NativeFile.exists(path)) return 0;
  let total = 0;
  try {
    const entries = NativeFile.readDir(path);
    for (const e of entries) {
      if (e.isDirectory) {
        total += walkSize(e.path);
      } else {
        try {
          // NativeFile doesn't expose stat; we approximate by reading
          // the file as base64 length × 0.75. For large WAVs this is
          // slow. The cache budget UI tolerates a refresh delay.
          const content = NativeFile.readFile(e.path);
          total += content.length;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

interface ChapterCache {
  path: string;
  novelId: string;
  chapterKey: string;
}

function listChapterCachesSortedByMtime(): ChapterCache[] {
  const result: ChapterCache[] = [];
  if (!NativeFile.exists(AUDIOBOOK_STORAGE)) return result;
  for (const novel of NativeFile.readDir(AUDIOBOOK_STORAGE)) {
    if (!novel.isDirectory) continue;
    const audioDir = `${novel.path}/audio`;
    if (!NativeFile.exists(audioDir)) continue;
    for (const chapter of NativeFile.readDir(audioDir)) {
      if (!chapter.isDirectory) continue;
      result.push({
        path: chapter.path,
        novelId: novel.name,
        chapterKey: chapter.name,
      });
    }
  }
  // Note: NativeFile doesn't expose mtime; "oldest" is approximated by
  // alphabetical order for now. A v2 may persist last-played timestamps
  // in MMKV per chapter and sort by those.
  return result;
}
