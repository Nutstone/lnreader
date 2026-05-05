/**
 * Curated voice catalog for the Pocket TTS audiobook engine.
 *
 * Two pools, in priority order for assignment:
 *
 * 1. EMOTIONAL_SPEAKERS — speakers with multiple emotional variants
 *    for the same identity. Used for the narrator and main characters
 *    so they can express emotion across the book. Sourced from:
 *      - Expresso (4 speakers, CC-BY-NC) via kyutai/tts-voices
 *      - voice-zero/voices-emotion (LibriVox-derived, public domain
 *        with Chatterbox-synthesized emotional variants)
 *
 * 2. DONATION_VOICES — single-emotion voices from the Unmute Voice
 *    Donation Project, fully CC0. Used for side / one-off characters.
 *
 * Stable IDs: every entry is identified by a stable string used in
 * the persisted voice map. Reordering or removing entries is a
 * breaking change for cached voice maps — bump
 * VOICE_BANK_SCHEMA_VERSION if you do that.
 */

import type {
  DonationVoice,
  Emotion,
  EmotionalSpeaker,
  VoiceClip,
} from './types';

export const VOICE_BANK_SCHEMA_VERSION = 2;

// ── Source URLs ─────────────────────────────────────────────────

const VOICE_ZERO_BASE =
  'https://raw.githubusercontent.com/OwenTyme/voice-zero/main/voices-emotion';

// ── Expresso speakers (kyutai/tts-voices) ───────────────────────

const expressoClip = (relPath: string): VoiceClip => ({
  path: `expresso/${relPath}`,
});

/**
 * Expresso style names available: default, confused, enunciated,
 * happy, laughing, sad, whisper. We map our Emotion enum onto the
 * closest available style; missing ones fall back to `default`.
 */
const buildExpressoVariants = (
  speakerCode: string,
): EmotionalSpeaker['variants'] => {
  const make = (style: string) => expressoClip(`${speakerCode}-${style}.wav`);
  return {
    neutral: make('default'),
    happy: make('happy'),
    sad: make('sad'),
    whisper: make('whisper'),
    surprised: make('laughing'),
    angry: make('enunciated'),
    fearful: make('whisper'),
  };
};

// ── voice-zero speakers ─────────────────────────────────────────

const vzClip = (speaker: string, emotion: string): VoiceClip => ({
  path: `${speaker}/${emotion}.flac`,
  baseUrl: VOICE_ZERO_BASE,
});

/**
 * voice-zero/voices-emotion provides 13 emotional flavours per
 * speaker: anger, calm, confused, enthused, excited, frustrated,
 * happy, neutral, sad, shout, surprised, tired, worried.
 *
 * Mapping to our Emotion enum: pick the closest match and fall
 * back to neutral for any gap.
 */
const buildVoiceZeroVariants = (
  speaker: string,
): EmotionalSpeaker['variants'] => {
  const make = (emotion: string) => vzClip(speaker, emotion);
  return {
    neutral: make('neutral'),
    happy: make('happy'),
    sad: make('sad'),
    angry: make('anger'),
    fearful: make('worried'),
    surprised: make('surprised'),
    whisper: make('calm'),
  };
};

const expresso = (
  id: string,
  label: string,
  gender: 'male' | 'female',
  speakerCode: string,
): EmotionalSpeaker => ({
  id,
  label,
  gender,
  source: 'expresso',
  variants: buildExpressoVariants(speakerCode),
});

const voiceZero = (
  speaker: string,
  label: string,
  gender: 'male' | 'female',
): EmotionalSpeaker => ({
  id: `vz_${speaker}`,
  label,
  gender,
  source: 'voice-zero',
  variants: buildVoiceZeroVariants(speaker),
});

/**
 * Curated emotional-speaker pool. Order matters: characters claim
 * slots in the order returned by `rankByImportance` from
 * voiceAssigner, picking gender-matched speakers first. Expresso
 * is listed first because the recordings are real human emotional
 * speech; voice-zero variants are Chatterbox-synthesized so the
 * quality bar is slightly lower.
 */
export const EMOTIONAL_SPEAKERS: EmotionalSpeaker[] = [
  // Expresso (real human emotional recordings).
  expresso('ex01', 'Expresso 01 (warm female)', 'female', 'ex01'),
  expresso('ex02', 'Expresso 02 (steady male)', 'male', 'ex02'),
  expresso('ex03', 'Expresso 03 (narrator male)', 'male', 'ex03'),
  expresso('ex04', 'Expresso 04 (bright female)', 'female', 'ex04'),

  // voice-zero (synthetic emotional variants on LibriVox voices).
  voiceZero('amy_koenig', 'Amy Koenig', 'female'),
  voiceZero('anna_simon', 'Anna Simon', 'female'),
  voiceZero('caprisha_page', 'Caprisha Page', 'female'),
  voiceZero('cori_samuel', 'Cori Samuel', 'female'),
  voiceZero('emily_cripps', 'Emily Cripps', 'female'),
  voiceZero('jodi_krangle', 'Jodi Krangle', 'female'),
  voiceZero('kara_shallenberg', 'Kara Shallenberg', 'female'),
  voiceZero('karen_savage', 'Karen Savage', 'female'),
  voiceZero('kristin_hughes', 'Kristin Hughes', 'female'),
  voiceZero('laurie_anne_walden', 'Laurie Anne Walden', 'female'),
  voiceZero('linda_johnson', 'Linda Johnson', 'female'),
  voiceZero('lizzie_driver', 'Lizzie Driver', 'female'),
  voiceZero('alan_davis_drake', 'Alan Davis Drake', 'male'),
  voiceZero('alec_daitsman', 'Alec Daitsman', 'male'),
  voiceZero('alexander_hatton', 'Alexander Hatton', 'male'),
  voiceZero('ben_tucker', 'Ben Tucker', 'male'),
  voiceZero('bill_boerst', 'Bill Boerst', 'male'),
  voiceZero('david_clark', 'David Clark', 'male'),
  voiceZero('david_wales', 'David Wales', 'male'),
  voiceZero('donald_malone', 'Donald Malone', 'male'),
  voiceZero('graeme_dunlop', 'Graeme Dunlop', 'male'),
  voiceZero('greg_giordano', 'Greg Giordano', 'male'),
  voiceZero('mark_nelson', 'Mark Nelson', 'male'),
  voiceZero('peter_yearsley', 'Peter Yearsley', 'male'),
  voiceZero('phil_chenevert', 'Phil Chenevert', 'male'),
];

/** Default speaker for the narrator. Override via voice map UI. */
export const DEFAULT_NARRATOR_SPEAKER_ID = 'ex03';

// ── Donation voices (CC0 single-emotion fallback) ───────────────

const donation = (
  id: string,
  label: string,
  gender: DonationVoice['gender'],
  filename: string,
): DonationVoice => ({
  id,
  label,
  gender,
  clip: { path: `voice-donations/${filename}` },
});

export const DONATION_VOICES: DonationVoice[] = [
  donation('vd_amelia', 'Amelia', 'female', 'amelia-en.wav'),
  donation('vd_beatrice', 'Beatrice', 'female', 'beatrice-en.wav'),
  donation('vd_clara', 'Clara', 'female', 'clara-en.wav'),
  donation('vd_diana', 'Diana', 'female', 'diana-en.wav'),
  donation('vd_eve', 'Eve', 'female', 'eve-en.wav'),
  donation('vd_freya', 'Freya', 'female', 'freya-en.wav'),
  donation('vd_grace', 'Grace', 'female', 'grace-en.wav'),
  donation('vd_hana', 'Hana', 'female', 'hana-en.wav'),
  donation('vd_iris', 'Iris', 'female', 'iris-en.wav'),
  donation('vd_jade', 'Jade', 'female', 'jade-en.wav'),
  donation('vd_kira', 'Kira', 'female', 'kira-en.wav'),
  donation('vd_lena', 'Lena', 'female', 'lena-en.wav'),
  donation('vd_arthur', 'Arthur', 'male', 'arthur-en.wav'),
  donation('vd_bram', 'Bram', 'male', 'bram-en.wav'),
  donation('vd_caleb', 'Caleb', 'male', 'caleb-en.wav'),
  donation('vd_dorian', 'Dorian', 'male', 'dorian-en.wav'),
  donation('vd_evan', 'Evan', 'male', 'evan-en.wav'),
  donation('vd_finn', 'Finn', 'male', 'finn-en.wav'),
  donation('vd_gareth', 'Gareth', 'male', 'gareth-en.wav'),
  donation('vd_henry', 'Henry', 'male', 'henry-en.wav'),
  donation('vd_ivor', 'Ivor', 'male', 'ivor-en.wav'),
  donation('vd_julian', 'Julian', 'male', 'julian-en.wav'),
  donation('vd_kade', 'Kade', 'male', 'kade-en.wav'),
  donation('vd_leon', 'Leon', 'male', 'leon-en.wav'),
];

// ── Lookup helpers ──────────────────────────────────────────────

export const findEmotionalSpeaker = (
  id: string,
): EmotionalSpeaker | undefined =>
  EMOTIONAL_SPEAKERS.find(s => s.id === id);

export const findDonationVoice = (id: string): DonationVoice | undefined =>
  DONATION_VOICES.find(v => v.id === id);

export const emotionalVariantClip = (
  speaker: EmotionalSpeaker,
  emotion: Emotion,
): VoiceClip => speaker.variants[emotion] ?? speaker.variants.neutral;

export const donationsForGender = (
  gender: 'male' | 'female' | 'neutral',
): DonationVoice[] => {
  if (gender === 'neutral') {
    return DONATION_VOICES;
  }
  return DONATION_VOICES.filter(v => v.gender === gender);
};

/** Total emotional speakers minus one (reserved for narrator). */
export const MAX_MAIN_CHARACTER_EMOTIONAL_SLOTS =
  EMOTIONAL_SPEAKERS.length - 1;
