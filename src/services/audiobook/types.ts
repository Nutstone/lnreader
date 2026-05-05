/**
 * Audiobook Engine Types
 *
 * Multi-voice audiobook engine for light novels using cloud LLM
 * for text analysis and on-device Pocket TTS (Kyutai) with a curated
 * voice bank. Main characters + narrator are locked to Expresso
 * speakers, which provide emotional variants (default/happy/sad/
 * whisper/etc.) for the same speaker identity. One-off characters
 * draw from a CC0 voice-donation bank (single-emotion).
 */

// ── LLM Provider Configuration ──────────────────────────────────

export interface LLMConfig {
  provider: 'anthropic' | 'gemini' | 'ollama';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ── TTS Configuration ───────────────────────────────────────────

/**
 * Model precision for the Pocket TTS ONNX export.
 * - q8: int8 quantized (smallest, fastest, lowest quality)
 * - fp16: half-precision (balanced)
 * - fp32: full precision (largest, highest quality)
 */
export type TTSPrecision = 'q8' | 'fp16' | 'fp32';

export interface TTSConfig {
  precision: TTSPrecision;
  lookaheadSegments: number;
  sampleRate: number;
  /** How many of the top characters get locked to Expresso speakers. */
  expressoMainCharacterSlots: number;
  /** Override base URL for the Pocket TTS model + voice repository. */
  modelRepoUrl?: string;
}

// ── Pipeline Configuration ──────────────────────────────────────

export interface AudiobookConfig {
  llm: LLMConfig;
  tts: TTSConfig;
  cacheDir: string;
  novelId: string;
}

// ── Character Glossary ──────────────────────────────────────────

export interface Character {
  name: string;
  aliases: string[];
  gender: 'male' | 'female' | 'neutral';
  personality: string[];
  description: string;
  /**
   * Importance hint from the LLM. Higher = more central to the
   * story. Used to pick which characters get locked to Expresso
   * speakers (which have full emotional range) vs. drawing from
   * the single-emotion donation bank.
   */
  importance?: number;
}

export interface CharacterGlossary {
  novelId: string;
  characters: Character[];
  narratorGender: 'male' | 'female';
  createdAt: string;
}

// ── Chapter Annotation ──────────────────────────────────────────

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'surprised'
  | 'whisper';

export interface AnnotatedSegment {
  text: string;
  speaker: string;
  emotion: Emotion;
  isDialogue: boolean;
  pauseBefore: 'short' | 'medium' | 'long';
}

export interface ChapterAnnotation {
  chapterId: number;
  segments: AnnotatedSegment[];
  createdAt: string;
}

// ── Voice Bank ──────────────────────────────────────────────────

/**
 * One physical voice clip / embedding in the kyutai/tts-voices
 * repository. Stable across sessions.
 */
export interface VoiceClip {
  /** Path inside the kyutai/tts-voices HF repo (without leading slash). */
  path: string;
  /** Optional pre-computed speaker-state safetensors path. */
  embeddingPath?: string;
}

/**
 * An Expresso speaker has multiple emotional variants for the same
 * voice identity. This is the disentangled timbre/emotion design
 * the audiobook engine relies on.
 */
export interface ExpressoSpeaker {
  /** Stable speaker ID, e.g. "ex01", "ex02". */
  id: string;
  label: string;
  gender: 'male' | 'female';
  /**
   * Map from our Emotion enum to the speaker's clip for that
   * emotion. `neutral` MUST be present; others are optional and
   * fall back to `neutral`.
   */
  variants: Partial<Record<Emotion, VoiceClip>> & { neutral: VoiceClip };
}

/** A single-emotion voice from the CC0 donation pool. */
export interface DonationVoice {
  id: string;
  label: string;
  gender: 'male' | 'female' | 'neutral';
  clip: VoiceClip;
}

// ── Voice Assignment ────────────────────────────────────────────

/**
 * The runtime voice for a character. Either an Expresso lock
 * (with full emotional range) or a fixed donation voice.
 */
export type VoiceAssignment =
  | {
      kind: 'expresso';
      speakerId: string;
      label: string;
    }
  | {
      kind: 'donation';
      voiceId: string;
      label: string;
    };

export interface VoiceMap {
  novelId: string;
  /** Bumped when assignment schema changes; older caches get rebuilt. */
  schemaVersion: number;
  mappings: Record<string, VoiceAssignment>;
  updatedAt: string;
}

// ── Audio Output ────────────────────────────────────────────────

export interface AudioSegment {
  pauseBeforeMs: number;
  audioData: string;
  durationMs: number;
  speaker: string;
  text: string;
}

// ── Progress Callback ───────────────────────────────────────────

export interface PipelineProgress {
  stage: 'glossary' | 'annotation' | 'voice-mapping' | 'rendering';
  message: string;
  progress: number;
}

// ── LLM Message Format ──────────────────────────────────────────

export interface LLMMessage {
  system: string;
  user: string;
}
