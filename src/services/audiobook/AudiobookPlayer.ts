/**
 * AudiobookPlayer — app-scoped singleton player.
 *
 * Owns the playback state machine and the audio session. Subscribers
 * (the reader) get state updates via `subscribe(listener)`.
 */

import { Audio } from 'expo-av';
import {
  showTTSNotification,
  updateTTSNotification,
  updateTTSPlaybackState,
  updateTTSProgress,
  dismissTTSNotification,
} from '@utils/ttsNotification';
import { setChapterAudiobookAvailable } from '@database/queries/ChapterQueries';
import {
  AudioSegment,
  AudiobookConfig,
  ChapterAnnotation,
  INITIAL_PLAYER_STATE,
  PlayerError,
  PlayerState,
} from './types';
import { AudiobookPipeline, ChapterRef } from './pipeline';
import { ITTSRenderer } from './renderers/types';
import { KokoroWebViewRenderer } from './renderers/KokoroWebViewRenderer';
import { sleep } from '@utils/sleep';

export interface NovelMeta {
  id: number | string;
  pluginId: string;
  name: string;
  cover?: string;
}

export type StateListener = (state: PlayerState) => void;

class AudiobookPlayerService {
  private state: PlayerState = { ...INITIAL_PLAYER_STATE };
  private listeners = new Set<StateListener>();
  private sound: Audio.Sound | null = null;
  private renderer: ITTSRenderer | null = null;
  private pipeline: AudiobookPipeline | null = null;
  private currentNovelKey: string | null = null;
  private bufferedSegments: AudioSegment[] = [];
  private currentChapter: ChapterRef | null = null;
  private currentNovel: NovelMeta | null = null;
  private generator: AsyncGenerator<AudioSegment> | null = null;
  private waiters: Array<() => void> = [];
  private rendererBufferingPromise: Promise<void> | null = null;

  // ── Subscription ────────────────────────────────────────────────

  getState(): PlayerState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private setError(error: PlayerError) {
    this.setState({ status: 'error', error });
  }

  // ── Setup ───────────────────────────────────────────────────────

  configure(config: AudiobookConfig, novel: NovelMeta) {
    const novelKey = String(novel.id);
    if (this.pipeline && this.currentNovelKey === novelKey) return;
    this.pipeline = new AudiobookPipeline(config);
    this.currentNovelKey = novelKey;
    this.currentNovel = novel;
  }

  private getRenderer(dtype: AudiobookConfig['tts']['dtype']): ITTSRenderer {
    if (!this.renderer) {
      this.renderer = new KokoroWebViewRenderer(dtype);
    }
    return this.renderer;
  }

  // ── Public controls ─────────────────────────────────────────────

  async playChapter(
    config: AudiobookConfig,
    novel: NovelMeta,
    chapter: ChapterRef,
    chapterText: string,
  ): Promise<void> {
    this.configure(config, novel);
    await this.stop();

    this.currentChapter = chapter;
    this.currentNovel = novel;
    this.setState({
      status: 'loading',
      novelId: String(novel.id),
      novelName: novel.name,
      novelCover: novel.cover,
      chapterId: chapter.id,
      chapterName: chapter.name,
      segmentIndex: 0,
      positionMs: 0,
      totalPositionMs: 0,
      totalDurationMs: 0,
      totalSegments: 0,
      error: undefined,
    });

    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
      });
    } catch {
      /* old expo-av versions tolerate */
    }

    try {
      const pipeline = this.pipeline!;
      const annotation: ChapterAnnotation = await pipeline.annotateOne({
        ...chapter,
        rawText: chapterText,
      });

      // Mark the chapter as audiobook-ready so the chapter list shows
      // the indicator on next render.
      try {
        await setChapterAudiobookAvailable(chapter.id, true);
      } catch {
        /* non-fatal */
      }

      this.setState({
        status: 'rendering',
        totalSegments: annotation.segments.length,
      });

      showTTSNotification({
        novelName: novel.name,
        chapterName: chapter.name ?? `Chapter ${chapter.id}`,
        coverUri: novel.cover ?? '',
        isPlaying: true,
      });

      const renderer = this.getRenderer(config.tts.dtype);
      this.bufferedSegments = [];
      this.generator = pipeline.streamChapterAudio(chapter, renderer, {
        lookahead: config.tts.lookaheadSegments,
        playbackSpeedMultiplier: this.state.speed,
        pauseMultiplier: 1.0,
        emotionShaping: config.tts.emotionShaping,
      });

      this.rendererBufferingPromise = this.consumeGenerator();
      await this.waitForSegment(0);
      await this.startPlaybackFromIndex(0);
    } catch (e) {
      this.setError({
        code: 'play-failed',
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      });
    }
  }

  async pause(): Promise<void> {
    if (this.state.status !== 'playing') return;
    if (this.sound) {
      try {
        await this.sound.pauseAsync();
      } catch {
        /* ignore */
      }
    }
    this.setState({ status: 'paused' });
    updateTTSPlaybackState(false);
  }

  async resume(): Promise<void> {
    if (this.state.status !== 'paused') return;
    if (this.sound) {
      try {
        await this.sound.playAsync();
        this.setState({ status: 'playing' });
        updateTTSPlaybackState(true);
        return;
      } catch {
        /* fall through to restart from current */
      }
    }
    await this.startPlaybackFromIndex(this.state.segmentIndex);
  }

  async stop(): Promise<void> {
    if (this.state.status === 'idle') return;
    this.setState({ status: 'idle' });

    if (this.generator) {
      try {
        await this.generator.return(undefined as never);
      } catch {
        /* ignore */
      }
      this.generator = null;
    }
    for (const w of this.waiters) w();
    this.waiters = [];

    if (this.sound) {
      try {
        await this.sound.stopAsync();
      } catch {
        /* ignore */
      }
      try {
        await this.sound.unloadAsync();
      } catch {
        /* ignore */
      }
      this.sound = null;
    }

    if (this.rendererBufferingPromise) {
      try {
        await this.rendererBufferingPromise;
      } catch {
        /* ignore */
      }
      this.rendererBufferingPromise = null;
    }

    this.bufferedSegments = [];
    dismissTTSNotification();
  }

  async seekToSegment(index: number): Promise<void> {
    if (this.state.status === 'idle') return;
    if (index < 0) return;
    if (index >= this.bufferedSegments.length) {
      await this.waitForSegment(index);
    }
    await this.startPlaybackFromIndex(index);
  }

  async nextSegment(): Promise<void> {
    await this.seekToSegment(this.state.segmentIndex + 1);
  }

  async previousSegment(): Promise<void> {
    await this.seekToSegment(Math.max(0, this.state.segmentIndex - 1));
  }

  setSpeed(speed: number): void {
    const clamped = Math.max(0.5, Math.min(2.0, speed));
    this.setState({ speed: clamped });
    if (this.sound) {
      try {
        this.sound.setRateAsync(clamped, true);
      } catch {
        /* ignore */
      }
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private async consumeGenerator() {
    if (!this.generator) return;
    try {
      for await (const seg of this.generator) {
        this.bufferedSegments.push(seg);
        const total = this.bufferedSegments.reduce(
          (s, x) => s + x.durationMs + x.pauseBeforeMs,
          0,
        );
        this.setState({ totalDurationMs: total });
        const w = this.waiters.shift();
        w?.();
      }
    } catch (e) {
      this.setError({
        code: 'render-failed',
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      });
    } finally {
      for (const w of this.waiters) w();
      this.waiters = [];
    }
  }

  private waitForSegment(index: number): Promise<void> {
    if (index < this.bufferedSegments.length) return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (index < this.bufferedSegments.length) resolve();
        else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  private async startPlaybackFromIndex(index: number) {
    if (this.sound) {
      try {
        await this.sound.unloadAsync();
      } catch {
        /* ignore */
      }
      this.sound = null;
    }
    if (index >= this.bufferedSegments.length) {
      await this.waitForSegment(index);
    }
    if (index >= this.bufferedSegments.length) {
      this.setState({ status: 'idle' });
      return;
    }
    const seg = this.bufferedSegments[index];
    this.setState({
      status: 'playing',
      segmentIndex: index,
      currentSpeaker: seg.speaker,
      currentText: seg.text,
      totalPositionMs: this.bufferedSegments
        .slice(0, index)
        .reduce((s, x) => s + x.durationMs + x.pauseBeforeMs, 0),
      positionMs: 0,
    });

    if (seg.pauseBeforeMs > 0) {
      await sleep(seg.pauseBeforeMs);
      if (this.state.status !== 'playing') return;
    }

    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: 'file://' + seg.filePath },
        { shouldPlay: true, rate: this.state.speed, shouldCorrectPitch: true },
      );
      this.sound = sound;
      this.attachStatusUpdates(sound, index);
      updateTTSNotification({
        novelName: this.currentNovel?.name ?? '',
        chapterName: `${this.currentChapter?.name ?? ''} — ${seg.speaker}`,
        coverUri: this.currentNovel?.cover ?? '',
        isPlaying: true,
      });
      updateTTSPlaybackState(true);
      updateTTSProgress(index, this.state.totalSegments);
    } catch (e) {
      this.setError({
        code: 'audio-load-failed',
        message: e instanceof Error ? e.message : String(e),
        retryable: true,
      });
    }
  }

  private attachStatusUpdates(sound: Audio.Sound, index: number) {
    sound.setOnPlaybackStatusUpdate(status => {
      if (!status.isLoaded) return;
      this.setState({ positionMs: status.positionMillis ?? 0 });
      if (status.didJustFinish && this.state.status === 'playing') {
        this.startPlaybackFromIndex(index + 1);
      }
    });
  }
}

export const audiobookPlayer = new AudiobookPlayerService();
export type { AudiobookPlayerService };
