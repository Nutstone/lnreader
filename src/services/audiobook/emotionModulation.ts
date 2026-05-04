/**
 * Emotion → speed/pitch/volume modulation tables.
 *
 * Applied at the renderer (speed, pitch where supported) and at the
 * audio cache write step (volume gain). Values are hand-tuned starting
 * points; adjust by ear, not by intuition.
 *
 * See docs/audiobook/LANGUAGES_AND_EMOTIONS.md.
 */

import { Emotion, EmotionIntensity, RESERVED_SPEAKERS } from './types';

export interface EmotionModulation {
  /** Speed multiplier; 1.0 = baseline. */
  speedMultiplier: number;
  /** Pitch offset in semitones; 0 = baseline. System-TTS only. */
  pitchOffset: number;
  /** Volume offset in dB; 0 = baseline. */
  volumeOffset: number;
}

const NEUTRAL: EmotionModulation = {
  speedMultiplier: 1.0,
  pitchOffset: 0,
  volumeOffset: 0,
};

/**
 * Per-(emotion × intensity) modulation. Some emotions ignore intensity
 * (whisper, amused, tender, cold) and use the same modulation regardless.
 */
const TABLE: Record<Emotion, Record<EmotionIntensity, EmotionModulation>> = {
  neutral: { 1: NEUTRAL, 2: NEUTRAL, 3: NEUTRAL },

  happy: {
    1: { speedMultiplier: 1.03, pitchOffset: 0.05, volumeOffset: 0 },
    2: { speedMultiplier: 1.07, pitchOffset: 0.1, volumeOffset: 1 },
    3: { speedMultiplier: 1.12, pitchOffset: 0.15, volumeOffset: 2 },
  },
  sad: {
    1: { speedMultiplier: 0.93, pitchOffset: -0.03, volumeOffset: -1 },
    2: { speedMultiplier: 0.85, pitchOffset: -0.08, volumeOffset: -2 },
    3: { speedMultiplier: 0.78, pitchOffset: -0.12, volumeOffset: -3 },
  },
  angry: {
    1: { speedMultiplier: 1.05, pitchOffset: -0.02, volumeOffset: 1 },
    2: { speedMultiplier: 1.12, pitchOffset: -0.05, volumeOffset: 2 },
    3: { speedMultiplier: 1.2, pitchOffset: -0.08, volumeOffset: 3 },
  },
  fearful: {
    1: { speedMultiplier: 1.05, pitchOffset: 0.05, volumeOffset: -1 },
    2: { speedMultiplier: 1.12, pitchOffset: 0.1, volumeOffset: -1 },
    3: { speedMultiplier: 1.2, pitchOffset: 0.18, volumeOffset: 0 },
  },
  surprised: {
    1: { speedMultiplier: 1.08, pitchOffset: 0.1, volumeOffset: 1 },
    2: { speedMultiplier: 1.15, pitchOffset: 0.18, volumeOffset: 2 },
    3: { speedMultiplier: 1.22, pitchOffset: 0.25, volumeOffset: 3 },
  },
  whisper: {
    1: { speedMultiplier: 0.9, pitchOffset: -0.05, volumeOffset: -6 },
    2: { speedMultiplier: 0.9, pitchOffset: -0.05, volumeOffset: -6 },
    3: { speedMultiplier: 0.9, pitchOffset: -0.05, volumeOffset: -6 },
  },
  shouting: {
    1: { speedMultiplier: 1.1, pitchOffset: 0.05, volumeOffset: 3 },
    2: { speedMultiplier: 1.18, pitchOffset: 0.1, volumeOffset: 4 },
    3: { speedMultiplier: 1.25, pitchOffset: 0.15, volumeOffset: 5 },
  },
  amused: {
    1: { speedMultiplier: 1.05, pitchOffset: 0.03, volumeOffset: 0 },
    2: { speedMultiplier: 1.05, pitchOffset: 0.03, volumeOffset: 0 },
    3: { speedMultiplier: 1.05, pitchOffset: 0.03, volumeOffset: 0 },
  },
  tender: {
    1: { speedMultiplier: 0.92, pitchOffset: 0.02, volumeOffset: -1 },
    2: { speedMultiplier: 0.92, pitchOffset: 0.02, volumeOffset: -1 },
    3: { speedMultiplier: 0.92, pitchOffset: 0.02, volumeOffset: -1 },
  },
  cold: {
    1: { speedMultiplier: 0.95, pitchOffset: -0.03, volumeOffset: -1 },
    2: { speedMultiplier: 0.95, pitchOffset: -0.03, volumeOffset: -1 },
    3: { speedMultiplier: 0.95, pitchOffset: -0.03, volumeOffset: -1 },
  },
  distressed: {
    1: { speedMultiplier: 1.1, pitchOffset: 0.1, volumeOffset: -1 },
    2: { speedMultiplier: 1.18, pitchOffset: 0.15, volumeOffset: 0 },
    3: { speedMultiplier: 1.25, pitchOffset: 0.2, volumeOffset: 2 },
  },
};

export function getEmotionModulation(
  emotion: Emotion,
  intensity: EmotionIntensity,
  speaker: string,
): EmotionModulation {
  const capped = capIntensityForReservedSpeakers(intensity, speaker);
  return TABLE[emotion]?.[capped] ?? NEUTRAL;
}

function capIntensityForReservedSpeakers(
  intensity: EmotionIntensity,
  speaker: string,
): EmotionIntensity {
  if (RESERVED_SPEAKERS.includes(speaker.toLowerCase() as never)) {
    return Math.min(intensity, 2) as EmotionIntensity;
  }
  return intensity;
}

export const PAUSE_DURATIONS: Record<'short' | 'medium' | 'long', number> = {
  short: 200,
  medium: 400,
  long: 800,
};

export function pauseTypeToMs(
  pause: 'short' | 'medium' | 'long',
  multiplier: number = 1,
): number {
  return Math.round(PAUSE_DURATIONS[pause] * multiplier);
}
