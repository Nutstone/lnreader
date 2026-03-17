import {
  TTSConfig,
  BlendedVoice,
  Emotion,
  AudioSegment,
  ChapterAnnotation,
  VoiceMap,
} from './types';

const EMOTION_SPEED_MODIFIERS: Record<Emotion, number> = {
  neutral: 1.0,
  happy: 1.05,
  sad: 0.85,
  angry: 1.15,
  fearful: 1.1,
  surprised: 1.1,
  whisper: 0.9,
};

const PAUSE_DURATIONS: Record<'short' | 'medium' | 'long', number> = {
  short: 200,
  medium: 400,
  long: 800,
};

export class TTSRenderer {
  private config: TTSConfig;
  private model: any = null;
  private initialized = false;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Dynamic import to avoid loading Kokoro until needed
    const { KokoroTTS } = await import('kokoro-js');
    this.model = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      { dtype: this.config.dtype },
    );
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    if (this.model?.dispose) {
      await this.model.dispose();
    }
    this.model = null;
    this.initialized = false;
  }

  async renderSegment(
    text: string,
    voice: BlendedVoice,
    emotion: Emotion,
  ): Promise<AudioSegment> {
    if (!this.initialized || !this.model) {
      throw new Error('TTSRenderer not initialized. Call initialize() first.');
    }

    const speed = this.emotionToSpeed(emotion, voice.speed);
    const blendString = voice.components
      .map(c => `${c.voiceId}:${c.weight}`)
      .join(',');

    const audio = await this.model.generate(text, {
      voice: blendString,
      speed,
    });

    const wavBytes = audio.toWav();
    const audioData = this.arrayBufferToBase64(wavBytes);
    const durationMs = (audio.length / this.config.sampleRate) * 1000;

    return {
      pauseBeforeMs: 0,
      audioData,
      durationMs,
      speaker: '',
    };
  }

  async *streamChapterAudio(
    annotation: ChapterAnnotation,
    voiceMap: VoiceMap,
  ): AsyncGenerator<AudioSegment> {
    if (!this.initialized || !this.model) {
      throw new Error('TTSRenderer not initialized. Call initialize() first.');
    }

    const { segments } = annotation;
    const lookahead = this.config.lookaheadSegments;

    // Pre-render buffer for lookahead
    const renderQueue: Promise<AudioSegment>[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const voice =
        voiceMap.mappings[segment.speaker] || voiceMap.mappings.narrator;
      const pauseBeforeMs = this.pauseTypeToMs(segment.pauseBefore);

      // Start rendering this segment
      const renderPromise = this.renderSegment(
        segment.text,
        voice,
        segment.emotion,
      ).then(audio => ({
        ...audio,
        pauseBeforeMs,
        speaker: segment.speaker,
      }));

      renderQueue.push(renderPromise);

      // Yield when we have enough buffered or at end
      if (renderQueue.length >= lookahead || i === segments.length - 1) {
        const result = await renderQueue.shift()!;
        yield result;
      }
    }

    // Drain remaining queue
    while (renderQueue.length > 0) {
      yield await renderQueue.shift()!;
    }
  }

  private emotionToSpeed(emotion: Emotion, baseSpeed: number): number {
    return baseSpeed * EMOTION_SPEED_MODIFIERS[emotion];
  }

  private pauseTypeToMs(pauseType: 'short' | 'medium' | 'long'): number {
    return PAUSE_DURATIONS[pauseType];
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
