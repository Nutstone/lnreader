/**
 * Audiobook Engine Types
 *
 * Multi-voice audiobook engine for light novels using cloud LLM
 * for text analysis and on-device Kokoro TTS with voice blending.
 */

// ── LLM Provider Configuration ──────────────────────────────────

export interface LLMConfig {
  provider: 'anthropic' | 'gemini' | 'ollama';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// ── TTS Configuration ───────────────────────────────────────────

export interface TTSConfig {
  dtype: 'q4' | 'q8' | 'fp16';
  lookaheadSegments: number;
  sampleRate: number;
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

// ── Voice Blending ──────────────────────────────────────────────

export interface VoiceComponent {
  voiceId: string;
  weight: number;
}

export interface BlendedVoice {
  label: string;
  components: VoiceComponent[];
  speed: number;
}

export type VoiceArchetype =
  | 'warrior'
  | 'mentor'
  | 'villain'
  | 'gentle'
  | 'trickster'
  | 'noble'
  | 'child'
  | 'elder'
  | 'narrator';

export interface VoiceMap {
  novelId: string;
  mappings: Record<string, BlendedVoice>;
  updatedAt: string;
}

// ── Audio Output ────────────────────────────────────────────────

export interface AudioSegment {
  pauseBeforeMs: number;
  audioData: string;
  durationMs: number;
  speaker: string;
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
