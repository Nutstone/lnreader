/**
 * Audiobook pipeline.
 *
 * Per novel, owns the glossary, voice map, and per-chapter annotations.
 * Glossary is built lazily from a 3-chapter sample on first play; new
 * speakers found mid-novel fall back to the narrator voice (the user
 * can wipe the glossary to rebuild).
 *
 * Layout under AUDIOBOOK_STORAGE/<novelId>/:
 *   glossary.json
 *   voice-map.json
 *   annotations/<chapterKey>.json
 *   audio/<chapterKey>/manifest.json + seg_*.wav
 */

import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_STORAGE } from '@utils/Storages';
import {
  AudioSegment,
  AudiobookConfig,
  CharacterGlossary,
  ChapterAnnotation,
  VoiceMap,
} from './types';
import { LLMAnnotator } from './llmAnnotator';
import { VoiceCaster } from './voiceCaster';
import { chapterKeyFor } from './chapterPath';
import { sanitiseChapter } from './chapterSanitiser';
import { AudioCache } from './audioCache';
import { ITTSRenderer, StreamOptions, effectiveSpeed } from './renderers/types';
import { getEmotionModulation } from './emotionModulation';

export interface ChapterRef {
  /** App's chapter id (for last-played pointer & UI). */
  id: number;
  /** Plugin-stable URL/identifier. */
  path: string;
  /** Optional display name. */
  name?: string;
}

export interface ChapterWithText extends ChapterRef {
  rawText: string;
}

export class AudiobookPipeline {
  private readonly novelDir: string;
  private readonly annotationsDir: string;
  private readonly annotator: LLMAnnotator;
  private readonly caster: VoiceCaster;
  private readonly cache: AudioCache;
  private readonly config: AudiobookConfig;

  constructor(
    config: AudiobookConfig,
    deps?: {
      annotator?: LLMAnnotator;
      caster?: VoiceCaster;
      cache?: AudioCache;
    },
  ) {
    this.config = config;
    this.novelDir = `${AUDIOBOOK_STORAGE}/${config.novelId}`;
    this.annotationsDir = `${this.novelDir}/annotations`;
    this.annotator = deps?.annotator ?? new LLMAnnotator(config.llm);
    this.caster = deps?.caster ?? new VoiceCaster();
    this.cache = deps?.cache ?? new AudioCache();
  }

  /**
   * Annotate a single chapter on demand.
   */
  async annotateOne(chapter: ChapterWithText): Promise<ChapterAnnotation> {
    this.ensureDirs();
    const key = chapterKeyFor(chapter.path);
    const cached = await this.getAnnotation(key);
    if (cached) return cached;

    const glossary = await this.getOrBuildGlossary(chapter);
    const sanitised = sanitiseChapter(chapter.rawText);
    const annotation = await this.annotator.annotateChapter(
      chapter.id,
      chapter.path,
      sanitised,
      glossary,
    );
    await this.writeJSON(
      `${this.annotationsDir}/${annotation.chapterKey}.json`,
      annotation,
    );
    return annotation;
  }

  /**
   * Stream chapter audio. Yields `AudioSegment` objects as they finish.
   * Reuses cached segments where possible; only re-renders deltas.
   */
  async *streamChapterAudio(
    chapter: ChapterRef,
    renderer: ITTSRenderer,
    streamOptions: Omit<StreamOptions, 'outputDir' | 'pronunciationMap'>,
  ): AsyncGenerator<AudioSegment> {
    const annotation = await this.getAnnotationByPath(chapter.path);
    if (!annotation) {
      throw new Error('Annotate the chapter before requesting audio.');
    }
    const voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      throw new Error('No voice map. Build the cast first.');
    }
    const glossary = await this.getGlossary();
    const pronunciationMap: Record<string, string> = {};
    for (const c of glossary?.characters ?? []) {
      if (c.pronunciation && c.pronunciation !== c.name) {
        pronunciationMap[c.name] = c.pronunciation;
      }
    }

    const keys = {
      novelId: this.config.novelId,
      chapterKey: annotation.chapterKey,
      chapterId: chapter.id,
    };
    this.cache.ensureChapterDir(keys);
    const outputDir = `${this.novelDir}/audio/${annotation.chapterKey}`;

    const manifest = this.cache.readManifest(keys);
    const { reusableIndexes } = this.cache.computeInvalidation(
      keys,
      annotation,
      manifest,
    );

    const renders = new Map<number, Promise<AudioSegment>>();

    const buildRender = (idx: number): Promise<AudioSegment> => {
      if (reusableIndexes.has(idx)) {
        const cached = manifest!.segments.find(s => s.index === idx)!;
        return Promise.resolve({
          index: idx,
          pauseBeforeMs: cached.pauseBeforeMs,
          filePath: `${outputDir}/${cached.file}`,
          durationMs: cached.durationMs,
          speaker: cached.speaker,
          text: cached.text,
          emotion: cached.emotion,
          intensity: cached.intensity,
        });
      }
      const seg = annotation.segments[idx];
      const voice =
        voiceMap.mappings[seg.speaker] || voiceMap.mappings.narrator;
      const text = applyPronunciation(seg.text, pronunciationMap);
      const fileName = `seg_${idx.toString().padStart(4, '0')}.wav`;
      const outPath = `${outputDir}/${fileName}`;
      const speed = effectiveSpeed(
        voice.speed,
        seg.emotion,
        seg.intensity,
        (e, i) => getEmotionModulation(e, i, seg.speaker).speedMultiplier,
        streamOptions.playbackSpeedMultiplier,
      );
      const pauseMs = Math.round(
        pauseToMs(seg.pauseBefore) * streamOptions.pauseMultiplier,
      );
      return renderer
        .renderSegment({
          id: `seg_${annotation.chapterKey}_${idx}`,
          text,
          voice,
          speed,
          outputPath: outPath,
        })
        .then(result => {
          this.cache.upsertSegment(
            keys,
            {
              index: idx,
              file: fileName,
              durationMs: result.durationMs,
              pauseBeforeMs: pauseMs,
              speaker: seg.speaker,
              text: seg.text,
              emotion: seg.emotion,
              intensity: seg.intensity,
            },
            annotation.segments.length,
          );
          return {
            index: idx,
            pauseBeforeMs: pauseMs,
            filePath: result.filePath,
            durationMs: result.durationMs,
            speaker: seg.speaker,
            text: seg.text,
            emotion: seg.emotion,
            intensity: seg.intensity,
          } as AudioSegment;
        });
    };

    const total = annotation.segments.length;
    const lookahead = Math.max(1, streamOptions.lookahead);
    for (let k = 0; k < Math.min(lookahead, total); k++) {
      renders.set(k, buildRender(k));
    }
    for (let i = 0; i < total; i++) {
      const promise = renders.get(i)!;
      const audioSeg = await promise;
      renders.delete(i);
      const next = i + lookahead;
      if (next < total && !renders.has(next)) {
        renders.set(next, buildRender(next));
      }
      yield audioSeg;
    }
  }

  // ── Cache & overrides ───────────────────────────────────────────

  async getGlossary(): Promise<CharacterGlossary | null> {
    return this.readJSON<CharacterGlossary>(`${this.novelDir}/glossary.json`);
  }

  async getVoiceMap(): Promise<VoiceMap | null> {
    return this.readJSON<VoiceMap>(`${this.novelDir}/voice-map.json`);
  }

  async getAnnotation(chapterKey: string): Promise<ChapterAnnotation | null> {
    return this.readJSON<ChapterAnnotation>(
      `${this.annotationsDir}/${chapterKey}.json`,
    );
  }

  async getAnnotationByPath(path: string): Promise<ChapterAnnotation | null> {
    return this.getAnnotation(chapterKeyFor(path));
  }

  /**
   * Wipe everything cached for this novel — glossary, voice map,
   * annotations, audio. Forces re-annotation on next play.
   */
  async clearCache(): Promise<void> {
    if (NativeFile.exists(this.novelDir)) {
      NativeFile.unlink(this.novelDir);
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  private async getOrBuildGlossary(
    chapter: ChapterWithText,
  ): Promise<CharacterGlossary> {
    const existing = await this.getGlossary();
    if (existing) return existing;
    const sample = [sanitiseChapter(chapter.rawText)];
    const glossary = await this.annotator.buildGlossary(
      this.config.novelId,
      sample,
    );
    await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
    const voiceMap = this.caster.buildVoiceMap(glossary);
    await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
    return glossary;
  }

  private ensureDirs() {
    if (!NativeFile.exists(this.novelDir)) NativeFile.mkdir(this.novelDir);
    if (!NativeFile.exists(this.annotationsDir)) {
      NativeFile.mkdir(this.annotationsDir);
    }
  }

  private async readJSON<T>(path: string): Promise<T | null> {
    try {
      if (!NativeFile.exists(path)) return null;
      return JSON.parse(NativeFile.readFile(path)) as T;
    } catch {
      try {
        if (NativeFile.exists(path)) NativeFile.unlink(path);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  private async writeJSON(path: string, data: unknown): Promise<void> {
    NativeFile.writeFile(path, JSON.stringify(data, null, 2));
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function pauseToMs(p: 'short' | 'medium' | 'long'): number {
  switch (p) {
    case 'short':
      return 200;
    case 'medium':
      return 400;
    default:
      return 800;
  }
}

function applyPronunciation(
  text: string,
  pronunciationMap: Record<string, string>,
): string {
  let out = text;
  for (const [name, pron] of Object.entries(pronunciationMap)) {
    if (!name || !pron || pron === name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), pron);
  }
  return out;
}
