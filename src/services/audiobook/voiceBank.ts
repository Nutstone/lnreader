/**
 * Curated voice catalog for the Pocket TTS audiobook engine.
 *
 * Sourced from Kyutai's `kyutai/tts-voices` Hugging Face repository
 * (https://huggingface.co/kyutai/tts-voices). Two pools:
 *
 * 1. EXPRESSO_SPEAKERS — four speakers from the Expresso dataset,
 *    each with multiple emotional variants. Used for the narrator
 *    and a small number of main characters so they can express
 *    emotion while keeping a stable speaker identity. License: CC-BY-NC.
 *
 * 2. DONATION_VOICES — one-shot voices from the Unmute Voice
 *    Donation Project, fully CC0. Each voice has a single emotional
 *    flavour. Used for side / one-off characters where consistency
 *    matters more than expressivity.
 *
 * Stable IDs: every entry is identified by a stable string used in
 * the persisted voice map. Reordering this file or removing entries
 * is a breaking change for cached voice maps — bump
 * `VOICE_BANK_SCHEMA_VERSION` if you do that.
 */

import type { DonationVoice, Emotion, ExpressoSpeaker, VoiceClip } from './types';

export const VOICE_BANK_SCHEMA_VERSION = 1;

const expressoClip = (relPath: string): VoiceClip => ({
  path: `expresso/${relPath}`,
});

/**
 * Expresso style names → our Emotion enum. Expresso provides:
 * default, confused, enunciated, happy, laughing, sad, whisper.
 * We map our `angry` and `surprised` and `fearful` onto the
 * closest available expressive variant, falling back to neutral.
 */
const buildExpressoVariants = (
  speakerCode: string,
): ExpressoSpeaker['variants'] => {
  // Convention: kyutai/tts-voices/expresso/<speaker>-<style>.wav
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

export const EXPRESSO_SPEAKERS: ExpressoSpeaker[] = [
  {
    id: 'ex01',
    label: 'Expresso 01 (warm female)',
    gender: 'female',
    variants: buildExpressoVariants('ex01'),
  },
  {
    id: 'ex02',
    label: 'Expresso 02 (steady male)',
    gender: 'male',
    variants: buildExpressoVariants('ex02'),
  },
  {
    id: 'ex03',
    label: 'Expresso 03 (narrator male)',
    gender: 'male',
    variants: buildExpressoVariants('ex03'),
  },
  {
    id: 'ex04',
    label: 'Expresso 04 (bright female)',
    gender: 'female',
    variants: buildExpressoVariants('ex04'),
  },
];

/** Default speaker for the narrator. Override via voice map UI. */
export const DEFAULT_NARRATOR_SPEAKER_ID = 'ex03';

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

/**
 * Curated subset of the 228-voice CC0 donation pool. Picked for
 * timbre variety so that one-off characters don't sound similar.
 * Filenames mirror the kyutai/tts-voices repository structure;
 * adjust if the upstream layout changes.
 */
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

export const findExpressoSpeaker = (
  id: string,
): ExpressoSpeaker | undefined =>
  EXPRESSO_SPEAKERS.find(s => s.id === id);

export const findDonationVoice = (id: string): DonationVoice | undefined =>
  DONATION_VOICES.find(v => v.id === id);

export const expressoVariantClip = (
  speaker: ExpressoSpeaker,
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
