import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_STORAGE } from '@utils/Storages';
import {
  AudiobookConfig,
  CharacterGlossary,
  ChapterAnnotation,
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
    this.renderer = new TTSRenderer(
      config.tts,
      `${AUDIOBOOK_STORAGE}/_tts-cache`,
    );
    this.novelDir = `${AUDIOBOOK_STORAGE}/${config.novelId}`;
  }

  async processNovel(
    chapterTexts: string[],
    onProgress?: (p: PipelineProgress) => void,
  ): Promise<void> {
    await this.ensureDir(this.novelDir);
    await this.ensureDir(`${this.novelDir}/annotations`);

    // Step 1: Build glossary (if not cached)
    onProgress?.({
      stage: 'glossary',
      message: 'Building character glossary...',
      progress: 0,
    });

    let glossary = await this.getGlossary();
    if (!glossary) {
      // Use first 3 chapters (or all if fewer) for glossary
      const sample = chapterTexts.slice(0, 3);
      glossary = await this.annotator.buildGlossary(
        this.config.novelId,
        sample,
      );
      await this.writeJSON(`${this.novelDir}/glossary.json`, glossary);
    }

    onProgress?.({
      stage: 'glossary',
      message: `Found ${glossary.characters.length} characters`,
      progress: 0.2,
    });

    // Step 2: Build voice map (if not cached)
    onProgress?.({
      stage: 'voice-mapping',
      message: 'Assigning character voices...',
      progress: 0.25,
    });

    let voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      voiceMap = this.assigner.buildVoiceMap(glossary);
      await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
    }

    onProgress?.({
      stage: 'voice-mapping',
      message: `Assigned ${Object.keys(voiceMap.mappings).length} voices`,
      progress: 0.3,
    });

    // Step 3: Annotate each chapter
    for (let i = 0; i < chapterTexts.length; i++) {
      const chapterId = i;
      const cached = await this.getAnnotation(chapterId);
      if (cached) {
        continue;
      }

      onProgress?.({
        stage: 'annotation',
        message: `Annotating chapter ${i + 1}/${chapterTexts.length}...`,
        progress: 0.3 + (0.7 * i) / chapterTexts.length,
      });

      const annotation = await this.annotator.annotateChapter(
        chapterId,
        chapterTexts[i],
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

  async annotateChapter(
    chapterId: number,
    chapterText: string,
  ): Promise<ChapterAnnotation> {
    // Check cache first
    const cached = await this.getAnnotation(chapterId);
    if (cached) {
      return cached;
    }

    // Need glossary for annotation
    const glossary = await this.getGlossary();
    if (!glossary) {
      throw new Error(
        'No glossary found. Run processNovel() first or provide chapter texts for glossary building.',
      );
    }

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
  ): AsyncGenerator<AudioSegment> {
    const voiceMap = await this.getVoiceMap();
    if (!voiceMap) {
      throw new Error('No voice map found. Run processNovel() first.');
    }

    await this.renderer.initialize();
    try {
      yield* this.renderer.streamChapterAudio(annotation, voiceMap);
    } finally {
      await this.renderer.dispose();
    }
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
    if (NativeFile.exists(this.novelDir)) {
      NativeFile.unlink(this.novelDir);
    }
  }

  // ── File Helpers ────────────────────────────────────────────

  private async ensureDir(path: string): Promise<void> {
    if (!NativeFile.exists(path)) {
      NativeFile.mkdir(path);
    }
  }

  private async writeJSON(path: string, data: unknown): Promise<void> {
    try {
      NativeFile.writeFile(path, JSON.stringify(data, null, 2));
    } catch (error) {
      throw new Error(
        `Failed to write cache file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readJSON<T>(path: string): Promise<T | null> {
    try {
      if (!NativeFile.exists(path)) {
        return null;
      }
      const content = NativeFile.readFile(path);
      return JSON.parse(content) as T;
    } catch {
      // Corrupt cache file — delete it and return null so it gets regenerated
      try {
        if (NativeFile.exists(path)) {
          NativeFile.unlink(path);
        }
      } catch {
        // Ignore cleanup errors
      }
      return null;
    }
  }
}
