/**
 * Audiobook pipeline orchestrator.
 *
 * Per novel, owns the glossary, voice map and per-chapter annotations.
 * Glossary discovery: the LLM looks at a 3-chapter sample to seed the
 * cast; new speakers found mid-novel are added incrementally.
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
  AnnotatedSegment,
  AudioSegment,
  AudiobookConfig,
  CharacterGlossary,
  ChapterAnnotation,
  CostEstimate,
  PipelineProgress,
  RESERVED_SPEAKERS,
  VoiceMap,
} from './types';
import { LLMAnnotator } from './llmAnnotator';
import { VoiceCaster } from './voiceCaster';
import { chapterKeyFor } from './chapterPath';
import { sanitiseChapter } from './chapterSanitiser';
import { AudioCache } from './audioCache';
import { estimateTokens, findPricing, recommendedModelFor } from './pricing';
import { ITTSRenderer, StreamOptions, effectiveSpeed } from './renderers/types';
import { getEmotionModulation } from './emotionModulation';
import { ANNOTATION_SYSTEM_PROMPT } from './prompts/chapterAnnotator';
import { GLOSSARY_SYSTEM_PROMPT } from './prompts/glossaryBuilder';

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

export interface PipelineOnProgress {
  (p: PipelineProgress): void;
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
    this.annotator =
      deps?.annotator ?? new LLMAnnotator(config.llm);
    this.caster = deps?.caster ?? new VoiceCaster();
    this.cache = deps?.cache ?? new AudioCache();
  }

  // ── Public: high-level operations ───────────────────────────────

  /**
   * Process a batch of chapters: ensure glossary, voice map,
   * annotation for each. Re-runs are idempotent due to caching.
   */
  async processChapters(
    chapters: ChapterWithText[],
    onProgress?: PipelineOnProgress,
  ): Promise<void> {
    this.ensureDirs();
    if (chapters.length === 0) return;

    onProgress?.({
      stage: 'glossary',
      message: 'Building character cast…',
      progress: 0,
    });

    let glossary = await this.getGlossary();
    if (!glossary) {
      const sample = chapters.slice(0, 3).map(c => sanitiseChapter(c.rawText));
      glossary = await this.annotator.buildGlossary(this.config.novelId, sample);
      await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
    }

    onProgress?.({
      stage: 'glossary',
      message: `Cast: ${glossary.characters.length} characters.`,
      progress: 0.15,
    });

    onProgress?.({
      stage: 'voice-mapping',
      message: 'Casting voices…',
      progress: 0.18,
    });

    let voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      voiceMap = this.caster.buildVoiceMap(glossary);
      await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
    }

    onProgress?.({
      stage: 'voice-mapping',
      message: `Cast ${Object.keys(voiceMap.mappings).length} voices.`,
      progress: 0.22,
    });

    // Annotate each chapter; discover new speakers as we go.
    let cumulativeIn = 0;
    let cumulativeOut = 0;
    let cumulativeCached = 0;
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const key = chapterKeyFor(chapter.path);
      const cached = await this.getAnnotation(key);
      if (cached) continue;

      onProgress?.({
        stage: 'annotation',
        message: `Annotating chapter ${i + 1}/${chapters.length}…`,
        progress: 0.25 + (0.7 * i) / chapters.length,
        chapterIndex: i,
        chapterTotal: chapters.length,
        tokensIn: cumulativeIn,
        tokensOut: cumulativeOut,
        tokensCached: cumulativeCached,
      });

      const sanitised = sanitiseChapter(chapter.rawText);
      const annotation = await this.annotator.annotateChapter(
        chapter.id,
        chapter.path,
        sanitised,
        glossary,
      );
      await this.writeAnnotation(annotation);
      cumulativeIn += annotation.usage?.inputTokens ?? 0;
      cumulativeOut += annotation.usage?.outputTokens ?? 0;
      cumulativeCached += annotation.usage?.cachedInputTokens ?? 0;

      // Glossary discovery: if many unknown speakers accumulate, extend.
      const newSpeakers = collectUnknownSpeakers(annotation.segments, glossary);
      if (newSpeakers.length >= 3) {
        const excerpts = annotation.segments
          .filter(s => newSpeakers.includes(s.speaker))
          .slice(0, 6)
          .map(s => s.text);
        try {
          const extras = await this.annotator.extendGlossary(
            glossary,
            newSpeakers,
            excerpts,
          );
          if (extras.length > 0) {
            glossary = {
              ...glossary,
              characters: [...glossary.characters, ...extras],
              updatedAt: new Date().toISOString(),
            };
            await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
            voiceMap = this.caster.extendVoiceMap(voiceMap, extras);
            await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
          }
        } catch {
          // best-effort; new speakers fall back to narrator voice
        }
      }
    }

    onProgress?.({
      stage: 'done',
      message: `All ${chapters.length} chapters annotated.`,
      progress: 1,
      tokensIn: cumulativeIn,
      tokensOut: cumulativeOut,
      tokensCached: cumulativeCached,
    });
  }

  /**
   * Annotate a single chapter on demand (used by the player when the
   * user taps "Listen" on a chapter that's not been processed yet).
   */
  async annotateOne(chapter: ChapterWithText): Promise<ChapterAnnotation> {
    this.ensureDirs();
    const key = chapterKeyFor(chapter.path);
    const cached = await this.getAnnotation(key);
    if (cached) return cached;

    const glossary = await this.getOrBuildGlossary([chapter]);
    const sanitised = sanitiseChapter(chapter.rawText);
    const annotation = await this.annotator.annotateChapter(
      chapter.id,
      chapter.path,
      sanitised,
      glossary,
    );
    await this.writeAnnotation(annotation);
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
      voiceMap,
      manifest,
    );

    // Build a per-index in-flight map. For reusable indexes we resolve
    // immediately. For non-reusable we spawn a render promise. We pre-
    // spawn `lookahead` ahead of the cursor so the renderer is busy.
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
              voiceVersion: voice.voiceVersion,
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
    // Prime lookahead.
    for (let k = 0; k < Math.min(lookahead, total); k++) {
      renders.set(k, buildRender(k));
    }

    for (let i = 0; i < total; i++) {
      const promise = renders.get(i)!;
      const audioSeg = await promise;
      renders.delete(i);
      // Spawn the next one to keep the pipeline busy.
      const next = i + lookahead;
      if (next < total && !renders.has(next)) {
        renders.set(next, buildRender(next));
      }
      yield audioSeg;
    }
  }

  // ── Cost estimation ─────────────────────────────────────────────

  /**
   * Estimate cost for a batch of chapters. Returns one of:
   *   - { isFree: true, ... } for Ollama
   *   - { ... } with USD costs for Anthropic
   */
  async estimateCost(chapters: ChapterWithText[]): Promise<CostEstimate> {
    const provider = this.config.llm.provider;
    const model =
      this.config.llm.model ?? recommendedModelFor(provider).model;
    const pricing = findPricing(provider, model);
    const SYSTEM_TOKENS_GLOSSARY = estimateTokens(GLOSSARY_SYSTEM_PROMPT);
    const SYSTEM_TOKENS_ANNOT = estimateTokens(ANNOTATION_SYSTEM_PROMPT);
    const OUTPUT_TOKENS_PER_CHAPTER = 800; // typical
    const sample = chapters.slice(0, 3);
    const sampleTokens = sample.reduce(
      (s, c) => s + estimateTokens(sanitiseChapter(c.rawText).slice(0, 8000)),
      0,
    );
    const perChapterIn = chapters.reduce(
      (s, c) =>
        s + estimateTokens(sanitiseChapter(c.rawText)) + SYSTEM_TOKENS_ANNOT,
      0,
    );
    const cachedTokens = chapters.length * SYSTEM_TOKENS_ANNOT; // saved by cache after first chapter
    const totalIn = perChapterIn + sampleTokens + SYSTEM_TOKENS_GLOSSARY;
    const totalOut =
      chapters.length * OUTPUT_TOKENS_PER_CHAPTER + 600; // glossary output
    if (!pricing || (pricing.inputPerM === 0 && pricing.outputPerM === 0)) {
      return {
        provider,
        model,
        totalTokensIn: totalIn,
        totalTokensOut: totalOut,
        costUSDWithoutCache: 0,
        costUSDWithCache: 0,
        isFree: true,
        notes: 'Local provider; cost is electricity only.',
      };
    }
    const costNoCache =
      (totalIn / 1_000_000) * pricing.inputPerM +
      (totalOut / 1_000_000) * pricing.outputPerM;
    const costCached =
      ((totalIn - cachedTokens) / 1_000_000) * pricing.inputPerM +
      (cachedTokens / 1_000_000) * pricing.cachedInputPerM +
      (totalOut / 1_000_000) * pricing.outputPerM;
    return {
      provider,
      model,
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
      costUSDWithoutCache: round(costNoCache),
      costUSDWithCache: round(costCached),
      isFree: false,
    };
  }

  // ── Cache & overrides ───────────────────────────────────────────

  async getGlossary(): Promise<CharacterGlossary | null> {
    return this.readJSON<CharacterGlossary>(`${this.novelDir}/glossary.json`);
  }

  async setGlossary(glossary: CharacterGlossary): Promise<void> {
    this.ensureDirs();
    await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
  }

  async getVoiceMap(): Promise<VoiceMap | null> {
    return this.readJSON<VoiceMap>(`${this.novelDir}/voice-map.json`);
  }

  async setVoiceMap(voiceMap: VoiceMap): Promise<void> {
    this.ensureDirs();
    await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
  }

  async getAnnotation(chapterKey: string): Promise<ChapterAnnotation | null> {
    return this.readJSON<ChapterAnnotation>(
      `${this.annotationsDir}/${chapterKey}.json`,
    );
  }

  async getAnnotationByPath(path: string): Promise<ChapterAnnotation | null> {
    return this.getAnnotation(chapterKeyFor(path));
  }

  async writeAnnotation(annotation: ChapterAnnotation): Promise<void> {
    this.ensureDirs();
    await this.writeJSON(
      `${this.annotationsDir}/${annotation.chapterKey}.json`,
      annotation,
    );
  }

  /**
   * Fully rebuild the glossary from a 3-chapter sample. Voice map is
   * rebuilt too. Existing annotations stay valid (speaker names don't
   * change unless the user merges characters).
   */
  async rebuildGlossary(sample: ChapterWithText[]): Promise<CharacterGlossary> {
    this.ensureDirs();
    const sampleText = sample.slice(0, 3).map(c => sanitiseChapter(c.rawText));
    const glossary = await this.annotator.buildGlossary(
      this.config.novelId,
      sampleText,
    );
    await this.setGlossary(glossary);
    const voiceMap = this.caster.buildVoiceMap(glossary);
    await this.setVoiceMap(voiceMap);
    return glossary;
  }

  async clearCache(): Promise<void> {
    if (NativeFile.exists(this.novelDir)) {
      NativeFile.unlink(this.novelDir);
    }
  }

  audioCache(): AudioCache {
    return this.cache;
  }

  // ── Internals ───────────────────────────────────────────────────

  private async getOrBuildGlossary(
    chapters: ChapterWithText[],
  ): Promise<CharacterGlossary> {
    const existing = await this.getGlossary();
    if (existing) return existing;
    const sample = chapters.slice(0, 3).map(c => sanitiseChapter(c.rawText));
    const glossary = await this.annotator.buildGlossary(
      this.config.novelId,
      sample,
    );
    await this.setGlossary(glossary);
    const voiceMap = this.caster.buildVoiceMap(glossary);
    await this.setVoiceMap(voiceMap);
    return glossary;
  }

  private ensureDirs() {
    if (!NativeFile.exists(this.novelDir)) NativeFile.mkdir(this.novelDir);
    if (!NativeFile.exists(this.annotationsDir))
      {NativeFile.mkdir(this.annotationsDir);}
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

function collectUnknownSpeakers(
  segments: AnnotatedSegment[],
  glossary: CharacterGlossary,
): string[] {
  const known = new Set<string>([
    ...RESERVED_SPEAKERS,
    ...glossary.characters.flatMap(c => [
      c.name.toLowerCase(),
      ...c.aliases.map(a => a.toLowerCase()),
    ]),
  ]);
  const unknown = new Set<string>();
  for (const s of segments) {
    if (!known.has(s.speaker.toLowerCase())) unknown.add(s.speaker);
  }
  return [...unknown];
}

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

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
