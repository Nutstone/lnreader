/**
 * Renderer interface — abstracts the TTS engine so we can swap
 * implementations (WebView Kokoro now; native Kokoro module later).
 */

import { BlendedVoice, Emotion, EmotionIntensity, KokoroDtype } from '../types';

export type { KokoroDtype } from '../types';

export interface SynthesisRequest {
  /** Stable id used to correlate request/response in async transports. */
  id: string;
  /** Text to speak (after any pronunciation substitutions). */
  text: string;
  voice: BlendedVoice;
  /** Effective speed = voice.speed × emotion modifier × user speed multiplier. */
  speed: number;
  /** Absolute path the renderer should write the audio file to. */
  outputPath: string;
}

export interface SynthesisResult {
  filePath: string;
  durationMs: number;
  sampleRate: number;
}

export interface ITTSRenderer {
  initialize(): Promise<void>;
  isReady(): boolean;
  renderSegment(req: SynthesisRequest): Promise<SynthesisResult>;
  dispose(): Promise<void>;
}

export interface StreamOptions {
  lookahead: number;
  playbackSpeedMultiplier: number;
  pauseMultiplier: number;
  emotionShaping: boolean;
  /** speakerName → spoken-form override. */
  pronunciationMap?: Record<string, string>;
  /** Output dir for rendered audio files. */
  outputDir: string;
}

export interface RendererCapabilities {
  requiresDownload: boolean;
  modelDownloaded: boolean;
  modelSizeBytes?: number;
  dtype?: KokoroDtype;
}

export function effectiveSpeed(
  baseSpeed: number,
  emotion: Emotion,
  intensity: EmotionIntensity,
  emotionToSpeedFn: (e: Emotion, i: EmotionIntensity) => number,
  playbackMultiplier: number,
): number {
  const emoFactor = emotionToSpeedFn(emotion, intensity);
  return clamp(baseSpeed * emoFactor * playbackMultiplier, 0.5, 2.0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
