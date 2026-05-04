/**
 * Audiobook engine types.
 *
 * One LLM provider (Claude) + one optional fallback (Ollama).
 * One TTS engine: Kokoro v1.0 hosted in a hidden WebView.
 *
 * See docs/audiobook/DECISIONS.md.
 */

// ── LLM ─────────────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'ollama';

export type AnthropicModel =
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-7'
  | 'claude-haiku-4-5';

export interface LLMConfig {
  provider: LLMProvider;
  /** Anthropic key, ignored when provider === 'ollama'. */
  apiKey?: string;
  /** Ollama base URL, ignored for Anthropic. */
  baseUrl?: string;
  /** Override the default model for the provider. */
  model?: string;
  /** Default true; disables Anthropic prompt-caching when false. */
  enablePromptCaching?: boolean;
}

// ── TTS ─────────────────────────────────────────────────────────

export interface TTSConfig {
  /**
   * Multiplier applied on top of the per-segment speed. 0.5..2.0.
   * User-controlled in the player.
   */
  playbackSpeed: number;
  /** When true, applies post-render volume gain on whisper/shouting. */
  emotionShaping: boolean;
  /** Number of segments to pre-render ahead of playback. */
  lookaheadSegments: number;
}

// ── Pipeline config ─────────────────────────────────────────────

export interface AudiobookConfig {
  llm: LLMConfig;
  tts: TTSConfig;
  novelId: string;
}

// ── Glossary ────────────────────────────────────────────────────

export interface Character {
  /** Display name. */
  name: string;
  /** Other names referencing the same character. */
  aliases: string[];
  gender: 'male' | 'female' | 'neutral';
  /** Free-form personality keywords; matched against keyword scores. */
  personality: string[];
  /** Audio-descriptor keywords; bias terms for the matcher. */
  voiceHints: string[];
  /** One-sentence summary, shown in glossary editor. */
  description: string;
  /**
   * Phonetic override for pronunciation. Empty = use `name` directly.
   * Used at render time to substitute the spoken form of the name.
   */
  pronunciation?: string;
  /** Chapter index where the character was first seen. */
  firstSeenChapter?: number;
  /** True when the user has manually edited any field. */
  userOverridden?: boolean;
}

export interface CharacterGlossary {
  novelId: string;
  narratorGender: 'male' | 'female' | 'neutral';
  /** How the narrator should sound. */
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
  /** Token usage for cost reporting. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
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
  /** Bumped each time the voice changes; audio cache keys off this. */
  voiceVersion: number;
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
  voiceVersion: number;
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
  /** Epoch ms; undefined = no sleep timer. */
  sleepTimerEndsAt?: number;
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

// ── Last-played pointer (per novel) ─────────────────────────────

export interface LastPlayed {
  novelId: string;
  chapterId: number;
  chapterKey: string;
  segmentIndex: number;
  positionMs: number;
  updatedAt: string;
}

// ── Pipeline progress ───────────────────────────────────────────

export type PipelineStage =
  | 'glossary'
  | 'voice-mapping'
  | 'annotation'
  | 'rendering'
  | 'caching'
  | 'done';

export interface PipelineProgress {
  stage: PipelineStage;
  message: string;
  /** 0..1 */
  progress: number;
  chapterIndex?: number;
  chapterTotal?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
}

// ── Cost estimation ─────────────────────────────────────────────

export interface CostEstimate {
  provider: LLMProvider;
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
  costUSDWithoutCache: number;
  costUSDWithCache: number;
  isFree: boolean;
  notes?: string;
}

// ── LLM internal request ────────────────────────────────────────

export interface LLMRequest {
  /** Cacheable system prompt (Anthropic). */
  systemPrompt: string;
  /** Per-call user message. */
  userMessage: string;
  /** Optional structured-output schema (Anthropic tool_choice). */
  toolName?: string;
  toolDescription?: string;
  toolInputSchema?: Record<string, unknown>;
}

// ── Diagnostics ─────────────────────────────────────────────────

export interface DiagnosticEvent {
  timestamp: number;
  provider: LLMProvider;
  model: string;
  endpoint: string;
  latencyMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUSD: number;
  status: 'ok' | 'retry' | 'error';
  errorMessage?: string;
}
