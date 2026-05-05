/**
 * Audio cache for rendered chapters.
 *
 * Layout:
 *   AUDIOBOOK_STORAGE/<novelId>/audio/<chapterKey>/
 *     manifest.json
 *     seg_0001.wav
 *     ...
 *
 * Reuses `@specs/NativeFile`. The manifest is the index. There's no
 * size accounting — `NativeFile` doesn't expose stat, and reading every
 * WAV's content to estimate bytes is absurd. The settings screen
 * exposes a single "clear cache" button and that's it.
 */

import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_STORAGE } from '@utils/Storages';
import {
  AudioSegmentRef,
  ChapterAudioManifest,
  ChapterAnnotation,
} from './types';

export interface AudioCacheKeys {
  novelId: string;
  chapterKey: string;
  chapterId: number;
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
      chapterKey: keys.chapterKey,
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
   * Drop every audiobook file across the app.
   */
  clearAll(): void {
    if (!NativeFile.exists(AUDIOBOOK_STORAGE)) return;
    NativeFile.unlink(AUDIOBOOK_STORAGE);
    NativeFile.mkdir(AUDIOBOOK_STORAGE);
  }
}
