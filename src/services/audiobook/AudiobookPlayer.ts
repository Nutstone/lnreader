import { Audio } from 'expo-av';
import { getMMKVObject } from '@utils/mmkv/mmkv';
import {
  AUDIOBOOK_SETTINGS,
  AudiobookSettings,
  isLLMConfigured,
  resolveLLMConfig,
  sanitizeTTSPrecision,
} from '@hooks/persisted/useAudiobookSettings';
import { AudiobookPipeline } from './pipeline';
import {
  AudioSegment,
  ChapterAnnotation,
  AudiobookConfig,
  TTSSetupProgress,
} from './types';

export type AudiobookState = 'idle' | 'processing' | 'playing' | 'paused';

/**
 * How long the TTS model stays loaded after playback goes idle.
 * Long enough that chapter-to-chapter navigation never reloads,
 * short enough that ~150-450 MB of weights don't sit in RAM for a
 * whole reading session with the audiobook off.
 */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

export class AudiobookPlayer {
  private pipeline: AudiobookPipeline | null = null;
  private segments: AudioSegment[] = [];
  private currentIndex = 0;
  private sound: Audio.Sound | null = null;
  private state: AudiobookState = 'idle';
  private currentNovelId = '';
  private activeGenerator: AsyncGenerator<AudioSegment> | null = null;
  private bufferingPromise: Promise<void> | null = null;
  private segmentResolvers: (() => void)[] = [];
  private idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Identifies the current startChapter run. The multi-minute first
   * segment setup (download → load → prefetch → synthesis) cannot be
   * cancelled mid-await, so stop() instead invalidates the token and
   * the orphaned run's progress/error callbacks are dropped rather
   * than resurrecting banners/notifications the user dismissed.
   */
  private setupToken = 0;

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
  /**
   * Human-readable setup status ('Downloading TTS model… 42%').
   * Fired during 'processing'; an empty string clears the display
   * once playback starts.
   */
  onStatus?: (message: string) => void;

  private setState(newState: AudiobookState) {
    this.state = newState;
    if (newState === 'idle') {
      this.scheduleIdleUnload();
    } else {
      this.cancelIdleUnload();
    }
    this.onStateChange?.(newState);
  }

  /**
   * Release the TTS model after a stretch of idleness. Playback
   * re-initializes transparently on the next start; this just trades
   * a few seconds of model reload for hundreds of MB of RAM.
   */
  private scheduleIdleUnload() {
    this.cancelIdleUnload();
    this.idleUnloadTimer = setTimeout(() => {
      this.idleUnloadTimer = null;
      if (this.state === 'idle') {
        this.pipeline?.disposeRenderer().catch(() => {});
      }
    }, IDLE_UNLOAD_MS);
  }

  private cancelIdleUnload() {
    if (this.idleUnloadTimer) {
      clearTimeout(this.idleUnloadTimer);
      this.idleUnloadTimer = null;
    }
  }

  getState(): AudiobookState {
    return this.state;
  }

  private getPipeline(novelId: string): AudiobookPipeline {
    if (this.pipeline && this.currentNovelId === novelId) {
      return this.pipeline;
    }

    const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);
    const llm = resolveLLMConfig(settings);
    if (!isLLMConfigured(llm)) {
      throw new Error(
        llm.provider === 'ollama'
          ? 'Audiobook not configured. Set the Ollama base URL in Settings.'
          : `Audiobook not configured. Set your ${llm.provider} API key in Settings.`,
      );
    }

    // Switching novels — release the previous model session before
    // allocating a fresh pipeline. Keeps onnx memory bounded.
    if (this.pipeline) {
      this.pipeline.disposeRenderer().catch(() => {});
    }

    const config: AudiobookConfig = {
      llm,
      tts: {
        precision: sanitizeTTSPrecision(settings?.ttsPrecision),
        lookaheadSegments: settings?.lookaheadSegments ?? 4,
        mainCharacterEmotionalSlots:
          settings?.mainCharacterEmotionalSlots ?? 10,
      },
      novelId,
    };

    this.pipeline = new AudiobookPipeline(config);
    this.currentNovelId = novelId;
    return this.pipeline;
  }

  /**
   * Tear down the player completely: stop playback and release the
   * TTS model session. Call when exiting the reader for the novel.
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.cancelIdleUnload();
    if (this.pipeline) {
      await this.pipeline.disposeRenderer();
      this.pipeline = null;
      this.currentNovelId = '';
    }
  }

  async startChapter(
    chapterText: string,
    chapterId: number,
    novelId: string,
  ): Promise<void> {
    await this.stop();
    const token = ++this.setupToken;
    this.setState('processing');
    const emitStatus = (message: string) => {
      if (token === this.setupToken) {
        this.onStatus?.(message);
      }
    };

    try {
      const pipeline = this.getPipeline(novelId);

      // Annotate the chapter
      emitStatus('Annotating chapter…');
      const annotation: ChapterAnnotation = await pipeline.annotateChapter(
        chapterId,
        chapterText,
      );

      if (this.state !== 'processing' || token !== this.setupToken) {
        return; // stopped while processing
      }

      // Collect segments from the async generator
      this.segments = [];
      this.currentIndex = 0;

      const generator = pipeline.streamChapterAudio(annotation, progress =>
        emitStatus(formatSetupProgress(progress)),
      );
      // Buffer first segment before starting playback
      const first = await generator.next();
      if (
        first.done ||
        this.state !== 'processing' ||
        token !== this.setupToken
      ) {
        if (this.state === 'processing' && token === this.setupToken) {
          this.setState('idle');
          this.onFinished?.();
        }
        return;
      }
      this.segments.push(first.value);

      // Start playing immediately, continue buffering in background
      emitStatus('');
      this.setState('playing');
      this.activeGenerator = generator;
      this.bufferingPromise = this.bufferRemaining(generator);
      await this.playSegment(0);
    } catch (error) {
      if (token !== this.setupToken) {
        // Orphaned setup (the user stopped or started something
        // newer) — its failure must not clobber the current run's
        // state or raise an error alert out of nowhere.
        return;
      }
      this.onStatus?.('');
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
        if (this.getState() === 'idle') {
          // stop() ran while we were waiting — it already reset
          // state; firing onFinished here would falsely trigger
          // finished-handling (e.g. auto page advance) after a stop.
          return;
        }
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
      await new Promise(resolve => setTimeout(resolve, segment.pauseBeforeMs));
      if (this.state !== 'playing') {
        return;
      }
    }

    try {
      if (this.sound) {
        await this.sound.unloadAsync();
        this.sound = null;
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri: `file://${segment.audioPath}` },
        { shouldPlay: this.state === 'playing' },
      );
      this.sound = sound;

      sound.setOnPlaybackStatusUpdate(status => {
        if (
          status.isLoaded &&
          status.didJustFinish &&
          this.state === 'playing'
        ) {
          this.playSegment(index + 1);
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
    // Invalidate any in-flight setup — its progress/error callbacks
    // are dropped from here on (the awaits themselves can't be
    // cancelled; see setupToken).
    this.setupToken++;
    this.onStatus?.('');
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

const MEGABYTE = 1024 * 1024;

const formatSetupProgress = (progress: TTSSetupProgress): string => {
  switch (progress.stage) {
    case 'bundle':
      // MB counts, not a percent: progress is per completed file and
      // one model file dominates the bundle, so a percent would sit
      // frozen for most of the download and read as a hang.
      return `Downloading TTS model… ${Math.round(
        progress.doneBytes / MEGABYTE,
      )} / ${Math.round(progress.totalBytes / MEGABYTE)} MB`;
    case 'model-load':
      return 'Loading TTS model…';
    case 'voices':
      return progress.total > 0
        ? `Preparing voices… ${progress.done}/${progress.total}`
        : 'Preparing voices…';
    case 'synthesis':
      return 'Generating audio…';
  }
};
