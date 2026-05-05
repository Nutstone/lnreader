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
export { sanitiseChapter } from './chapterSanitiser';
export { VOICE_CATALOG, voicesForArchetype, findVoice } from './voiceCatalog';
export type { VoiceCatalogEntry } from './voiceCatalog';
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
  PlayerState,
  PlayerStatus,
  PlayerError,
  ReservedSpeaker,
  ArchetypeScores,
} from './types';
export {
  ARCHETYPES,
  RESERVED_SPEAKERS,
  INITIAL_PLAYER_STATE,
} from './types';
