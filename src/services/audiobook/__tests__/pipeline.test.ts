/**
 * AudiobookPipeline integration tests.
 *
 * Mocks NativeFile (in-memory FS) and LLMAnnotator. Verifies cache
 * behaviour, glossary discovery, and chapter-key indexing.
 */

import { AudiobookPipeline } from '../pipeline';
import { LLMAnnotator } from '../llmAnnotator';
import { VoiceCaster } from '../voiceCaster';
import { AudioCache } from '../audioCache';
import { CharacterGlossary } from '../types';

// In-memory NativeFile mock. The variable names must start with "mock"
// for Jest's hoisted-mock guardrail to allow them inside the factory.
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
          out.push({
            name: k.slice(p.length + 1),
            path: k,
            isDirectory: false,
          });
        }
      }
      for (const k of mockDirs) {
        if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) {
          out.push({
            name: k.slice(p.length + 1),
            path: k,
            isDirectory: true,
          });
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

// Use the real chapter-key hasher so the cache lookup matches the
// annotator's output.
const { chapterKeyFor } = require('../chapterPath');

function mockAnnotator() {
  const buildGlossary = jest.fn(async (): Promise<CharacterGlossary> => sampleGlossary);
  const annotateChapter = jest.fn(async (chapterId: number, path: string) => ({
    chapterId,
    chapterKey: chapterKeyFor(path),
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
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
  }));
  const extendGlossary = jest.fn(async () => []);
  return {
    buildGlossary,
    annotateChapter,
    extendGlossary,
  } as unknown as LLMAnnotator;
}

describe('AudiobookPipeline', () => {
  it('builds glossary, voice map, and per-chapter annotations', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      {
        novelId: 'novel-1',
        llm: { provider: 'anthropic', apiKey: 'sk' },
        tts: { playbackSpeed: 1, emotionShaping: true, lookaheadSegments: 3 },
      },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );

    await pipeline.processChapters([
      { id: 1, path: '/n/1', rawText: 'first' },
      { id: 2, path: '/n/2', rawText: 'second' },
    ]);

    const g = await pipeline.getGlossary();
    expect(g?.characters[0].name).toBe('Rimuru');

    const v = await pipeline.getVoiceMap();
    expect(v?.mappings.Rimuru).toBeDefined();
    expect(v?.mappings.narrator).toBeDefined();

    expect((annotator.buildGlossary as jest.Mock).mock.calls).toHaveLength(1);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('reuses cached glossary on second run', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      {
        novelId: 'novel-2',
        llm: { provider: 'anthropic', apiKey: 'sk' },
        tts: { playbackSpeed: 1, emotionShaping: true, lookaheadSegments: 3 },
      },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    await pipeline.processChapters([
      { id: 1, path: '/n/1', rawText: 'a' },
      { id: 2, path: '/n/2', rawText: 'b' },
    ]);
    expect((annotator.buildGlossary as jest.Mock).mock.calls).toHaveLength(1);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);

    await pipeline.processChapters([
      { id: 1, path: '/n/1', rawText: 'a' },
      { id: 2, path: '/n/2', rawText: 'b' },
    ]);
    // No new LLM calls — everything cached.
    expect((annotator.buildGlossary as jest.Mock).mock.calls).toHaveLength(1);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('keys annotations by path-hash, not chapter index', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      {
        novelId: 'novel-3',
        llm: { provider: 'anthropic', apiKey: 'sk' },
        tts: { playbackSpeed: 1, emotionShaping: true, lookaheadSegments: 3 },
      },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    await pipeline.processChapters([
      { id: 1, path: '/n/foo', rawText: 'a' },
    ]);
    // Plugin re-orders: chapter at index 0 is now /n/foo (same path) but
    // shifted by a new chapter inserted before. Path-hash means cache hit.
    await pipeline.processChapters([
      { id: 99, path: '/n/foo', rawText: 'a' },
    ]);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(1);

    // Different path → new annotation.
    await pipeline.processChapters([
      { id: 99, path: '/n/foo-different', rawText: 'a' },
    ]);
    expect((annotator.annotateChapter as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('discovers new speakers mid-novel and extends glossary', async () => {
    const annotator = mockAnnotator();
    // Annotate chapter 1 with 4 unknown speakers — triggers discovery.
    (annotator.annotateChapter as jest.Mock).mockImplementationOnce(
      async (chapterId: number) => ({
        chapterId,
        chapterKey: 'k_disc_' + chapterId,
        segments: [
          { text: '"Hi"', speaker: 'NewA', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
          { text: '"Yo"', speaker: 'NewB', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
          { text: '"Hey"', speaker: 'NewC', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
          { text: '"Hello"', speaker: 'Rimuru', emotion: 'neutral', intensity: 2, isDialogue: true, pauseBefore: 'short' },
        ],
        createdAt: '',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      }),
    );
    (annotator.extendGlossary as jest.Mock).mockResolvedValueOnce([
      {
        name: 'NewA',
        aliases: [],
        gender: 'male',
        personality: ['warrior'],
        voiceHints: [],
        description: '',
      },
      {
        name: 'NewB',
        aliases: [],
        gender: 'female',
        personality: ['gentle'],
        voiceHints: [],
        description: '',
      },
      {
        name: 'NewC',
        aliases: [],
        gender: 'neutral',
        personality: ['child'],
        voiceHints: [],
        description: '',
      },
    ]);

    const pipeline = new AudiobookPipeline(
      {
        novelId: 'novel-4',
        llm: { provider: 'anthropic', apiKey: 'sk' },
        tts: { playbackSpeed: 1, emotionShaping: true, lookaheadSegments: 3 },
      },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );

    await pipeline.processChapters([{ id: 1, path: '/n/1', rawText: 'x' }]);

    expect((annotator.extendGlossary as jest.Mock).mock.calls).toHaveLength(1);
    const updatedGlossary = await pipeline.getGlossary();
    expect(updatedGlossary?.characters.map(c => c.name)).toEqual(
      expect.arrayContaining(['Rimuru', 'NewA', 'NewB', 'NewC']),
    );
    const updatedVm = await pipeline.getVoiceMap();
    expect(Object.keys(updatedVm?.mappings ?? {})).toEqual(
      expect.arrayContaining(['NewA', 'NewB', 'NewC']),
    );
  });

  it('estimateCost is free for ollama provider', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      {
        novelId: 'novel-5',
        llm: { provider: 'ollama', baseUrl: 'http://localhost:11434' },
        tts: { playbackSpeed: 1, emotionShaping: true, lookaheadSegments: 3 },
      },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    const est = await pipeline.estimateCost([
      { id: 1, path: '/n/1', rawText: 'word '.repeat(1000) },
    ]);
    expect(est.isFree).toBe(true);
    expect(est.costUSDWithCache).toBe(0);
  });

  it('estimateCost gives a non-zero cost for Anthropic', async () => {
    const annotator = mockAnnotator();
    const pipeline = new AudiobookPipeline(
      {
        novelId: 'novel-6',
        llm: { provider: 'anthropic', apiKey: 'sk' },
        tts: { playbackSpeed: 1, emotionShaping: true, lookaheadSegments: 3 },
      },
      { annotator, caster: new VoiceCaster(), cache: new AudioCache() },
    );
    const est = await pipeline.estimateCost([
      { id: 1, path: '/n/1', rawText: 'word '.repeat(2000) },
      { id: 2, path: '/n/2', rawText: 'word '.repeat(2000) },
    ]);
    expect(est.isFree).toBe(false);
    expect(est.costUSDWithCache).toBeGreaterThan(0);
    expect(est.costUSDWithCache).toBeLessThan(est.costUSDWithoutCache);
  });
});
