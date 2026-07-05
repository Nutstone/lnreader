import {
  TTSConfig,
  Emotion,
  AudioSegment,
  ChapterAnnotation,
  TTSSetupProgress,
  VoiceMap,
  VoiceAssignment,
  VoiceSpec,
} from './types';
import { PocketTTSAdapter, voiceKey } from './pocketTTSAdapter';
import { resampleLinear } from './pocketTTS/binaryFormats';
import { ModelDownloader } from './modelDownloader';
import { AudioCache } from './audioCache';
import { postProcess } from './audioPostProcessor';
import {
  emotionalVariantClip,
  findDonationVoice,
  findEmotionalSpeaker,
} from './voiceBank';

const PAUSE_DURATIONS: Record<'short' | 'medium' | 'long', number> = {
  short: 200,
  medium: 400,
  long: 800,
};

export class TTSRenderer {
  private config: TTSConfig;
  private adapter: PocketTTSAdapter;
  private downloader: ModelDownloader;
  private audioCache: AudioCache;
  private initialized = false;
  /**
   * Serializes initialize/dispose so a dispose that begins while the
   * model is (down)loading runs strictly after the load completes —
   * otherwise the load would finish after teardown and leak the ONNX
   * sessions (native memory, never GC'd).
   */
  private lifecycleChain: Promise<void> = Promise.resolve();
  /** In-flight synthesis/prefetch work; dispose waits for it. */
  private pendingWork = new Set<Promise<void>>();

  constructor(config: TTSConfig, cacheDir: string) {
    this.config = config;
    this.adapter = new PocketTTSAdapter();
    this.downloader = new ModelDownloader(cacheDir);
    this.audioCache = new AudioCache(`${cacheDir}/audio`);
  }

  private serializeLifecycle<T>(op: () => Promise<T>): Promise<T> {
    const run = this.lifecycleChain.then(op, op);
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    this.pendingWork.add(settled);
    settled.then(() => this.pendingWork.delete(settled));
    return promise;
  }

  async initialize(
    onProgress?: (progress: TTSSetupProgress) => void,
  ): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.initialized) {
        return;
      }
      const paths = await this.downloader.ensureBundle(
        this.config.precision,
        p => onProgress?.({ stage: 'bundle', ...p }),
      );
      onProgress?.({ stage: 'model-load' });
      await this.adapter.load(paths);
      this.initialized = true;
    });
  }

  async dispose(): Promise<void> {
    return this.serializeLifecycle(async () => {
      // Releasing a session that a lookahead render is still running
      // on is a native use-after-free; wait the stragglers out.
      while (this.pendingWork.size > 0) {
        await Promise.all([...this.pendingWork]);
      }
      await this.adapter.unload();
      this.initialized = false;
    });
  }

  /**
   * Downloads every voice file referenced in the chapter and warms
   * the voice-state cache before rendering starts. Eliminates the
   * per-speaker first-line stutter (one download + state preparation
   * per unique voice, paid up front instead of mid-stream).
   */
  async prefetchForChapter(
    annotation: ChapterAnnotation,
    voiceMap: VoiceMap,
    onProgress?: (progress: TTSSetupProgress) => void,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('TTSRenderer not initialized. Call initialize() first.');
    }

    const resolveAssignment = buildAssignmentResolver(voiceMap);
    const specs = new Map<string, VoiceSpec>();
    for (const segment of annotation.segments) {
      const assignment = resolveAssignment(segment.speaker);
      if (!assignment) {
        continue;
      }
      const spec = this.resolveVoiceSpec(assignment, segment.emotion);
      specs.set(voiceKey(spec), spec);
    }

    const total = specs.size;
    let done = 0;
    onProgress?.({ stage: 'voices', done, total });
    await this.track(
      Promise.all(
        [...specs.values()].map(async spec => {
          const localPath = await this.ensureVoiceFile(spec);
          await this.adapter.prepareVoiceState(spec, localPath);
          done++;
          onProgress?.({ stage: 'voices', done, total });
        }),
      ).then(() => undefined),
    );
  }

  async renderSegment(
    text: string,
    assignment: VoiceAssignment,
    emotion: Emotion,
  ): Promise<AudioSegment> {
    if (!this.initialized) {
      throw new Error('TTSRenderer not initialized. Call initialize() first.');
    }
    return this.track(this.renderSegmentInner(text, assignment, emotion));
  }

  private async renderSegmentInner(
    text: string,
    assignment: VoiceAssignment,
    emotion: Emotion,
  ): Promise<AudioSegment> {
    const spec = this.resolveVoiceSpec(assignment, emotion);
    // Pitch is baked into the rendered audio (resample), so it is
    // part of the cache identity; speed/volume are playback-time and
    // deliberately are not.
    const pitch =
      assignment.pitch && assignment.pitch !== 1 ? assignment.pitch : 1;
    const cacheVoice =
      pitch !== 1 ? `${voiceKey(spec)}#p${pitch.toFixed(2)}` : voiceKey(spec);
    const cacheKey = AudioCache.keyFor(text, cacheVoice);
    const audioPath = this.audioCache.pathFor(cacheKey);
    // Rendered audio is 1/pitch long; playing at speed/pitch with
    // pitch correction restores natural pace at the shifted pitch.
    const playbackRate = (assignment.speed ?? 1) / pitch;

    if (this.audioCache.has(cacheKey)) {
      return {
        pauseBeforeMs: 0,
        audioPath,
        durationMs: 0,
        speaker: '',
        text,
        speed: playbackRate,
        volume: assignment.volume,
      };
    }

    const localPath = await this.ensureVoiceFile(spec);
    const voiceState = await this.adapter.prepareVoiceState(spec, localPath);
    const { samples, sampleRate } = await this.adapter.synthesize(
      text,
      voiceState,
    );
    let processed = postProcess(samples);
    if (pitch !== 1) {
      processed = resampleLinear(processed, sampleRate, sampleRate / pitch);
    }

    const wavBytes = encodeWav(processed, sampleRate);
    await this.audioCache.set(cacheKey, arrayBufferToBase64(wavBytes));

    return {
      pauseBeforeMs: 0,
      audioPath,
      durationMs: (processed.length / sampleRate) * 1000,
      speaker: '',
      text,
      speed: playbackRate,
      volume: assignment.volume,
    };
  }

  async *streamChapterAudio(
    annotation: ChapterAnnotation,
    voiceMap: VoiceMap,
  ): AsyncGenerator<AudioSegment> {
    if (!this.initialized) {
      throw new Error('TTSRenderer not initialized. Call initialize() first.');
    }

    const { segments } = annotation;
    const lookahead = this.config.lookaheadSegments;
    const resolveAssignment = buildAssignmentResolver(voiceMap);
    const renderQueue: Promise<AudioSegment>[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const assignment = resolveAssignment(segment.speaker);
      const pauseBeforeMs =
        PAUSE_DURATIONS[segment.pauseBefore] ?? PAUSE_DURATIONS.medium;

      const renderPromise = this.renderSegment(
        segment.text,
        assignment,
        segment.emotion,
      ).then(audio => ({
        ...audio,
        pauseBeforeMs,
        speaker: segment.speaker,
      }));
      // A queued promise may reject while an earlier one is being
      // awaited; register a handler so that never surfaces as an
      // unhandled rejection. The rejection still propagates when the
      // promise is shifted below.
      renderPromise.catch(() => {});

      renderQueue.push(renderPromise);

      if (renderQueue.length >= lookahead || i === segments.length - 1) {
        const result = await renderQueue.shift()!;
        yield result;
      }
    }

    while (renderQueue.length > 0) {
      yield await renderQueue.shift()!;
    }
  }

  /**
   * Resolves the voice spec for a (character, emotion) pair.
   * Emotional assignments pick the reference clip matching the
   * segment's emotion (neutral fallback); donation assignments use
   * the precomputed prompt state regardless of emotion — they have
   * no emotional variants by design.
   */
  private resolveVoiceSpec(
    assignment: VoiceAssignment,
    emotion: Emotion,
  ): VoiceSpec {
    if (assignment.kind === 'emotional') {
      const speaker = findEmotionalSpeaker(assignment.speakerId);
      if (!speaker) {
        throw new Error(
          `Unknown emotional speaker in voice map: ${assignment.speakerId}`,
        );
      }
      return { kind: 'clip', clip: emotionalVariantClip(speaker, emotion) };
    }
    const voice = findDonationVoice(assignment.voiceId);
    if (!voice) {
      throw new Error(
        `Unknown donation voice in voice map: ${assignment.voiceId}`,
      );
    }
    return { kind: 'embedding', name: voice.embeddingName };
  }

  private async ensureVoiceFile(spec: VoiceSpec): Promise<string> {
    return spec.kind === 'embedding'
      ? this.downloader.ensureVoiceEmbedding(spec.name)
      : this.downloader.ensureVoiceClip(spec.clip);
  }
}

// ── Speaker resolution ──────────────────────────────────────────

/**
 * Looks up a segment speaker in the voice map: exact name first,
 * then case-insensitive, then the narrator. The annotator is told
 * to use canonical glossary names, but LLM output drifts.
 */
const buildAssignmentResolver = (voiceMap: VoiceMap) => {
  const byLowerName = new Map<string, VoiceAssignment>();
  for (const [name, assignment] of Object.entries(voiceMap.mappings)) {
    byLowerName.set(name.toLowerCase(), assignment);
  }
  return (speaker: string): VoiceAssignment =>
    voiceMap.mappings[speaker] ??
    byLowerName.get(speaker.toLowerCase()) ??
    voiceMap.mappings.narrator;
};

// ── WAV encoding ────────────────────────────────────────────────

const encodeWav = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += 2;
  }
  return buffer;
};

const writeString = (view: DataView, offset: number, str: string) => {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  const abc =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  /* eslint-disable no-bitwise */
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    parts.push(
      abc[b0 >> 2] +
        abc[((b0 & 3) << 4) | (b1 >> 4)] +
        (i + 1 < bytes.length ? abc[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
        (i + 2 < bytes.length ? abc[b2 & 63] : '='),
    );
  }
  /* eslint-enable no-bitwise */
  return parts.join('');
};
