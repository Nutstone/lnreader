/**
 * Audiobook engine — public API.
 */

export { AudiobookPipeline } from './pipeline';
export type { ChapterRef, ChapterWithText } from './pipeline';
export {
  audiobookPlayer,
  type AudiobookPlayerService,
  type StateListener,
  type NovelMeta,
} from './AudiobookPlayer';
export { LLMAnnotator } from './llmAnnotator';
export { VoiceCaster, blendString, matchArchetype } from './voiceCaster';
export { AudioCache } from './audioCache';
export { sanitiseChapter, chunkAtSceneBreaks } from './chapterSanitiser';
export { chapterKeyFor, hashChapterPath } from './chapterPath';
export { VOICE_CATALOG, voicesForArchetype, voicesForGender, findVoice } from './voiceCatalog';
export type { VoiceCatalogEntry } from './voiceCatalog';
export { KEYWORD_SCORES, normaliseKeyword } from './voiceArchetypes';
export {
  KokoroWebViewRenderer,
  setKokoroHost,
  getKokoroHost,
  onKokoroDownloadProgress,
} from './renderers/KokoroWebViewRenderer';
export type {
  KokoroHostBridge,
  KokoroHostMessage,
} from './renderers/KokoroWebViewRenderer';
export type {
  ITTSRenderer,
  StreamOptions,
  KokoroDtype,
  RendererCapabilities,
} from './renderers/types';
export {
  PRICING_TABLE,
  findPricing,
  recommendedModelFor,
  listModelsFor,
  estimateTokens,
} from './pricing';
export type { PricingEntry } from './pricing';
export {
  getEmotionModulation,
  pauseTypeToMs,
  PAUSE_DURATIONS,
} from './emotionModulation';
export type { EmotionModulation } from './emotionModulation';
export type {
  AudiobookConfig,
  LLMConfig,
  TTSConfig,
  Character,
  CharacterGlossary,
  Emotion,
  EmotionIntensity,
  PauseDuration,
  AnnotatedSegment,
  ChapterAnnotation,
  VoiceComponent,
  BlendedVoice,
  VoiceArchetype,
  VoiceMap,
  AudioSegment,
  AudioSegmentRef,
  ChapterAudioManifest,
  PipelineProgress,
  PipelineStage,
  CostEstimate,
  PlayerState,
  PlayerStatus,
  PlayerError,
  LastPlayed,
  ReservedSpeaker,
  ArchetypeScores,
} from './types';
export {
  ARCHETYPES,
  RESERVED_SPEAKERS,
  INITIAL_PLAYER_STATE,
} from './types';
