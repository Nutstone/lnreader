/**
 * Audiobook pipeline.
 *
 * Per novel, owns the glossary, voice map, and per-chapter annotations.
 * Glossary is built lazily from a 3-chapter sample on first play; new
 * speakers found mid-novel are added incrementally via extendGlossary.
 *
 * Storage layout (co-located with downloaded chapters under
 * NOVEL_STORAGE/<pluginId>/<novelId>/):
 *   audiobook.glossary.json
 *   audiobook.voice-map.json
 *   <chapterId>/audiobook.json          ← per-chapter annotation
 *
 * Rendered audio lives separately in the OS cache dir (see AudioCache).
 */

import NativeFile from '@specs/NativeFile';
import {
  audiobookAnnotationPath,
  audiobookAudioDir,
  audiobookGlossaryPath,
  audiobookVoiceMapPath,
  chapterDir,
  novelDir,
} from '@utils/Storages';
import {
  AnnotatedSegment,
  AudioSegment,
  AudiobookConfig,
  CharacterGlossary,
  ChapterAnnotation,
  PipelineProgress,
  RESERVED_SPEAKERS,
  VoiceMap,
} from './types';
import { LLMAnnotator } from './llmAnnotator';
import { VoiceCaster } from './voiceCaster';
import { AudioCache } from './audioCache';
import { ITTSRenderer, StreamOptions, effectiveSpeed } from './renderers/types';
import { getEmotionModulation } from './emotionModulation';

export interface ChapterRef {
  /** App's chapter id. */
  id: number;
  /** Plugin-stable URL (used for plugin.parseChapter). */
  path: string;
  /** Optional display name. */
  name?: string;
}

export interface ChapterWithText extends ChapterRef {
  rawText: string;
}

export class AudiobookPipeline {
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
    this.annotator = deps?.annotator ?? new LLMAnnotator(config.llm);
    this.caster = deps?.caster ?? new VoiceCaster();
    this.cache = deps?.cache ?? new AudioCache();
  }

  /**
   * Annotate a single chapter on demand. Builds the glossary if it
   * doesn't exist yet; if the chapter introduces enough new speakers,
   * extends the glossary so they get distinct voices on next play.
   */
  async annotateOne(chapter: ChapterWithText): Promise<ChapterAnnotation> {
    const cached = await this.getAnnotation(chapter.id);
    if (cached) return cached;

    const glossary = await this.getOrBuildGlossary(chapter);
    const annotation = await this.annotator.annotateChapter(
      chapter.id,
      chapter.rawText,
      glossary,
    );
    await this.writeAnnotation(annotation);
    await this.discoverNewSpeakers(annotation, glossary);
    return annotation;
  }

  /**
   * Annotate a batch of chapters. Re-runs are idempotent due to caching;
   * the glossary grows as new speakers are seen. Caller is responsible
   * for setting `chapter.isAvailableAsAudiobook = true` in the DB after
   * each successful annotation (see `processAudiobook`).
   */
  async processChapters(
    chapters: ChapterWithText[],
    onProgress?: (p: PipelineProgress) => void,
    onChapterAnnotated?: (chapterId: number) => void | Promise<void>,
  ): Promise<void> {
    if (chapters.length === 0) return;

    onProgress?.({
      stage: 'glossary',
      message: 'Building character cast…',
      progress: 0,
    });

    let glossary = await this.getGlossary();
    if (!glossary) {
      const sample = chapters.slice(0, 3).map(c => c.rawText);
      glossary = await this.annotator.buildGlossary(
        String(this.config.novelId),
        sample,
      );
      await this.writeGlossary(glossary);
      const voiceMap = this.caster.buildVoiceMap(glossary);
      await this.writeVoiceMap(voiceMap);
    }

    onProgress?.({
      stage: 'glossary',
      message: `Cast: ${glossary.characters.length} characters.`,
      progress: 0.15,
    });

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      let annotation = await this.getAnnotation(chapter.id);
      if (!annotation) {
        onProgress?.({
          stage: 'annotation',
          message: `Annotating chapter ${i + 1}/${chapters.length}…`,
          progress: 0.15 + (0.85 * i) / chapters.length,
          chapterIndex: i,
          chapterTotal: chapters.length,
        });

        annotation = await this.annotator.annotateChapter(
          chapter.id,
          chapter.rawText,
          glossary,
        );
        await this.writeAnnotation(annotation);
        const updated = await this.discoverNewSpeakers(annotation, glossary);
        if (updated) glossary = updated;
      }
      await onChapterAnnotated?.(chapter.id);
    }

    onProgress?.({
      stage: 'done',
      message: `All ${chapters.length} chapters annotated.`,
      progress: 1,
    });
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
    const annotation = await this.getAnnotation(chapter.id);
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
      chapterId: chapter.id,
    };
    this.cache.ensureChapterDir(keys);
    const outputDir = audiobookAudioDir(this.config.novelId, chapter.id);

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
          id: `seg_${chapter.id}_${idx}`,
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

  // ── Persistence helpers ─────────────────────────────────────────

  async getGlossary(): Promise<CharacterGlossary | null> {
    return this.readJSON<CharacterGlossary>(this.glossaryPath());
  }

  async getVoiceMap(): Promise<VoiceMap | null> {
    return this.readJSON<VoiceMap>(this.voiceMapPath());
  }

  async getAnnotation(
    chapterId: number,
  ): Promise<ChapterAnnotation | null> {
    return this.readJSON<ChapterAnnotation>(
      this.annotationPath(chapterId),
    );
  }

  /**
   * Wipe everything cached for this novel — glossary, voice map,
   * annotations, and rendered audio. Caller is responsible for clearing
   * the per-chapter `isAvailableAsAudiobook` DB flags.
   */
  async clearCache(): Promise<void> {
    const dir = novelDir(this.config.pluginId, this.config.novelId);
    // Don't blow away the entire novel dir — it also contains
    // downloaded chapter HTML. Remove only the audiobook artefacts.
    this.tryUnlink(this.glossaryPath());
    this.tryUnlink(this.voiceMapPath());
    if (NativeFile.exists(dir)) {
      try {
        for (const entry of NativeFile.readDir(dir)) {
          if (!entry.isDirectory) continue;
          const annotation = `${entry.path}/audiobook.json`;
          this.tryUnlink(annotation);
        }
      } catch {
        /* ignore */
      }
    }
    this.cache.clearForNovel(this.config.novelId);
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * If the annotation introduces 3+ unknown speakers, ask the LLM to
   * extend the glossary, cast their voices, and persist. Returns the
   * updated glossary or null if no change.
   */
  private async discoverNewSpeakers(
    annotation: ChapterAnnotation,
    glossary: CharacterGlossary,
  ): Promise<CharacterGlossary | null> {
    const newSpeakers = collectUnknownSpeakers(annotation.segments, glossary);
    if (newSpeakers.length < 3) return null;

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
      if (extras.length === 0) return null;

      const updated: CharacterGlossary = {
        ...glossary,
        characters: [...glossary.characters, ...extras],
        updatedAt: new Date().toISOString(),
      };
      await this.writeGlossary(updated);

      const voiceMap = await this.getVoiceMap();
      if (voiceMap) {
        const extended = this.caster.extendVoiceMap(voiceMap, extras);
        await this.writeVoiceMap(extended);
      }
      return updated;
    } catch {
      // best-effort; new speakers fall back to narrator voice
      return null;
    }
  }

  private async getOrBuildGlossary(
    chapter: ChapterWithText,
  ): Promise<CharacterGlossary> {
    const existing = await this.getGlossary();
    if (existing) return existing;
    const glossary = await this.annotator.buildGlossary(
      String(this.config.novelId),
      [chapter.rawText],
    );
    await this.writeGlossary(glossary);
    const voiceMap = this.caster.buildVoiceMap(glossary);
    await this.writeVoiceMap(voiceMap);
    return glossary;
  }

  private glossaryPath(): string {
    return audiobookGlossaryPath(this.config.pluginId, this.config.novelId);
  }

  private voiceMapPath(): string {
    return audiobookVoiceMapPath(this.config.pluginId, this.config.novelId);
  }

  private annotationPath(chapterId: number): string {
    return audiobookAnnotationPath(
      this.config.pluginId,
      this.config.novelId,
      chapterId,
    );
  }

  private async writeAnnotation(annotation: ChapterAnnotation): Promise<void> {
    const dir = chapterDir(
      this.config.pluginId,
      this.config.novelId,
      annotation.chapterId,
    );
    if (!NativeFile.exists(dir)) NativeFile.mkdir(dir);
    NativeFile.writeFile(
      this.annotationPath(annotation.chapterId),
      JSON.stringify(annotation, null, 2),
    );
  }

  private async writeGlossary(glossary: CharacterGlossary): Promise<void> {
    const dir = novelDir(this.config.pluginId, this.config.novelId);
    if (!NativeFile.exists(dir)) NativeFile.mkdir(dir);
    NativeFile.writeFile(this.glossaryPath(), JSON.stringify(glossary, null, 2));
  }

  private async writeVoiceMap(voiceMap: VoiceMap): Promise<void> {
    const dir = novelDir(this.config.pluginId, this.config.novelId);
    if (!NativeFile.exists(dir)) NativeFile.mkdir(dir);
    NativeFile.writeFile(this.voiceMapPath(), JSON.stringify(voiceMap, null, 2));
  }

  private tryUnlink(path: string) {
    try {
      if (NativeFile.exists(path)) NativeFile.unlink(path);
    } catch {
      /* ignore */
    }
  }

  private async readJSON<T>(path: string): Promise<T | null> {
    try {
      if (!NativeFile.exists(path)) return null;
      return JSON.parse(NativeFile.readFile(path)) as T;
    } catch {
      this.tryUnlink(path);
      return null;
    }
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
