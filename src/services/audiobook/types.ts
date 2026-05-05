/**
 * Audiobook engine types.
 *
 * One LLM provider (Claude). One TTS engine (Kokoro v1.0 hosted in a
 * hidden WebView).
 */

// ── LLM ─────────────────────────────────────────────────────────

export interface LLMConfig {
  /** Anthropic API key. */
  apiKey?: string;
  /** Override the default model. */
  model?: string;
}

// ── TTS ─────────────────────────────────────────────────────────

export type KokoroDtype = 'q4' | 'q4f16' | 'q8' | 'fp16' | 'fp32';

export interface TTSConfig {
  /** Multiplier on top of per-segment speed. 0.5..2.0. */
  playbackSpeed: number;
  /** When true, applies post-render volume gain on whisper/shouting. */
  emotionShaping: boolean;
  /** Number of segments to pre-render ahead of playback. */
  lookaheadSegments: number;
  /** Kokoro model dtype — quality/speed/size trade-off. */
  dtype: KokoroDtype;
}

// ── Pipeline config ─────────────────────────────────────────────

export interface AudiobookConfig {
  llm: LLMConfig;
  tts: TTSConfig;
  novelId: string;
}

// ── Glossary ────────────────────────────────────────────────────

export interface Character {
  name: string;
  aliases: string[];
  gender: 'male' | 'female' | 'neutral';
  /** Free-form personality keywords; matched against keyword scores. */
  personality: string[];
  /** Audio-descriptor keywords; bias terms for the matcher. */
  voiceHints: string[];
  /** One-sentence summary. */
  description: string;
  /** Optional phonetic override; substituted at render time. */
  pronunciation?: string;
}

export interface CharacterGlossary {
  novelId: string;
  narratorGender: 'male' | 'female' | 'neutral';
  narratorVoiceHints: string[];
  characters: Character[];
  createdAt: string;
  updatedAt: string;
}

// ── Annotation ──────────────────────────────────────────────────

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'surprised'
  | 'whisper'
  | 'shouting'
  | 'amused'
  | 'tender'
  | 'cold'
  | 'distressed';

export type EmotionIntensity = 1 | 2 | 3;

export type PauseDuration = 'short' | 'medium' | 'long';

export interface AnnotatedSegment {
  text: string;
  speaker: string;
  emotion: Emotion;
  intensity: EmotionIntensity;
  isDialogue: boolean;
  pauseBefore: PauseDuration;
}

export interface ChapterAnnotation {
  chapterId: number;
  /** Stable hash of plugin-provided chapter path. */
  chapterKey: string;
  segments: AnnotatedSegment[];
  createdAt: string;
}

// ── Voice Casting (Kokoro blending) ─────────────────────────────

export type VoiceArchetype =
  | 'warrior'
  | 'mentor'
  | 'villain'
  | 'gentle'
  | 'trickster'
  | 'noble'
  | 'child'
  | 'elder'
  | 'narrator'
  | 'system'
  | 'crowd';

export const ARCHETYPES: VoiceArchetype[] = [
  'warrior',
  'mentor',
  'villain',
  'gentle',
  'trickster',
  'noble',
  'child',
  'elder',
  'narrator',
  'system',
  'crowd',
];

export const RESERVED_SPEAKERS = ['narrator', 'system', 'crowd', 'unknown'] as const;
export type ReservedSpeaker = (typeof RESERVED_SPEAKERS)[number];

export type ArchetypeScores = Partial<Record<VoiceArchetype, number>>;

export interface VoiceComponent {
  /** Kokoro voice id (e.g. "af_bella"). */
  voiceId: string;
  /** Weight 0..100; weights in a blend sum to 100. */
  weight: number;
}

export interface BlendedVoice {
  /** Label shown in UI ("Rimuru's voice"). */
  label: string;
  /** 1–4 voice components blended by weighted average. */
  components: VoiceComponent[];
  /** Base playback speed; multiplied with emotion-derived speed at render. */
  speed: number;
}

export interface VoiceMap {
  novelId: string;
  /** Speaker name → BlendedVoice. Includes reserved speakers. */
  mappings: Record<string, BlendedVoice>;
  updatedAt: string;
}

// ── Audio cache ─────────────────────────────────────────────────

export interface AudioSegmentRef {
  index: number;
  file: string;
  durationMs: number;
  pauseBeforeMs: number;
  speaker: string;
  text: string;
  emotion: Emotion;
  intensity: EmotionIntensity;
}

export interface ChapterAudioManifest {
  chapterKey: string;
  chapterId: number;
  totalDurationMs: number;
  totalSegments: number;
  segments: AudioSegmentRef[];
  createdAt: string;
  updatedAt: string;
}

// ── Live audio stream (yielded during render) ───────────────────

export interface AudioSegment {
  index: number;
  pauseBeforeMs: number;
  /** Absolute file path that expo-av can load via file:// URI. */
  filePath: string;
  durationMs: number;
  speaker: string;
  text: string;
  emotion: Emotion;
  intensity: EmotionIntensity;
}

// ── Player ──────────────────────────────────────────────────────

export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'rendering'
  | 'playing'
  | 'paused'
  | 'error';

export interface PlayerError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PlayerState {
  status: PlayerStatus;
  novelId?: string;
  novelName?: string;
  novelCover?: string;
  chapterId?: number;
  chapterKey?: string;
  chapterName?: string;
  totalSegments: number;
  segmentIndex: number;
  positionMs: number;
  totalPositionMs: number;
  totalDurationMs: number;
  speed: number;
  currentSpeaker?: string;
  currentText?: string;
  error?: PlayerError;
}

export const INITIAL_PLAYER_STATE: PlayerState = {
  status: 'idle',
  totalSegments: 0,
  segmentIndex: 0,
  positionMs: 0,
  totalPositionMs: 0,
  totalDurationMs: 0,
  speed: 1.0,
};
