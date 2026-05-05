/**
 * AudiobookPipeline integration tests with in-memory FS + mocked annotator.
 */

import { AudiobookPipeline } from '../pipeline';
import { LLMAnnotator } from '../llmAnnotator';
import { VoiceCaster } from '../voiceCaster';
import { AudioCache } from '../audioCache';
import { CharacterGlossary } from '../types';

const mockFs = new Map<string, string>();
const mockDirs = new Set<string>();

jest.mock('@specs/NativeFile', () => ({
  __esModule: true,
  default: {
    exists: (p: string) => mockFs.has(p) || mockDirs.has(p),
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
      mockDirs.add(p);
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

const sampleGlossary: CharacterGlossary = {
  novelId: 't',
  narratorGender: 'male',
  narratorVoiceHints: ['warm'],
  characters: [
    {
      name: 'Rimuru',
      aliases: [],
      gender: 'neutral',
      personality: ['gentle'],
      voiceHints: ['medium'],
      description: 'A slime.',
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function mockAnnotator() {
  const buildGlossary = jest.fn(async (): Promise<CharacterGlossary> => sampleGlossary);
  const annotateChapter = jest.fn(async (chapterId: number) => ({
    chapterId,
    segments: [
      {
        text: 'Hello.',
        speaker: 'Rimuru',
        emotion: 'neutral' as const,
        intensity: 2 as 1 | 2 | 3,
        isDialogue: true,
        pauseBefore: 'short' as const,
      },
    ],
    createdAt: new Date().toISOString(),
  }));
  const extendGlossary = jest.fn(async () => []);
  return { buildGlossary, annotateChapter, extendGlossary } as unknown as LLMAnnotator;
}

const baseConfig = {
  novelId: 'novel-1',
  pluginId: 'plugin-1',
  llm: { apiKey: 'sk' },
  tts: {
    playbackSpeed: 1,
    emotionShaping: true,
    lookaheadSegments: 3,
    dtype: 'q8' as const,
  },
};

describe('AudiobookPipeline', () => {
  it('annotateOne builds glossary on first call and reuses it after', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(baseConfig, {
      annotator,
      caster: new VoiceCaster(),
      cache: new AudioCache(),
    });

    const ann1 = await pipeline.annotateOne({
      id: 1,
      path: '/n/1',
      rawText: 'first',
    });
    expect(ann1.segments).toHaveLength(1);
    expect((annotator.buildGlossary as jest.Mock).mock.calls).toHaveLength(1);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(1);

    // Second chapter reuses the existing glossary.
    await pipeline.annotateOne({ id: 2, path: '/n/2', rawText: 'second' });
    expect((annotator.buildGlossary as jest.Mock).mock.calls).toHaveLength(1);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);

    // Voice map persisted.
    const v = await pipeline.getVoiceMap();
    expect(v?.mappings.Rimuru).toBeDefined();
    expect(v?.mappings.narrator).toBeDefined();
  });

  it('annotateOne returns cached annotation on second call for the same chapter', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      { ...baseConfig, novelId: 'novel-2' },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    await pipeline.annotateOne({ id: 1, path: '/n/1', rawText: 'a' });
    await pipeline.annotateOne({ id: 1, path: '/n/1', rawText: 'a' });
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('keys annotations by chapter id under NOVEL_STORAGE', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      { ...baseConfig, novelId: 'novel-3' },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    await pipeline.annotateOne({ id: 7, path: '/n/foo', rawText: 'a' });
    expect(
      mockFs.has('/data/test/Novels/plugin-1/novel-3/7/audiobook.json'),
    ).toBe(true);
    expect(
      mockFs.has('/data/test/Novels/plugin-1/novel-3/audiobook.glossary.json'),
    ).toBe(true);
    expect(
      mockFs.has('/data/test/Novels/plugin-1/novel-3/audiobook.voice-map.json'),
    ).toBe(true);
  });

  it('processChapters annotates a batch and reports completion per chapter', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      { ...baseConfig, novelId: 'novel-batch' },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    const completed: number[] = [];
    await pipeline.processChapters(
      [
        { id: 1, path: '/n/1', rawText: 'first' },
        { id: 2, path: '/n/2', rawText: 'second' },
      ],
      undefined,
      id => {
        completed.push(id);
      },
    );
    expect(completed).toEqual([1, 2]);
    expect((annotator.buildGlossary as jest.Mock).mock.calls).toHaveLength(1);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);

    // Re-running is idempotent — annotations are cached.
    completed.length = 0;
    await pipeline.processChapters(
      [
        { id: 1, path: '/n/1', rawText: 'first' },
        { id: 2, path: '/n/2', rawText: 'second' },
      ],
      undefined,
      id => {
        completed.push(id);
      },
    );
    // Callback still fires for chapters whose annotations are already
    // cached so callers can refresh DB flags etc.
    expect(completed).toEqual([1, 2]);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('discovers new speakers mid-novel and extends glossary', async () => {
    const annotator = mockAnnotator();
    (annotator.annotateChapter as jest.Mock).mockImplementationOnce(
      async (chapterId: number) => ({
        chapterId,
        segments: [
          { text: '"Hi"', speaker: 'NewA', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
          { text: '"Yo"', speaker: 'NewB', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
          { text: '"Hey"', speaker: 'NewC', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
          { text: '"Hello"', speaker: 'Rimuru', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
        ],
        createdAt: '',
      }),
    );
    (annotator.extendGlossary as jest.Mock).mockResolvedValueOnce([
      { name: 'NewA', aliases: [], gender: 'male', personality: ['warrior'], voiceHints: [], description: '' },
      { name: 'NewB', aliases: [], gender: 'female', personality: ['gentle'], voiceHints: [], description: '' },
      { name: 'NewC', aliases: [], gender: 'neutral', personality: ['child'], voiceHints: [], description: '' },
    ]);

    const pipeline = new AudiobookPipeline(
      { ...baseConfig, novelId: 'novel-discovery' },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    await pipeline.annotateOne({ id: 1, path: '/n/1', rawText: 'x' });

    expect((annotator.extendGlossary as jest.Mock).mock.calls).toHaveLength(1);
    const updated = await pipeline.getGlossary();
    expect(updated?.characters.map(c => c.name)).toEqual(
      expect.arrayContaining(['Rimuru', 'NewA', 'NewB', 'NewC']),
    );
    const vm = await pipeline.getVoiceMap();
    expect(Object.keys(vm?.mappings ?? {})).toEqual(
      expect.arrayContaining(['NewA', 'NewB', 'NewC']),
    );
  });

  it('clearCache wipes audiobook artefacts but keeps the chapter dir', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      { ...baseConfig, novelId: 'novel-clear' },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    await pipeline.annotateOne({ id: 5, path: '/n/5', rawText: 'a' });
    // Simulate a co-located download artefact that must NOT be deleted.
    mockFs.set('/data/test/Novels/plugin-1/novel-clear/5/index.html', '<p>hi</p>');

    await pipeline.clearCache();

    expect(await pipeline.getGlossary()).toBeNull();
    expect(await pipeline.getVoiceMap()).toBeNull();
    expect(
      mockFs.has('/data/test/Novels/plugin-1/novel-clear/5/audiobook.json'),
    ).toBe(false);
    expect(
      mockFs.has('/data/test/Novels/plugin-1/novel-clear/5/index.html'),
    ).toBe(true);
  });
});
