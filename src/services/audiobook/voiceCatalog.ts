/**
 * Kokoro voice catalog (v1.0 ONNX, English-only).
 *
 * Each entry is one of the 28 base voices the model ships with. The
 * blender combines these by weighted average — character voices are
 * built by picking 2–4 of these and assigning weights.
 *
 * Tagging archetypes per voice lets the caster prefer well-suited
 * voices when matching a character to an archetype.
 */

import { VoiceArchetype } from './types';

export interface VoiceCatalogEntry {
  voiceId: string;
  gender: 'male' | 'female';
  /** Archetypes this voice fits well; the caster prefers these. */
  archetypes: VoiceArchetype[];
  /** Display name for UI; defaults to voiceId. */
  displayName?: string;
  /** Short, single-line description of the timbre. */
  timbre: string;
}

export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  // American Female
  { voiceId: 'af_alloy', gender: 'female', archetypes: ['noble', 'mentor'], timbre: 'clear, professional' },
  { voiceId: 'af_aoede', gender: 'female', archetypes: ['gentle', 'child'], timbre: 'soft, warm' },
  { voiceId: 'af_bella', gender: 'female', archetypes: ['warrior', 'trickster'], timbre: 'bright, energetic' },
  { voiceId: 'af_heart', gender: 'female', archetypes: ['gentle', 'child'], timbre: 'tender, youthful' },
  { voiceId: 'af_jessica', gender: 'female', archetypes: ['narrator', 'noble'], timbre: 'measured, confident' },
  { voiceId: 'af_kore', gender: 'female', archetypes: ['villain', 'noble'], timbre: 'cool, controlled' },
  { voiceId: 'af_nicole', gender: 'female', archetypes: ['villain', 'mentor'], timbre: 'silken, deliberate' },
  { voiceId: 'af_nova', gender: 'female', archetypes: ['trickster', 'child'], timbre: 'cheerful, light' },
  { voiceId: 'af_river', gender: 'female', archetypes: ['narrator', 'gentle'], timbre: 'flowing, calm' },
  { voiceId: 'af_sarah', gender: 'female', archetypes: ['mentor', 'noble'], timbre: 'wise, patient' },
  { voiceId: 'af_sky', gender: 'female', archetypes: ['child', 'gentle'], timbre: 'airy, innocent' },

  // American Male
  { voiceId: 'am_adam', gender: 'male', archetypes: ['warrior', 'trickster'], timbre: 'spirited, modern' },
  { voiceId: 'am_echo', gender: 'male', archetypes: ['trickster', 'child'], timbre: 'youthful, playful' },
  { voiceId: 'am_eric', gender: 'male', archetypes: ['warrior'], timbre: 'firm, decisive' },
  { voiceId: 'am_fenrir', gender: 'male', archetypes: ['warrior', 'villain'], timbre: 'gravelly, intense' },
  { voiceId: 'am_liam', gender: 'male', archetypes: ['gentle', 'noble'], timbre: 'warm, approachable' },
  { voiceId: 'am_michael', gender: 'male', archetypes: ['narrator', 'mentor'], timbre: 'narrator-classic' },
  { voiceId: 'am_onyx', gender: 'male', archetypes: ['villain', 'warrior'], timbre: 'deep, ominous' },
  { voiceId: 'am_puck', gender: 'male', archetypes: ['trickster'], timbre: 'sly, mercurial' },
  { voiceId: 'am_santa', gender: 'male', archetypes: ['elder', 'mentor'], timbre: 'jolly, weathered' },

  // British Female
  { voiceId: 'bf_alice', gender: 'female', archetypes: ['noble', 'narrator'], timbre: 'crisp, refined' },
  { voiceId: 'bf_emma', gender: 'female', archetypes: ['mentor', 'elder'], timbre: 'maternal, calm' },
  { voiceId: 'bf_isabella', gender: 'female', archetypes: ['villain', 'noble'], timbre: 'imperious, smooth' },
  { voiceId: 'bf_lily', gender: 'female', archetypes: ['gentle', 'mentor'], timbre: 'tender, RP' },

  // British Male
  { voiceId: 'bm_daniel', gender: 'male', archetypes: ['noble', 'villain'], timbre: 'aristocratic, measured' },
  { voiceId: 'bm_fable', gender: 'male', archetypes: ['mentor', 'narrator'], timbre: 'storyteller gravitas' },
  { voiceId: 'bm_george', gender: 'male', archetypes: ['mentor', 'noble'], timbre: 'distinguished, deep' },
  { voiceId: 'bm_lewis', gender: 'male', archetypes: ['villain', 'noble'], timbre: 'cool, sardonic' },
];

export function findVoice(voiceId: string): VoiceCatalogEntry | undefined {
  return VOICE_CATALOG.find(v => v.voiceId === voiceId);
}

export function voicesForGender(
  gender: 'male' | 'female',
): VoiceCatalogEntry[] {
  return VOICE_CATALOG.filter(v => v.gender === gender);
}

export function voicesForArchetype(
  archetype: VoiceArchetype,
  gender: 'male' | 'female',
): VoiceCatalogEntry[] {
  return VOICE_CATALOG.filter(
    v => v.gender === gender && v.archetypes.includes(archetype),
  );
}
