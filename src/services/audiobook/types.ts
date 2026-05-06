/**
 * Audiobook Engine Types
 *
 * Multi-voice audiobook engine for light novels using cloud LLM
 * for text analysis and on-device Pocket TTS (Kyutai) with a curated
 * voice bank. Main characters + narrator are locked to *emotional*
 * speakers (Expresso + voice-zero), which provide emotional variants
 * (neutral/happy/sad/whisper/...) for the same speaker identity.
 * Side characters draw from a CC0 voice-donation bank (single-emotion).
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
  /**
   * How many of the top characters get locked to *emotional* speakers
   * (Expresso + voice-zero), which can express emotion across the
   * book. Beyond this count, characters fall back to single-emotion
   * donation voices.
   */
  mainCharacterEmotionalSlots: number;
}

// ── Pipeline Configuration ──────────────────────────────────────

export interface AudiobookConfig {
  llm: LLMConfig;
  tts: TTSConfig;
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
   * story. Used to pick which characters get locked to emotional
   * speakers (full emotional range) vs. drawing from the
   * single-emotion donation bank.
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
 * One physical voice clip in a remote voice repository. The default
 * base URL is the kyutai/tts-voices Hugging Face repo; clips from
 * other sources (e.g. voice-zero on GitHub) override `baseUrl`.
 */
export interface VoiceClip {
  /** Path under the base URL (without leading slash). */
  path: string;
  /** Optional override for the repository base URL. */
  baseUrl?: string;
}

/**
 * Where the speaker's clips come from. Used for telemetry and
 * licensing display only — the runtime treats both sources
 * identically.
 */
export type EmotionalSpeakerSource = 'expresso' | 'voice-zero';

/**
 * A speaker that exposes multiple emotional variants for the same
 * voice identity. This is the disentangled timbre/emotion design
 * the audiobook engine relies on. Both Expresso (4 speakers, CC-BY-NC)
 * and voice-zero (LibriVox-derived, public domain, with Chatterbox-
 * synthesized emotional variants) populate this pool.
 */
export interface EmotionalSpeaker {
  /** Stable speaker ID, e.g. "ex01" or "vz_kristin_hughes". */
  id: string;
  label: string;
  gender: 'male' | 'female';
  source: EmotionalSpeakerSource;
  /**
   * Map from our Emotion enum to the speaker's clip for that
   * emotion. `neutral` MUST be present; others fall back to it.
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
 * The runtime voice for a character. Either a lock to an emotional
 * speaker (full emotional range) or a fixed donation voice
 * (single emotion).
 */
export type VoiceAssignment =
  | {
      kind: 'emotional';
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
  /**
   * Absolute path to a WAV file on disk. Lives under the renderer's
   * audio cache; `expo-av` plays it directly via `file://` URI.
   */
  audioPath: string;
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
