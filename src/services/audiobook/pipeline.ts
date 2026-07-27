import NativeFile from '@modules/native-file';
import { AUDIOBOOK_CACHE_STORAGE, AUDIOBOOK_STORAGE } from '@utils/Storages';
import {
  AudiobookConfig,
  ChapterInput,
  CharacterGlossary,
  ChapterAnnotation,
  TTSSetupProgress,
  VoiceMap,
  VoiceAssignment,
  AudioSegment,
  PipelineProgress,
} from './types';
import { LLMAnnotator } from './llmAnnotator';
import { VoiceAssigner } from './voiceAssigner';
import { TTSRenderer } from './ttsRenderer';
import { VOICE_BANK_SCHEMA_VERSION } from './voiceBank';

export class AudiobookPipeline {
  private config: AudiobookConfig;
  private annotator: LLMAnnotator;
  private assigner: VoiceAssigner;
  private renderer: TTSRenderer;
  private novelDir: string;

  constructor(config: AudiobookConfig) {
    this.config = config;
    this.annotator = new LLMAnnotator(config.llm);
    this.assigner = new VoiceAssigner({
      mainCharacterEmotionalSlots: config.tts.mainCharacterEmotionalSlots,
    });
    // Re-derivable bytes (model, voices, audio renders) go in the
    // OS cache dir so they don't blow Android Auto Backup's 25 MB
    // cap. Per-novel JSON stays under AUDIOBOOK_STORAGE.
    this.renderer = new TTSRenderer(config.tts, AUDIOBOOK_CACHE_STORAGE);
    this.novelDir = `${AUDIOBOOK_STORAGE}/${config.novelId}`;
  }

  async processNovel(
    chapters: ChapterInput[],
    onProgress?: (p: PipelineProgress) => void,
  ): Promise<void> {
    await this.ensureDir(this.novelDir);
    await this.ensureDir(`${this.novelDir}/annotations`);

    // Step 1: Build or evolve the glossary. Each prepared batch
    // merges its chapters into the cast — characters introduced late
    // in a novel get voices too. Skipped when every chapter in the
    // batch is already annotated (nothing new to learn).
    onProgress?.({
      stage: 'glossary',
      message: 'Building character glossary...',
      progress: 0,
    });

    let glossary = await this.getGlossary();
    const unannotated: ChapterInput[] = [];
    for (const chapter of chapters) {
      if (!(await this.getAnnotation(chapter.id))) {
        unannotated.push(chapter);
      }
    }
    if (!glossary || unannotated.length > 0) {
      glossary = await this.annotator.buildGlossary(
        this.config.novelId,
        (unannotated.length ? unannotated : chapters).map(c => c.text),
        glossary ?? undefined,
      );
      await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
    }

    onProgress?.({
      stage: 'glossary',
      message: `Found ${glossary.characters.length} characters`,
      progress: 0.2,
    });

    // Step 2: Build the voice map, or extend it with newcomers —
    // existing assignments never change (voice stability).
    onProgress?.({
      stage: 'voice-mapping',
      message: 'Assigning character voices...',
      progress: 0.25,
    });

    let voiceMap = await this.getVoiceMap();
    voiceMap = voiceMap
      ? this.assigner.extendVoiceMap(voiceMap, glossary)
      : this.assigner.buildVoiceMap(glossary);
    await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);

    onProgress?.({
      stage: 'voice-mapping',
      message: `Assigned ${Object.keys(voiceMap.mappings).length} voices`,
      progress: 0.3,
    });

    // Step 3: Annotate each chapter. The cache is keyed by database
    // chapter id — the same key the playback path (annotateChapter)
    // uses — so batch-produced annotations are reused by the player
    // and never collide across different chapter selections.
    for (let i = 0; i < chapters.length; i++) {
      const { id: chapterId, text } = chapters[i];
      const cached = await this.getAnnotation(chapterId);
      if (cached) {
        continue;
      }

      onProgress?.({
        stage: 'annotation',
        message: `Annotating chapter ${i + 1}/${chapters.length}...`,
        progress: 0.3 + (0.7 * i) / chapters.length,
      });

      const annotation = await this.annotator.annotateChapter(
        chapterId,
        text,
        glossary,
      );
      await this.writeJSON(
        `${this.novelDir}/annotations/${chapterId}.json`,
        annotation,
      );
    }

    onProgress?.({
      stage: 'annotation',
      message: 'All chapters annotated',
      progress: 1,
    });
  }

  /**
   * Annotates one chapter for playback. Self-bootstrapping: on a
   * novel that was never batch-processed, the character glossary is
   * built from this chapter alone — a three-chapter sample (see
   * processNovel) reads the cast better, but pressing play must work
   * without any prior setup step.
   */
  async annotateChapter(
    chapterId: number,
    chapterText: string,
    onStatus?: (message: string) => void,
  ): Promise<ChapterAnnotation> {
    // Check cache first
    const cached = await this.getAnnotation(chapterId);
    if (cached) {
      return cached;
    }

    let glossary = await this.getGlossary();
    if (!glossary) {
      onStatus?.('Building character glossary…');
      glossary = await this.annotator.buildGlossary(this.config.novelId, [
        chapterText,
      ]);
      await this.ensureDir(this.novelDir);
      await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
    }

    onStatus?.('Annotating chapter…');
    await this.ensureDir(`${this.novelDir}/annotations`);
    const annotation = await this.annotator.annotateChapter(
      chapterId,
      chapterText,
      glossary,
    );
    await this.writeJSON(
      `${this.novelDir}/annotations/${chapterId}.json`,
      annotation,
    );
    return annotation;
  }

  async *streamChapterAudio(
    annotation: ChapterAnnotation,
    onSetupProgress?: (progress: TTSSetupProgress) => void,
  ): AsyncGenerator<AudioSegment> {
    let voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      // First playback for this novel (or the voice bank's schema
      // changed): assign voices from the stored glossary.
      const glossary = await this.getGlossary();
      if (!glossary) {
        throw new Error('No glossary found. Annotate a chapter first.');
      }
      voiceMap = this.assigner.buildVoiceMap(glossary);
      await this.ensureDir(this.novelDir);
      await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
    }

    await this.renderer.initialize(onSetupProgress);
    // Pre-warm voice clips + speaker states for every speaker that
    // appears in this chapter so the first segment of each new
    // character doesn't pay for download + state load mid-stream.
    await this.renderer.prefetchForChapter(
      annotation,
      voiceMap,
      onSetupProgress,
    );
    onSetupProgress?.({ stage: 'synthesis' });
    // The renderer is intentionally NOT disposed here — model load
    // is expensive and mid-novel pause/resume should keep it warm.
    // Call `disposeRenderer()` when switching novels or tearing down.
    yield* this.renderer.streamChapterAudio(annotation, voiceMap);
  }

  /**
   * Narrator-only segments for keyless / LLM-failure playback. Pure
   * text splitting — no LLM, no network. The result is deliberately
   * NOT written to the annotation cache: a later run with a working
   * key must still produce the real multi-voice annotation.
   */
  buildFallbackAnnotation(
    chapterId: number,
    chapterText: string,
  ): ChapterAnnotation {
    return {
      chapterId,
      segments: splitForNarration(chapterText).map((text, index) => ({
        text,
        speaker: 'narrator',
        emotion: 'neutral' as const,
        isDialogue: false,
        pauseBefore: index === 0 ? ('short' as const) : ('medium' as const),
      })),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Streams audio for a fallback annotation. Reuses the persisted
   * voice map when one exists (so the narrator sounds the same as in
   * prepared chapters) but never creates one on disk.
   */
  async *streamFallbackAudio(
    annotation: ChapterAnnotation,
    onSetupProgress?: (progress: TTSSetupProgress) => void,
  ): AsyncGenerator<AudioSegment> {
    let voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      // Persist a narrator-only map so the cast editor can list and
      // tune the narrator (voice, speed) for keyless users. Unlike
      // annotations, this never masks later LLM work — processNovel
      // extends an existing map without touching the narrator.
      voiceMap = this.assigner.buildVoiceMap({
        novelId: this.config.novelId,
        characters: [],
        narratorGender: 'male',
        createdAt: new Date().toISOString(),
      });
      await this.ensureDir(this.novelDir);
      await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
    }

    await this.renderer.initialize(onSetupProgress);
    await this.renderer.prefetchForChapter(
      annotation,
      voiceMap,
      onSetupProgress,
    );
    onSetupProgress?.({ stage: 'synthesis' });
    yield* this.renderer.streamChapterAudio(annotation, voiceMap);
  }

  /**
   * Renders every segment of a prepared chapter into the audio cache
   * — the same cache live playback reads — so playback never waits on
   * the model. Reuses the streaming renderer by draining it. Returns
   * false when the chapter has no annotation yet.
   */
  async renderChapterAudio(
    chapterId: number,
    onProgress?: (done: number, total: number) => void,
    onSetupProgress?: (progress: TTSSetupProgress) => void,
  ): Promise<boolean> {
    const annotation = await this.getAnnotation(chapterId);
    if (!annotation) {
      return false;
    }
    const total = annotation.segments.length;
    let done = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _segment of this.streamChapterAudio(
      annotation,
      onSetupProgress,
    )) {
      done++;
      onProgress?.(done, total);
    }
    return true;
  }

  /** Release the on-device TTS model. Call when switching novels. */
  async disposeRenderer(): Promise<void> {
    await this.renderer.dispose();
  }

  async overrideVoice(
    characterName: string,
    assignment: VoiceAssignment,
  ): Promise<void> {
    let voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      throw new Error('No voice map found. Run processNovel() first.');
    }

    voiceMap = this.assigner.overrideVoice(voiceMap, characterName, assignment);
    await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
  }

  // ── Cache Management ────────────────────────────────────────

  async getGlossary(): Promise<CharacterGlossary | null> {
    return this.readJSON<CharacterGlossary>(`${this.novelDir}/glossary.json`);
  }

  async getVoiceMap(): Promise<VoiceMap | null> {
    const map = await this.readJSON<VoiceMap>(
      `${this.novelDir}/voice-map.json`,
    );
    if (!map) {
      return null;
    }
    if (map.schemaVersion !== VOICE_BANK_SCHEMA_VERSION) {
      // Cached voice map predates the current voice bank — discard
      // so the pipeline rebuilds it with the new assignments.
      return null;
    }
    return map;
  }

  async getAnnotation(chapterId: number): Promise<ChapterAnnotation | null> {
    return this.readJSON<ChapterAnnotation>(
      `${this.novelDir}/annotations/${chapterId}.json`,
    );
  }

  async clearCache(): Promise<void> {
    if (await NativeFile.exists(this.novelDir)) {
      await NativeFile.unlink(this.novelDir);
    }
  }

  // ── File Helpers ────────────────────────────────────────────

  private async ensureDir(path: string): Promise<void> {
    if (!(await NativeFile.exists(path))) {
      await NativeFile.mkdir(path);
    }
  }

  private async writeJSON(path: string, data: unknown): Promise<void> {
    try {
      await NativeFile.writeFile(path, JSON.stringify(data, null, 2));
    } catch (error) {
      throw new Error(
        `Failed to write cache file ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  static readonly FALLBACK_SEGMENT_CHARS = 240;

  private async readJSON<T>(path: string): Promise<T | null> {
    try {
      if (!(await NativeFile.exists(path))) {
        return null;
      }
      const content = await NativeFile.readFile(path);
      return JSON.parse(content) as T;
    } catch {
      // Corrupt cache file — delete it and return null so it gets regenerated
      await NativeFile.unlink(path).catch(() => {
        // Ignore cleanup errors
      });
      return null;
    }
  }
}

// ── Fallback narration splitting ────────────────────────────────

/**
 * Splits chapter text into narrator-sized segments (~240 chars) at
 * sentence boundaries (Latin and CJK terminators), paragraph-aware.
 * Sentences longer than the budget are hard-split — preferably at
 * whitespace — because the TTS engine's own chunker also relies on
 * punctuation and would otherwise receive an unboundedly long input.
 * No lookbehind — Hermes' regex support varies across RN versions.
 */
const SENTENCE_SPLIT =
  /[^.!?…。！？]+[.!?…。！？]+["”'’」』]?\s*|[^.!?…。！？]+$/g;

const hardSplit = (sentence: string, budget: number): string[] => {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    const cut = window.lastIndexOf(' ');
    // CJK has no spaces — fall back to a clean slice at the budget.
    const at = cut > budget / 2 ? cut : budget;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) {
    pieces.push(rest);
  }
  return pieces;
};

export const splitForNarration = (text: string): string[] => {
  const budget = AudiobookPipeline.FALLBACK_SEGMENT_CHARS;
  const segments: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      continue;
    }
    const sentences = (trimmed.match(SENTENCE_SPLIT) ?? [trimmed]).flatMap(
      sentence =>
        sentence.length > budget ? hardSplit(sentence, budget) : [sentence],
    );
    let current = '';
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > budget) {
        segments.push(current.trim());
        current = '';
      }
      current += sentence.endsWith(' ') ? sentence : sentence + ' ';
    }
    if (current.trim()) {
      segments.push(current.trim());
    }
  }
  return segments;
};
