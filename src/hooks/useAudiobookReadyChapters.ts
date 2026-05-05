/**
 * Returns the set of chapter ids that have an audiobook annotation
 * cached on disk.
 *
 * Reads `AUDIOBOOK_STORAGE/<novelId>/annotations/`, builds a Set of
 * `chapterKey`s present, then maps each chapter's path-hash through it
 * to produce a Set of chapter ids.
 *
 * Refreshes when `novelId` or the chapter list identity changes; the
 * caller can also force a refresh via the returned `refresh` function
 * (e.g. after queueing a batch processing task).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_STORAGE } from '@utils/Storages';
import { hashChapterPath } from '@services/audiobook';

interface ChapterLike {
  id: number;
  path: string;
}

export function useAudiobookReadyChapters(
  novelId: number | string | undefined,
  chapters: ChapterLike[],
): { ready: Set<number>; refresh: () => void } {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(() => {
    if (novelId === undefined || novelId === null) {
      setKeys(new Set());
      return;
    }
    const dir = `${AUDIOBOOK_STORAGE}/${novelId}/annotations`;
    if (!NativeFile.exists(dir)) {
      setKeys(new Set());
      return;
    }
    try {
      const entries = NativeFile.readDir(dir);
      const next = new Set<string>();
      for (const e of entries) {
        if (e.isDirectory) continue;
        if (!e.name.endsWith('.json')) continue;
        next.add(e.name.slice(0, -'.json'.length));
      }
      setKeys(next);
    } catch {
      setKeys(new Set());
    }
  }, [novelId]);

  useEffect(refresh, [refresh]);

  const ready = useMemo(() => {
    if (keys.size === 0) return new Set<number>();
    const out = new Set<number>();
    for (const c of chapters) {
      if (keys.has(hashChapterPath(c.path))) out.add(c.id);
    }
    return out;
  }, [keys, chapters]);

  return { ready, refresh };
}
