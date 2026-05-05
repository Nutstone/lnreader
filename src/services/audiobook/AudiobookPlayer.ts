import { Audio } from 'expo-av';
import NativeFile from '@specs/NativeFile';
import { getMMKVObject } from '@utils/mmkv/mmkv';
import {
  AUDIOBOOK_SETTINGS,
  AudiobookSettings,
} from '@hooks/persisted/useAudiobookSettings';
import { AudiobookPipeline } from './pipeline';
import { AudioSegment, ChapterAnnotation, AudiobookConfig } from './types';
import { AUDIOBOOK_STORAGE } from '@utils/Storages';

export type AudiobookState = 'idle' | 'processing' | 'playing' | 'paused';

export class AudiobookPlayer {
  private pipeline: AudiobookPipeline | null = null;
  private segments: AudioSegment[] = [];
  private currentIndex = 0;
  private sound: Audio.Sound | null = null;
  private state: AudiobookState = 'idle';
  private currentNovelId = '';
  private tempDir = '';
  private activeGenerator: AsyncGenerator<AudioSegment> | null = null;
  private bufferingPromise: Promise<void> | null = null;
  private segmentResolvers: (() => void)[] = [];

  // Callbacks
  onSegmentChange?: (
    index: number,
    total: number,
    speaker: string,
    text: string,
  ) => void;
  onFinished?: () => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: AudiobookState) => void;

  private setState(newState: AudiobookState) {
    this.state = newState;
    this.onStateChange?.(newState);
  }

  getState(): AudiobookState {
    return this.state;
  }

  private getPipeline(novelId: string): AudiobookPipeline {
    if (this.pipeline && this.currentNovelId === novelId) {
      return this.pipeline;
    }

    const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);
    if (!settings?.apiKey) {
      throw new Error(
        'Audiobook not configured. Please set up your LLM API key in Settings.',
      );
    }

    const config: AudiobookConfig = {
      llm: {
        provider: settings.llmProvider || 'anthropic',
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || undefined,
        model: settings.model || undefined,
      },
      tts: {
        precision: settings.ttsPrecision || 'q8',
        lookaheadSegments: settings.lookaheadSegments ?? 2,
        sampleRate: settings.sampleRate || 24000,
        expressoMainCharacterSlots: settings.expressoMainCharacterSlots ?? 3,
      },
      cacheDir: AUDIOBOOK_STORAGE,
      novelId,
    };

    this.pipeline = new AudiobookPipeline(config);
    this.currentNovelId = novelId;
    return this.pipeline;
  }

  async startChapter(
    chapterText: string,
    chapterId: number,
    novelId: string,
  ): Promise<void> {
    await this.stop();
    this.setState('processing');

    try {
      const pipeline = this.getPipeline(novelId);
      this.tempDir =
        NativeFile.getConstants().ExternalCachesDirectoryPath +
        '/audiobook_temp';
      if (!NativeFile.exists(this.tempDir)) {
        NativeFile.mkdir(this.tempDir);
      }

      // Annotate the chapter
      const annotation: ChapterAnnotation = await pipeline.annotateChapter(
        chapterId,
        chapterText,
      );

      if (this.state !== 'processing') {
        return; // stopped while processing
      }

      // Collect segments from the async generator
      this.segments = [];
      this.currentIndex = 0;

      const generator = pipeline.streamChapterAudio(annotation);
      // Buffer first segment before starting playback
      const first = await generator.next();
      if (first.done || this.state !== 'processing') {
        if (this.state === 'processing') {
          this.setState('idle');
          this.onFinished?.();
        }
        return;
      }
      this.segments.push(first.value);

      // Start playing immediately, continue buffering in background
      this.setState('playing');
      this.activeGenerator = generator;
      this.bufferingPromise = this.bufferRemaining(generator);
      await this.playSegment(0);
    } catch (error) {
      this.setState('idle');
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async bufferRemaining(
    generator: AsyncGenerator<AudioSegment>,
  ): Promise<void> {
    try {
      for await (const segment of generator) {
        if (this.state === 'idle') {
          break;
        }
        this.segments.push(segment);
        // Notify any playSegment calls waiting for this segment
        const resolver = this.segmentResolvers.shift();
        resolver?.();
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Signal all remaining waiters that no more segments are coming
      for (const resolver of this.segmentResolvers) {
        resolver();
      }
      this.segmentResolvers = [];
    }
  }

  private waitForSegment(): Promise<void> {
    return new Promise(resolve => {
      this.segmentResolvers.push(resolve);
    });
  }

  private async playSegment(index: number): Promise<void> {
    if (index >= this.segments.length) {
      // Check if we're still buffering
      if (this.state === 'playing' || this.state === 'paused') {
        // Wait for the next segment to be buffered
        await this.waitForSegment();
        if (index < this.segments.length) {
          return this.playSegment(index);
        }
        this.setState('idle');
        this.onFinished?.();
      }
      return;
    }

    this.currentIndex = index;
    const segment = this.segments[index];
    this.onSegmentChange?.(
      index,
      this.segments.length,
      segment.speaker,
      segment.text || '',
    );

    // Handle pause before segment
    if (segment.pauseBeforeMs > 0) {
      await new Promise(resolve =>
        setTimeout(resolve, segment.pauseBeforeMs),
      );
      if (this.state !== 'playing') {
        return;
      }
    }

    try {
      // Clean up previous sound
      if (this.sound) {
        await this.sound.unloadAsync();
        this.sound = null;
      }

      // Write base64 WAV to temp file
      const tempPath = `${this.tempDir}/segment_${index}.wav`;
      NativeFile.writeFile(tempPath, segment.audioData, 'base64');

      // Load and play
      const { sound } = await Audio.Sound.createAsync(
        { uri: `file://${tempPath}` },
        { shouldPlay: this.state === 'playing' },
      );
      this.sound = sound;

      // Set up completion callback
      sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) {
          // Clean up temp file
          if (NativeFile.exists(tempPath)) {
            NativeFile.unlink(tempPath);
          }
          if (this.state === 'playing') {
            this.playSegment(index + 1);
          }
        }
      });
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async pause(): Promise<void> {
    if (this.state === 'playing') {
      this.setState('paused');
      if (this.sound) {
        await this.sound.pauseAsync();
      }
    }
  }

  async resume(): Promise<void> {
    if (this.state === 'paused') {
      this.setState('playing');
      if (this.sound) {
        await this.sound.playAsync();
      } else {
        // Resume from current segment
        await this.playSegment(this.currentIndex);
      }
    }
  }

  async stop(): Promise<void> {
    const wasActive = this.state !== 'idle';
    this.setState('idle');

    // Close the async generator so it stops producing segments
    if (this.activeGenerator) {
      try {
        await this.activeGenerator.return(undefined as never);
      } catch {
        // Ignore errors during generator cleanup
      }
      this.activeGenerator = null;
    }

    // Resolve any pending segment waiters
    for (const resolver of this.segmentResolvers) {
      resolver();
    }
    this.segmentResolvers = [];

    if (this.sound) {
      try {
        await this.sound.stopAsync();
        await this.sound.unloadAsync();
      } catch {
        // Ignore errors during cleanup
      }
      this.sound = null;
    }

    // Wait for buffering to complete before cleaning up temp files
    if (this.bufferingPromise) {
      try {
        await this.bufferingPromise;
      } catch {
        // Ignore errors
      }
      this.bufferingPromise = null;
    }

    this.segments = [];
    this.currentIndex = 0;

    // Clean up temp files after buffering has stopped
    if (wasActive && this.tempDir && NativeFile.exists(this.tempDir)) {
      try {
        NativeFile.unlink(this.tempDir);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async seekTo(index: number): Promise<void> {
    if (this.state === 'idle' || index < 0 || index >= this.segments.length) {
      return;
    }
    if (this.sound) {
      await this.sound.stopAsync();
      await this.sound.unloadAsync();
      this.sound = null;
    }
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) {
      await this.playSegment(index);
    } else {
      this.currentIndex = index;
      this.onSegmentChange?.(
        index,
        this.segments.length,
        this.segments[index].speaker,
        this.segments[index].text || '',
      );
    }
  }
}
