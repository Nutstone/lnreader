/**
 * End-to-end pipeline test: drives processAudiobook (batch) and
 * streamChapterAudio (playback) through the real annotator, pipeline,
 * downloader, PocketTTSEngine, audio cache, and renderer code, with
 * the process boundaries substituted:
 *   - LLM HTTP calls  → canned glossary/annotation responses
 *   - NativeFile      → in-memory filesystem
 *   - onnxruntime     → mock sessions implementing the bundle's
 *                       multi-graph contract (text conditioner →
 *                       flow-LM AR loop with explicit states → flow
 *                       step → stateful mimi decode)
 *   - file-access     → base64 I/O against the same in-memory fs
 *
 * The tokenizer is NOT mocked — the real SentencePiece port runs
 * against the real tokenizer.model fixture.
 */

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

// ── Mini bundle the mock "downloads" ────────────────────────────

const MOCK_LATENT_DIM = 2;
const MOCK_SAMPLES_PER_FRAME = 8;

const MOCK_BUNDLE_METADATA = {
  sample_rate: 24000,
  frame_rate: 12.5,
  samples_per_frame: MOCK_SAMPLES_PER_FRAME,
  latent_dim: MOCK_LATENT_DIM,
  conditioning_dim: 4,
  max_token_per_chunk: 50,
  insert_bos_before_voice: false,
  tokenizer_file: 'tokenizer.model',
  model_recommended_frames_after_eos: null,
  predefined_voices: [],
  flow_lm_state_manifest: [
    {
      dtype: 'float32',
      fill: 'zeros',
      index: 0,
      input_name: 'state_0',
      output_name: 'out_state_0',
      module: 'attn',
      key: 'cache',
      shape: [1, 2],
    },
  ],
  mimi_state_manifest: [
    {
      dtype: 'float32',
      fill: 'zeros',
      index: 0,
      input_name: 'state_0',
      output_name: 'out_state_0',
      module: 'dec',
      key: 'previous',
      shape: [1, 2],
    },
  ],
};

/** Minimal valid safetensors with an `attn/cache` tensor. */
const mockSafetensorsBytes = (): Uint8Array => {
  const header = JSON.stringify({
    'attn/cache': { dtype: 'F32', shape: [1, 2], data_offsets: [0, 8] },
  });
  const headerBytes = Buffer.from(header, 'utf8');
  const out = Buffer.alloc(8 + headerBytes.length + 8);
  out.writeBigUInt64LE(BigInt(headerBytes.length), 0);
  headerBytes.copy(out, 8);
  out.writeFloatLE(0.25, 8 + headerBytes.length);
  out.writeFloatLE(-0.5, 8 + headerBytes.length + 4);
  return new Uint8Array(out);
};

/** Minimal 16-bit PCM mono WAV (0.1s of a quiet ramp @24kHz). */
const mockWavBytes = (): Uint8Array => {
  const sampleRate = 24000;
  const samples = Math.floor(sampleRate / 10);
  const dataSize = samples * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE((i % 100) * 10, 44 + i * 2);
  }
  return new Uint8Array(out);
};

const mockDownloadedUrls: string[] = [];

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
      if (url.endsWith('bundle.json')) {
        mockWriteMem(destPath, JSON.stringify(MOCK_BUNDLE_METADATA), 'utf8');
        return;
      }
      if (url.endsWith('tokenizer.model')) {
        // Real tokenizer fixture — the SentencePiece port is exercised
        // for real inside this E2E.
        const fs = require('fs');
        const path = require('path');
        const bytes = fs.readFileSync(
          path.join(__dirname, 'fixtures', 'tokenizer.model'),
        );
        mockWriteMem(destPath, mockBytesToBase64(bytes), 'base64');
        return;
      }
      if (url.endsWith('.safetensors')) {
        mockWriteMem(
          destPath,
          mockBytesToBase64(mockSafetensorsBytes()),
          'base64',
        );
        return;
      }
      if (url.endsWith('.wav')) {
        mockWriteMem(destPath, mockBytesToBase64(mockWavBytes()), 'base64');
        return;
      }
      // ONNX graphs and anything else: content is irrelevant, the
      // mocked InferenceSession keys behavior off the path.
      mockWriteMem(destPath, mockBytesToBase64(Uint8Array.from([1])), 'base64');
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
      return entry.encoding === 'utf8'
        ? entry.data
        : Buffer.from(entry.data, 'base64').toString('utf8');
    }),
    writeFile: jest.fn(
      async (path: string, data: string, encoding?: string) => {
        mockWriteMem(path, data, encoding === 'base64' ? 'base64' : 'utf8');
      },
    ),
  },
}));

// ── Mock ONNX runtime implementing the bundle contract ──────────

const mockModelRuns: string[] = [];

class MockTensor {
  type: string;
  data: any;
  dims: number[];
  constructor(type: string, data: any, dims: number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

const mockMakeSession = (modelPath: string) => {
  const passThroughState = (
    feeds: Record<string, MockTensor>,
    result: Record<string, MockTensor>,
  ) => {
    if (feeds.state_0) {
      result.out_state_0 = new MockTensor(
        'float32',
        (feeds.state_0.data as Float32Array).slice(),
        [...feeds.state_0.dims],
      );
    }
  };

  if (modelPath.includes('text_conditioner')) {
    return {
      outputNames: ['text_embeddings'],
      run: async (feeds: Record<string, MockTensor>) => {
        mockModelRuns.push('text_conditioner');
        const tokenCount = feeds.token_ids.dims[1];
        return {
          text_embeddings: new MockTensor(
            'float32',
            new Float32Array(tokenCount * 4).fill(0.1),
            [1, tokenCount, 4],
          ),
        };
      },
    };
  }
  if (modelPath.includes('flow_lm_main')) {
    let arSteps = 0;
    return {
      outputNames: ['conditioning', 'eos_logit', 'out_state_0'],
      run: async (feeds: Record<string, MockTensor>) => {
        mockModelRuns.push('flow_lm_main');
        const isArStep = feeds.sequence.dims[1] === 1;
        // Fire EOS after 3 autoregressive frames per chunk; the text
        // conditioning pass (empty sequence, non-empty text) resets.
        if (!isArStep && feeds.text_embeddings.dims[1] > 0) {
          arSteps = 0;
        }
        const eos = isArStep && ++arSteps > 3 ? 10 : -10;
        const result: Record<string, MockTensor> = {
          conditioning: new MockTensor(
            'float32',
            new Float32Array(MOCK_LATENT_DIM).fill(0.2),
            [1, MOCK_LATENT_DIM],
          ),
          eos_logit: new MockTensor(
            'float32',
            Float32Array.from([eos]),
            [1, 1],
          ),
        };
        passThroughState(feeds, result);
        return result;
      },
    };
  }
  if (modelPath.includes('flow_lm_flow')) {
    return {
      outputNames: ['flow'],
      run: async () => {
        mockModelRuns.push('flow_lm_flow');
        return {
          flow: new MockTensor(
            'float32',
            new Float32Array(MOCK_LATENT_DIM).fill(0.3),
            [1, MOCK_LATENT_DIM],
          ),
        };
      },
    };
  }
  if (modelPath.includes('mimi_decoder')) {
    return {
      outputNames: ['audio', 'out_state_0'],
      run: async (feeds: Record<string, MockTensor>) => {
        mockModelRuns.push('mimi_decoder');
        const frames = feeds.latent.dims[1];
        const result: Record<string, MockTensor> = {
          audio: new MockTensor(
            'float32',
            new Float32Array(frames * MOCK_SAMPLES_PER_FRAME).fill(0.05),
            [1, 1, frames * MOCK_SAMPLES_PER_FRAME],
          ),
        };
        passThroughState(feeds, result);
        return result;
      },
    };
  }
  if (modelPath.includes('mimi_encoder')) {
    return {
      outputNames: ['embeddings'],
      run: async () => {
        mockModelRuns.push('mimi_encoder');
        return {
          embeddings: new MockTensor(
            'float32',
            new Float32Array(2 * 4).fill(0.15),
            [1, 2, 4],
          ),
        };
      },
    };
  }
  throw new Error(`Unexpected model path: ${modelPath}`);
};

jest.mock('onnxruntime-react-native', () => {
  // Defined inside the factory: the factory runs during import
  // evaluation, before this file's module body assigns MockTensor.
  class FactoryTensor {
    type: string;
    data: unknown;
    dims: number[];
    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    InferenceSession: {
      create: jest.fn(async (modelPath: string) => ({
        ...mockMakeSession(modelPath),
        release: jest.fn(),
      })),
    },
    Tensor: FactoryTensor,
  };
});

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
    ttsPrecision: 'int8',
    lookaheadSegments: 2,
    mainCharacterEmotionalSlots: 0,
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
    precision: 'int8',
    lookaheadSegments: 2,
    // Hero → donation voice (precomputed embedding path); narrator
    // stays on an emotional speaker (WAV voice-cloning path).
    mainCharacterEmotionalSlots: 0,
  },
  novelId: '42',
};

describe('audiobook pipeline end-to-end', () => {
  beforeEach(() => {
    mockFs.clear();
    mockDirs.clear();
    mockLlmRequests.length = 0;
    mockDownloadedUrls.length = 0;
    mockModelRuns.length = 0;
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

  it('bootstraps glossary and voice map on first play (reader path)', async () => {
    // No processNovel(): pressing play in the reader must work on a
    // novel that was never batch-processed.
    const pipeline = new AudiobookPipeline(CONFIG);
    const statuses: string[] = [];

    const annotation = await pipeline.annotateChapter(
      7,
      'The sun rose. "We march at dawn!" he cried.',
      message => statuses.push(message),
    );
    expect(statuses).toEqual([
      'Building character glossary…',
      'Annotating chapter…',
    ]);
    expect(annotation.segments.length).toBeGreaterThan(0);
    expect(await pipeline.getGlossary()).not.toBeNull();

    const segments: AudioSegment[] = [];
    for await (const segment of pipeline.streamChapterAudio(annotation)) {
      segments.push(segment);
    }
    expect(segments).toHaveLength(annotation.segments.length);
    expect(await pipeline.getVoiceMap()).not.toBeNull();

    // Second chapter reuses the bootstrapped glossary — no rebuild.
    const statuses2: string[] = [];
    await pipeline.annotateChapter(8, 'A new day dawned.', message =>
      statuses2.push(message),
    );
    expect(statuses2).toEqual(['Annotating chapter…']);
  });

  it('streams playable WAV segments through the real engine and reuses the audio cache', async () => {
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

    // The bundle, a predefined-voice embedding (donation path), and an
    // Expresso reference clip (voice-cloning path) were all fetched
    // through the atomic downloader — no .part leftovers.
    expect(mockDownloadedUrls.some(u => u.includes('bundle.json'))).toBe(true);
    expect(mockDownloadedUrls.some(u => u.endsWith('.safetensors'))).toBe(true);
    expect(mockDownloadedUrls.some(u => u.includes('expresso/'))).toBe(true);
    expect([...mockFs.keys()].every(p => !p.endsWith('.part'))).toBe(true);

    // The engine actually ran: conditioner, AR loop, flow, decode.
    for (const graph of [
      'text_conditioner',
      'flow_lm_main',
      'flow_lm_flow',
      'mimi_decoder',
      'mimi_encoder',
    ]) {
      expect(mockModelRuns).toContain(graph);
    }

    // Re-streaming the same chapter must be served from the audio
    // cache without new model runs.
    const runsAfterFirst = mockModelRuns.length;
    expect(runsAfterFirst).toBeGreaterThan(0);
    const again = await collect();
    expect(again).toHaveLength(segments.length);
    expect(mockModelRuns.length).toBe(runsAfterFirst);
  });
});
