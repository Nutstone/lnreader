import {
  TTSConfig,
  Emotion,
  AudioSegment,
  ChapterAnnotation,
  VoiceMap,
  VoiceAssignment,
  VoiceClip,
} from './types';
import { PocketTTSAdapter } from './pocketTTSAdapter';
import { ModelDownloader } from './modelDownloader';
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
  private initialized = false;

  constructor(config: TTSConfig, cacheDir: string) {
    this.config = config;
    this.adapter = new PocketTTSAdapter();
    this.downloader = new ModelDownloader({
      cacheDir,
      modelRepoUrl: config.modelRepoUrl,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const modelPath = await this.downloader.ensureModel(this.config.precision);
    const tokenizerPath = await this.downloader.ensureTokenizer();
    await this.adapter.load(modelPath, tokenizerPath);
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    await this.adapter.unload();
    this.initialized = false;
  }

  async renderSegment(
    text: string,
    assignment: VoiceAssignment,
    emotion: Emotion,
  ): Promise<AudioSegment> {
    if (!this.initialized) {
      throw new Error('TTSRenderer not initialized. Call initialize() first.');
    }

    const clip = this.resolveClip(assignment, emotion);
    const clipPath = await this.downloader.ensureVoiceClip(clip);
    const speakerState = await this.adapter.loadSpeakerState(clipPath);
    const { samples, sampleRate } = await this.adapter.synthesize(
      text,
      speakerState,
    );

    const wavBytes = encodeWav(samples, sampleRate);
    const audioData = arrayBufferToBase64(wavBytes);
    const durationMs = (samples.length / sampleRate) * 1000;

    return {
      pauseBeforeMs: 0,
      audioData,
      durationMs,
      speaker: '',
      text,
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
    const renderQueue: Promise<AudioSegment>[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const assignment =
        voiceMap.mappings[segment.speaker] ?? voiceMap.mappings.narrator;
      const pauseBeforeMs = PAUSE_DURATIONS[segment.pauseBefore];

      const renderPromise = this.renderSegment(
        segment.text,
        assignment,
        segment.emotion,
      ).then(audio => ({
        ...audio,
        pauseBeforeMs,
        speaker: segment.speaker,
        text: segment.text,
      }));

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
   * Resolves the actual voice clip for a (character, emotion) pair.
   * Emotional assignments pick the variant matching the segment's
   * emotion (with neutral fallback). Donation assignments use the
   * single clip regardless of emotion — they have no emotional
   * variants by design.
   */
  private resolveClip(assignment: VoiceAssignment, emotion: Emotion): VoiceClip {
    if (assignment.kind === 'emotional') {
      const speaker = findEmotionalSpeaker(assignment.speakerId);
      if (!speaker) {
        throw new Error(
          `Unknown emotional speaker in voice map: ${assignment.speakerId}`,
        );
      }
      return emotionalVariantClip(speaker, emotion);
    }
    const voice = findDonationVoice(assignment.voiceId);
    if (!voice) {
      throw new Error(
        `Unknown donation voice in voice map: ${assignment.voiceId}`,
      );
    }
    return voice.clip;
  }
}

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
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
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
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(binary, 'binary').toString('base64');
};
