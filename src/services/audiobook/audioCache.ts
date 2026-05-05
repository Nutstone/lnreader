/**
 * Audio cache for rendered chapters.
 *
 * Layout (under AUDIOBOOK_AUDIO_CACHE — the OS cache directory):
 *   <novelId>/<chapterId>/
 *     manifest.json
 *     seg_0001.wav
 *     ...
 *
 * Lives in the cache directory so backups skip it. Annotations and
 * glossary live next to the chapter / novel directories under
 * NOVEL_STORAGE.
 *
 * No size accounting — `NativeFile` doesn't expose stat. Settings has
 * a single "Clear rendered audio" button, novels have a per-novel
 * reset.
 */

import NativeFile from '@specs/NativeFile';
import {
  AUDIOBOOK_AUDIO_CACHE,
  audiobookAudioDir,
} from '@utils/Storages';
import {
  AudioSegmentRef,
  ChapterAudioManifest,
  ChapterAnnotation,
} from './types';

export interface AudioCacheKeys {
  novelId: number | string;
  chapterId: number;
}

export class AudioCache {
  private chapterDir(keys: AudioCacheKeys): string {
    return audiobookAudioDir(keys.novelId, keys.chapterId);
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
      return JSON.parse(NativeFile.readFile(path)) as ChapterAudioManifest;
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
   * Merge a new segment into the manifest by index. Caller invokes this
   * after each render so partial progress is recoverable.
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
      chapterId: keys.chapterId,
      totalSegments:
        totalSegmentsHint ??
        Math.max(existing?.totalSegments ?? 0, segments.length),
      totalDurationMs: segments.reduce(
        (s, x) => s + x.durationMs + x.pauseBeforeMs,
        0,
      ),
      segments,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeManifest(keys, manifest);
    return manifest;
  }

  /**
   * Compare a manifest against the current annotation. Segments with
   * matching text + emotion + intensity and a present audio file are
   * reusable; the rest must be re-rendered.
   */
  computeInvalidation(
    keys: AudioCacheKeys,
    annotation: ChapterAnnotation,
    manifest: ChapterAudioManifest | null,
  ): { reusableIndexes: Set<number> } {
    const reusable = new Set<number>();
    if (!manifest) return { reusableIndexes: reusable };

    const byIndex = new Map<number, AudioSegmentRef>(
      manifest.segments.map(s => [s.index, s]),
    );
    const dir = this.chapterDir(keys);
    annotation.segments.forEach((s, idx) => {
      const cached = byIndex.get(idx);
      if (!cached) return;
      const filePresent = NativeFile.exists(`${dir}/${cached.file}`);
      if (
        cached.text === s.text &&
        cached.emotion === s.emotion &&
        cached.intensity === s.intensity &&
        filePresent
      ) {
        reusable.add(idx);
      }
    });
    return { reusableIndexes: reusable };
  }

  /**
   * Drop all rendered audio for every novel. Annotations and glossaries
   * stay (they're not in the cache root).
   */
  clearAll(): void {
    if (!NativeFile.exists(AUDIOBOOK_AUDIO_CACHE)) return;
    NativeFile.unlink(AUDIOBOOK_AUDIO_CACHE);
    NativeFile.mkdir(AUDIOBOOK_AUDIO_CACHE);
  }

  /**
   * Drop the rendered-audio cache for one novel.
   */
  clearForNovel(novelId: number | string): void {
    const dir = `${AUDIOBOOK_AUDIO_CACHE}/${novelId}`;
    if (NativeFile.exists(dir)) NativeFile.unlink(dir);
  }
}
