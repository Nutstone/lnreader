/**
 * AudioCache integration tests with in-memory FS.
 */

import { AudioCache } from '../audioCache';
import { AudioSegmentRef, ChapterAnnotation } from '../types';

const mockFs = new Map<string, string>();
const mockDirs = new Set<string>();

jest.mock('@specs/NativeFile', () => ({
  __esModule: true,
  default: {
    exists: (p: string) => {
      if (mockFs.has(p) || mockDirs.has(p)) return true;
      const prefix = p + '/';
      for (const k of mockDirs) if (k.startsWith(prefix)) return true;
      for (const k of mockFs.keys()) if (k.startsWith(prefix)) return true;
      return false;
    },
    readFile: (p: string) => {
      if (!mockFs.has(p)) throw new Error('ENOENT: ' + p);
      return mockFs.get(p)!;
    },
    writeFile: (p: string, c: string) => {
      mockFs.set(p, c);
    },
    unlink: (p: string) => {
      mockFs.delete(p);
      mockDirs.delete(p);
      for (const k of [...mockFs.keys()]) if (k.startsWith(p + '/')) mockFs.delete(k);
      for (const k of [...mockDirs]) if (k.startsWith(p + '/')) mockDirs.delete(k);
    },
    mkdir: (p: string) => {
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        mockDirs.add('/' + parts.slice(0, i).join('/'));
      }
    },
    readDir: (p: string) => {
      const out: { name: string; path: string; isDirectory: boolean }[] = [];
      for (const k of mockFs.keys()) {
        if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) {
          out.push({ name: k.slice(p.length + 1), path: k, isDirectory: false });
        }
      }
      for (const k of mockDirs) {
        if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) {
          out.push({ name: k.slice(p.length + 1), path: k, isDirectory: true });
        }
      }
      return out;
    },
    getConstants: () => ({
      ExternalDirectoryPath: '/data/test',
      ExternalCachesDirectoryPath: '/data/cache',
    }),
    copyFile: () => undefined,
    moveFile: () => undefined,
    downloadFile: async () => undefined,
  },
}));

beforeEach(() => {
  mockFs.clear();
  mockDirs.clear();
});

const keys = { novelId: 'n1', chapterKey: 'k1', chapterId: 1 };

const segRef = (i: number, text = 'Hello'): AudioSegmentRef => ({
  index: i,
  file: `seg_${i.toString().padStart(4, '0')}.wav`,
  durationMs: 1000,
  pauseBeforeMs: 200,
  speaker: 'Rimuru',
  text,
  emotion: 'neutral',
  intensity: 2,
});

describe('AudioCache', () => {
  it('reads/writes manifest', () => {
    const c = new AudioCache();
    c.upsertSegment(keys, segRef(0));
    const m = c.readManifest(keys);
    expect(m).toBeTruthy();
    expect(m!.segments).toHaveLength(1);
    expect(m!.segments[0].index).toBe(0);
  });

  it('upsert merges segments by index', () => {
    const c = new AudioCache();
    c.upsertSegment(keys, segRef(0));
    c.upsertSegment(keys, segRef(1));
    c.upsertSegment(keys, segRef(0, 'overwritten'));
    const m = c.readManifest(keys)!;
    expect(m.segments).toHaveLength(2);
    expect(m.segments.find(s => s.index === 0)!.text).toBe('overwritten');
    expect(m.segments.find(s => s.index === 1)!.text).toBe('Hello');
  });

  it('readManifest returns null when no manifest', () => {
    expect(new AudioCache().readManifest(keys)).toBeNull();
  });

  it('readManifest deletes corrupt manifest', () => {
    const c = new AudioCache();
    const dir = '/data/cache/Audiobook/n1/k1';
    mockDirs.add(dir);
    mockFs.set(`${dir}/manifest.json`, 'not valid json');
    expect(c.readManifest(keys)).toBeNull();
    expect(mockFs.has(`${dir}/manifest.json`)).toBe(false);
  });

  it('computeInvalidation flags everything as invalidated when no manifest', () => {
    const c = new AudioCache();
    const annotation: ChapterAnnotation = {
      chapterId: 1,
      chapterKey: 'k1',
      segments: [
        {
          text: 'A',
          speaker: 'X',
          emotion: 'neutral',
          intensity: 2,
          isDialogue: false,
          pauseBefore: 'short',
        },
      ],
      createdAt: '',
    };
    const r = c.computeInvalidation(keys, annotation, null);
    expect(r.reusableIndexes.size).toBe(0);
  });

  it('computeInvalidation reuses matching segments', () => {
    const c = new AudioCache();
    const dir = '/data/cache/Audiobook/n1/k1';
    c.upsertSegment(keys, segRef(0, 'Hello'));
    mockFs.set(`${dir}/seg_0000.wav`, 'fake-wav-data');
    const annotation: ChapterAnnotation = {
      chapterId: 1,
      chapterKey: 'k1',
      segments: [
        {
          text: 'Hello',
          speaker: 'Rimuru',
          emotion: 'neutral',
          intensity: 2,
          isDialogue: false,
          pauseBefore: 'short',
        },
      ],
      createdAt: '',
    };
    const m = c.readManifest(keys);
    const r = c.computeInvalidation(keys, annotation, m);
    expect(r.reusableIndexes.has(0)).toBe(true);
  });

  it('computeInvalidation invalidates on text change', () => {
    const c = new AudioCache();
    const dir = '/data/cache/Audiobook/n1/k1';
    c.upsertSegment(keys, segRef(0, 'Old text'));
    mockFs.set(`${dir}/seg_0000.wav`, 'data');
    const annotation: ChapterAnnotation = {
      chapterId: 1,
      chapterKey: 'k1',
      segments: [
        {
          text: 'New text',
          speaker: 'Rimuru',
          emotion: 'neutral',
          intensity: 2,
          isDialogue: false,
          pauseBefore: 'short',
        },
      ],
      createdAt: '',
    };
    const r = c.computeInvalidation(keys, annotation, c.readManifest(keys));
    expect(r.reusableIndexes.has(0)).toBe(false);
  });

  it('computeInvalidation invalidates when audio file missing', () => {
    const c = new AudioCache();
    c.upsertSegment(keys, segRef(0));
    // No fake WAV — file missing.
    const annotation: ChapterAnnotation = {
      chapterId: 1,
      chapterKey: 'k1',
      segments: [
        {
          text: 'Hello',
          speaker: 'Rimuru',
          emotion: 'neutral',
          intensity: 2,
          isDialogue: false,
          pauseBefore: 'short',
        },
      ],
      createdAt: '',
    };
    const r = c.computeInvalidation(keys, annotation, c.readManifest(keys));
    expect(r.reusableIndexes.has(0)).toBe(false);
  });

  it('clearAll wipes rendered audio for every novel', () => {
    const c = new AudioCache();
    c.upsertSegment(keys, segRef(0));
    c.upsertSegment({ novelId: 'n2', chapterKey: 'k2', chapterId: 2 }, segRef(0));
    c.clearAll();
    expect(c.readManifest(keys)).toBeNull();
    expect(c.readManifest({ novelId: 'n2', chapterKey: 'k2', chapterId: 2 })).toBeNull();
  });

  it('clearForNovel wipes only one novel\'s rendered audio', () => {
    const c = new AudioCache();
    const n2keys = { novelId: 'n2', chapterKey: 'k2', chapterId: 2 };
    c.upsertSegment(keys, segRef(0));
    c.upsertSegment(n2keys, segRef(0));
    c.clearForNovel('n1');
    expect(c.readManifest(keys)).toBeNull();
    expect(c.readManifest(n2keys)).not.toBeNull();
  });

  it('upsert keeps total duration in sync', () => {
    const c = new AudioCache();
    c.upsertSegment(keys, segRef(0));
    c.upsertSegment(keys, segRef(1));
    c.upsertSegment(keys, segRef(2));
    const m = c.readManifest(keys)!;
    expect(m.totalSegments).toBeGreaterThanOrEqual(3);
    expect(m.totalDurationMs).toBe(3 * (1000 + 200));
  });
});
