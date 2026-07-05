import { Audio } from 'expo-av';
import { getMMKVObject, setMMKVObject } from '@utils/mmkv/mmkv';
import {
  AUDIOBOOK_SETTINGS,
  AudiobookSettings,
  isLLMConfigured,
  resolveLLMConfig,
  sanitizeTTSPrecision,
} from '@hooks/persisted/useAudiobookSettings';
import { AudiobookPipeline } from './pipeline';
import { formatSetupProgress } from './setupProgress';
import { AudioSegment, ChapterAnnotation, AudiobookConfig } from './types';

export type AudiobookState = 'idle' | 'processing' | 'playing' | 'paused';

/** Per-novel listening position, persisted for resume. */
export interface AudiobookPosition {
  chapterId: number;
  segmentIndex: number;
  /**
   * Which segmentation the index refers to — fallback (narrator
   * splitter) and full (LLM annotation) segment the same chapter
   * differently, so an index from one is meaningless in the other.
   */
  mode: 'full' | 'fallback';
  /** Segment count of that segmentation; a mismatch (e.g. changed
   * chapter text) invalidates the position. */
  totalSegments: number;
  updatedAt: string;
}

export const AUDIOBOOK_POSITIONS = 'AUDIOBOOK_POSITIONS';

export const getAudiobookPosition = (
  novelId: string,
): AudiobookPosition | undefined =>
  getMMKVObject<Record<string, AudiobookPosition>>(AUDIOBOOK_POSITIONS)?.[
    novelId
  ];

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
  private currentChapterId = 0;
  private currentMode: AudiobookPosition['mode'] = 'full';
  /** Segments skipped at the start when resuming mid-chapter. */
  private indexOffset = 0;
  /** Full segment count of the chapter (before resume slicing). */
  private totalSegments = 0;
  /** Whether the selected LLM provider is usable (set by getPipeline). */
  private llmConfigured = false;
  /** Serialized LLM config the current pipeline was built with. */
  private pipelineLlmKey = '';
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
  /**
   * Fired when playback degrades to narrator-only mode (no API key,
   * or the LLM failed). Playback continues; surface as a toast.
   */
  onFallback?: (message: string) => void;

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

  // ── Resume position ─────────────────────────────────────────

  private savePosition() {
    if (!this.currentNovelId) {
      return;
    }
    const store =
      getMMKVObject<Record<string, AudiobookPosition>>(AUDIOBOOK_POSITIONS) ??
      {};
    store[this.currentNovelId] = {
      chapterId: this.currentChapterId,
      segmentIndex: this.currentIndex + this.indexOffset,
      mode: this.currentMode,
      totalSegments: this.totalSegments,
      updatedAt: new Date().toISOString(),
    };
    setMMKVObject(AUDIOBOOK_POSITIONS, store);
  }

  private clearPosition() {
    if (!this.currentNovelId) {
      return;
    }
    const store =
      getMMKVObject<Record<string, AudiobookPosition>>(AUDIOBOOK_POSITIONS) ??
      {};
    if (store[this.currentNovelId]) {
      delete store[this.currentNovelId];
      setMMKVObject(AUDIOBOOK_POSITIONS, store);
    }
  }

  getState(): AudiobookState {
    return this.state;
  }

  private getPipeline(novelId: string): AudiobookPipeline {
    const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);
    const llm = resolveLLMConfig(settings);
    // No key is no longer fatal — playback degrades to narrator-only
    // mode (synthesis is fully offline).
    this.llmConfigured = isLLMConfigured(llm);

    // Reuse the pipeline only while novel AND LLM config are
    // unchanged — a key added mid-session must reach the annotator.
    const llmKey = JSON.stringify(llm);
    if (
      this.pipeline &&
      this.currentNovelId === novelId &&
      this.pipelineLlmKey === llmKey
    ) {
      return this.pipeline;
    }
    this.pipelineLlmKey = llmKey;

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
    resume?: AudiobookPosition,
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
      this.currentNovelId = novelId;
      this.currentChapterId = chapterId;

      // Annotate the chapter (builds the glossary on first play).
      // Without a usable LLM, prepared chapters still play with the
      // full cast from their cached annotation; unprepared ones
      // degrade to narrator-only. LLM failures degrade the same way
      // instead of blocking playback.
      let annotation: ChapterAnnotation | null = null;
      let fallbackReason: string | null = null;
      if (!this.llmConfigured) {
        annotation = await pipeline.getAnnotation(chapterId);
        if (!annotation) {
          fallbackReason = 'No LLM API key set — narrator voice only.';
        }
      } else {
        try {
          annotation = await pipeline.annotateChapter(
            chapterId,
            chapterText,
            emitStatus,
          );
        } catch (error) {
          if (token !== this.setupToken) {
            return;
          }
          fallbackReason = `Chapter analysis failed — narrator voice only. (${
            error instanceof Error ? error.message : String(error)
          })`;
        }
      }
      const isFallback = annotation === null;
      if (!annotation) {
        annotation = pipeline.buildFallbackAnnotation(chapterId, chapterText);
      }
      if (fallbackReason && token === this.setupToken) {
        this.onFallback?.(fallbackReason);
      }

      if (this.state !== 'processing' || token !== this.setupToken) {
        return; // stopped while processing
      }

      // Resume mid-chapter by slicing off already-heard segments —
      // segments are independent, so skipped ones are never rendered.
      // Only positions from the SAME segmentation apply: fallback and
      // LLM segment boundaries differ, and changed chapter text
      // shifts the count.
      this.currentMode = isFallback ? 'fallback' : 'full';
      this.totalSegments = annotation.segments.length;
      const resumeIndex =
        resume &&
        resume.chapterId === chapterId &&
        resume.mode === this.currentMode &&
        resume.totalSegments === annotation.segments.length &&
        resume.segmentIndex > 0 &&
        resume.segmentIndex < annotation.segments.length
          ? resume.segmentIndex
          : 0;
      this.indexOffset = resumeIndex;
      if (this.indexOffset > 0) {
        annotation = {
          ...annotation,
          segments: annotation.segments.slice(this.indexOffset),
        };
      }

      // Collect segments from the async generator
      this.segments = [];
      this.currentIndex = 0;

      const generator = isFallback
        ? pipeline.streamFallbackAudio(annotation, progress =>
            emitStatus(formatSetupProgress(progress)),
          )
        : pipeline.streamChapterAudio(annotation, progress =>
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
        this.clearPosition();
        this.setState('idle');
        this.onFinished?.();
      }
      return;
    }

    this.currentIndex = index;
    const segment = this.segments[index];
    this.savePosition();
    this.onSegmentChange?.(
      index + this.indexOffset,
      this.totalSegments,
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

  /** `index` is chapter-global; resumed sessions can't seek before
   * their resume point (those segments were never rendered). */
  async seekTo(index: number): Promise<void> {
    const internal = Math.max(0, index - this.indexOffset);
    if (this.state === 'idle' || internal >= this.segments.length) {
      return;
    }
    if (this.sound) {
      await this.sound.stopAsync();
      await this.sound.unloadAsync();
      this.sound = null;
    }
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) {
      await this.playSegment(internal);
    } else {
      this.currentIndex = internal;
      this.onSegmentChange?.(
        internal + this.indexOffset,
        this.totalSegments,
        this.segments[internal].speaker,
        this.segments[internal].text || '',
      );
    }
  }
}
