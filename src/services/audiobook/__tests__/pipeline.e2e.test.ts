/**
 * End-to-end pipeline test: drives processAudiobook (batch) and
 * streamChapterAudio (playback) through the real annotator, pipeline,
 * downloader, adapter, cache, and renderer code, with the process
 * boundaries substituted:
 *   - LLM HTTP calls  → canned glossary/annotation responses
 *   - NativeFile      → in-memory filesystem
 *   - onnxruntime     → stub session producing a known waveform
 *   - file-access     → base64 I/O against the same in-memory fs
 */

// ── In-memory filesystem ────────────────────────────────────────

type MemEntry = { kind: 'file'; data: string; encoding: 'utf8' | 'base64' };
const mockFs = new Map<string, MemEntry>();
const mockDirs = new Set<string>();

const mockWriteMem = (
  path: string,
  data: string,
  encoding: 'utf8' | 'base64' = 'utf8',
) => {
  mockFs.set(path, { kind: 'file', data, encoding });
};

const mockBytesToBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

jest.mock('@specs/NativeFile', () => ({
  __esModule: true,
  default: {
    getConstants: () => ({
      ExternalDirectoryPath: '/data',
      ExternalCachesDirectoryPath: '/cache',
    }),
    exists: jest.fn(
      (path: string) =>
        mockFs.has(path) ||
        mockDirs.has(path) ||
        [...mockFs.keys()].some(k => k.startsWith(`${path}/`)),
    ),
    mkdir: jest.fn((path: string) => {
      mockDirs.add(path);
    }),
    writeFile: jest.fn((path: string, content: string) => {
      mockWriteMem(path, content, 'utf8');
    }),
    readFile: jest.fn((path: string) => {
      const entry = mockFs.get(path);
      if (!entry) {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry.encoding === 'utf8'
        ? entry.data
        : Buffer.from(entry.data, 'base64').toString('latin1');
    }),
    unlink: jest.fn((path: string) => {
      mockFs.delete(path);
      mockDirs.delete(path);
      for (const key of [...mockFs.keys()]) {
        if (key.startsWith(`${path}/`)) {
          mockFs.delete(key);
        }
      }
    }),
    moveFile: jest.fn((src: string, dest: string) => {
      const entry = mockFs.get(src);
      if (!entry) {
        throw new Error(`ENOENT: ${src}`);
      }
      mockFs.set(dest, entry);
      mockFs.delete(src);
    }),
    downloadFile: jest.fn(async (url: string, destPath: string) => {
      mockDownloadedUrls.push(url);
      if (url.endsWith('tokenizer.json')) {
        mockWriteMem(
          destPath,
          JSON.stringify({
            model: { vocab: { a: 3, b: 4, ' ': 5, H: 6, i: 7 } },
            added_tokens: [
              { id: 1, content: '<s>' },
              { id: 2, content: '</s>' },
            ],
          }),
          'utf8',
        );
        return;
      }
      // Model + voice clips: 4 little-endian float32 values
      const floats = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      mockWriteMem(
        destPath,
        mockBytesToBase64(new Uint8Array(floats.buffer)),
        'base64',
      );
    }),
  },
}));

jest.mock('react-native-file-access', () => ({
  FileSystem: {
    readFile: jest.fn(async (path: string, encoding?: string) => {
      const entry = mockFs.get(path);
      if (!entry) {
        throw new Error(`ENOENT: ${path}`);
      }
      if (encoding === 'base64') {
        return entry.encoding === 'base64'
          ? entry.data
          : Buffer.from(entry.data, 'utf8').toString('base64');
      }
      return entry.data;
    }),
    writeFile: jest.fn(
      async (path: string, data: string, encoding?: string) => {
        mockWriteMem(path, data, encoding === 'base64' ? 'base64' : 'utf8');
      },
    ),
  },
}));

// ── ONNX runtime stub ───────────────────────────────────────────

const mockRunCalls: Array<Record<string, unknown>> = [];

jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: {
    create: jest.fn(async () => ({
      run: jest.fn(async (feeds: Record<string, unknown>) => {
        mockRunCalls.push(feeds);
        return {
          audio: { data: new Float32Array([0, 0.5, -0.5, 0.25]) },
        };
      }),
      release: jest.fn(),
    })),
  },
  Tensor: class MockTensor {
    type: string;
    data: unknown;
    dims: number[];
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
}));

// ── LLM fixtures ────────────────────────────────────────────────

const MOCK_GLOSSARY_RESPONSE = JSON.stringify({
  characters: [
    {
      name: 'Hero',
      aliases: ['The Chosen One'],
      gender: 'male',
      personality: ['brave'],
      description: 'The protagonist',
      importance: 10,
    },
  ],
  narratorGender: 'male',
});

const mockAnnotationResponse = () =>
  '```json\n' +
  JSON.stringify({
    segments: [
      {
        text: 'The sun rose over the valley.',
        speaker: 'narrator',
        emotion: 'neutral',
        isDialogue: false,
        pauseBefore: 'medium',
      },
      {
        text: 'We march at dawn!',
        speaker: 'The Chosen One',
        emotion: 'EXCITED', // out-of-enum on purpose
        isDialogue: true,
        pauseBefore: 'invalid-pause', // out-of-enum on purpose
      },
    ],
  }) +
  '\n```';

const mockLlmRequests: string[] = [];
const mockDownloadedUrls: string[] = [];

jest.mock('@utils/fetch/fetch', () => ({
  fetchTimeout: jest.fn(async (_url: string, init: { body: string }) => {
    mockLlmRequests.push(init.body);
    const isGlossary = init.body.includes('character glossary');
    const text = isGlossary ? MOCK_GLOSSARY_RESPONSE : mockAnnotationResponse();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }],
      }),
    };
  }),
}));

jest.mock('@utils/mmkv/mmkv', () => ({
  getMMKVObject: jest.fn(() => ({
    llmProvider: 'gemini',
    apiKey: 'test-key',
    baseUrl: '',
    model: '',
    ttsPrecision: 'q8',
    lookaheadSegments: 2,
    mainCharacterEmotionalSlots: 2,
  })),
}));

jest.mock('@plugins/pluginManager', () => ({
  getPlugin: jest.fn(() => ({
    parseChapter: jest.fn(async () => '<p>Network <b>chapter</b> HTML.</p>'),
  })),
}));

jest.mock('@database/queries/ChapterQueries', () => ({
  getChapter: jest.fn(async (id: number) =>
    id === 101 ? { id, isDownloaded: true } : { id, isDownloaded: false },
  ),
}));

import { processAudiobook } from '../processAudiobook';
import { AudiobookPipeline } from '../pipeline';
import { AudiobookConfig, AudioSegment } from '../types';

const CONFIG: AudiobookConfig = {
  llm: { provider: 'gemini', apiKey: 'test-key' },
  tts: {
    precision: 'q8',
    lookaheadSegments: 2,
    mainCharacterEmotionalSlots: 2,
  },
  novelId: '42',
};

describe('audiobook pipeline end-to-end', () => {
  beforeEach(() => {
    mockFs.clear();
    mockDirs.clear();
    mockLlmRequests.length = 0;
    mockDownloadedUrls.length = 0;
    mockRunCalls.length = 0;
  });

  it('batch-processes chapters into id-keyed caches with HTML stripped', async () => {
    // Chapter 101 is "downloaded" — its local file must be preferred
    // over the network plugin.
    mockWriteMem(
      '/data/Novels/test-plugin/42/101/index.html',
      '<p>Local chapter text with <i>markup</i>.</p>',
    );

    const metaUpdates: string[] = [];
    await processAudiobook(
      {
        novelId: 42,
        novelName: 'Test Novel',
        pluginId: 'test-plugin',
        chapterIds: [101, 202],
        chapterPaths: ['/c/101', '/c/202'],
      },
      transform => {
        const meta = transform({
          name: 'AUDIOBOOK_PIPELINE',
          isRunning: true,
          progress: 0,
          progressText: '',
        } as never);
        if (meta.progressText) {
          metaUpdates.push(meta.progressText);
        }
      },
    );

    // Caches keyed by real chapter ids, not loop indexes
    expect(mockFs.has('/data/Audiobook/42/glossary.json')).toBe(true);
    expect(mockFs.has('/data/Audiobook/42/voice-map.json')).toBe(true);
    expect(mockFs.has('/data/Audiobook/42/annotations/101.json')).toBe(true);
    expect(mockFs.has('/data/Audiobook/42/annotations/202.json')).toBe(true);
    expect(mockFs.has('/data/Audiobook/42/annotations/0.json')).toBe(false);

    // HTML must have been stripped before reaching the LLM
    const chapterPrompts = mockLlmRequests.filter(b =>
      b.includes('Annotate this chapter'),
    );
    expect(chapterPrompts.length).toBeGreaterThan(0);
    expect(mockLlmRequests.some(b => b.includes('Local chapter text'))).toBe(
      true,
    );
    expect(mockLlmRequests.every(b => !b.includes('<p>'))).toBe(true);

    // Alias got a voice mapping identical to the primary name
    const voiceMap = JSON.parse(
      mockFs.get('/data/Audiobook/42/voice-map.json')!.data,
    );
    expect(voiceMap.mappings['The Chosen One']).toEqual(voiceMap.mappings.Hero);

    // Out-of-enum LLM values were sanitized
    const annotation = JSON.parse(
      mockFs.get('/data/Audiobook/42/annotations/101.json')!.data,
    );
    expect(annotation.segments[1].emotion).toBe('neutral');
    expect(annotation.segments[1].pauseBefore).toBe('medium');

    expect(metaUpdates.some(t => t.includes('Finished processing'))).toBe(true);
  });

  it('streams playable WAV segments and reuses the audio cache', async () => {
    const pipeline = new AudiobookPipeline(CONFIG);
    await pipeline.processNovel([
      { id: 7, text: 'The sun rose. "We march at dawn!" he cried.' },
    ]);

    const annotation = (await pipeline.getAnnotation(7))!;
    expect(annotation.segments.length).toBeGreaterThan(0);

    const collect = async (): Promise<AudioSegment[]> => {
      const out: AudioSegment[] = [];
      for await (const segment of pipeline.streamChapterAudio(annotation)) {
        out.push(segment);
      }
      return out;
    };

    const segments = await collect();
    expect(segments).toHaveLength(annotation.segments.length);

    for (const segment of segments) {
      expect(segment.audioPath).toMatch(/\/cache\/Audiobook\/audio\/.+\.wav$/);
      const wav = mockFs.get(segment.audioPath!);
      expect(wav).toBeDefined();
      const bytes = Buffer.from(wav!.data, 'base64');
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
    }

    // Model and tokenizer were fetched through the atomic downloader
    expect(mockDownloadedUrls.some(u => u.includes('tokenizer.json'))).toBe(
      true,
    );
    expect([...mockFs.keys()].every(path => !path.endsWith('.part'))).toBe(
      true,
    );

    // Re-streaming the same chapter must be served from the audio
    // cache without new model runs.
    const runsAfterFirst = mockRunCalls.length;
    expect(runsAfterFirst).toBeGreaterThan(0);
    const again = await collect();
    expect(again).toHaveLength(segments.length);
    expect(mockRunCalls.length).toBe(runsAfterFirst);
  });
});
