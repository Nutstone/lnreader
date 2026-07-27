/**
 * Curated voice catalog for the Pocket TTS audiobook engine.
 *
 * Two pools, in priority order for assignment:
 *
 * 1. EMOTIONAL_SPEAKERS — the four Expresso speakers (CC-BY-NC, real
 *    human emotional recordings in kyutai/tts-voices). Each emotion
 *    maps to a real reference WAV which the on-device mimi encoder
 *    turns into a voice-conditioning state. Used for the narrator and
 *    main characters so they can express emotion across the book.
 *
 * 2. DONATION_VOICES — precomputed single-style prompt states from
 *    the ungated kyutai/pocket-tts-without-voice-cloning repository
 *    (languages/english_2026-04/embeddings/<name>.safetensors, a few
 *    MB each, no on-device encoding required). Used for side / one-off
 *    characters.
 *
 * Every file path below was verified to exist upstream (2026-07).
 * Expresso clip filenames encode the speaker pair and channel:
 * `ex03-ex01_happy_001_channel2_257s.wav` is speaker ex01 (channel 2
 * of the ex03-ex01 pair) in the "happy" style, 257 seconds long. The
 * smallest available file per (speaker, style) was chosen.
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

export const VOICE_BANK_SCHEMA_VERSION = 3;

// ── Expresso speakers (kyutai/tts-voices) ───────────────────────

const expressoClip = (fileName: string): VoiceClip => ({
  path: `expresso/${fileName}`,
});

const expresso = (
  id: string,
  label: string,
  gender: 'male' | 'female',
  variantFiles: Partial<Record<Emotion, string>> & { neutral: string },
): EmotionalSpeaker => {
  const variants = {} as EmotionalSpeaker['variants'];
  for (const [emotion, fileName] of Object.entries(variantFiles)) {
    variants[emotion as Emotion] = expressoClip(fileName);
  }
  return { id, label, gender, source: 'expresso', variants };
};

/**
 * Emotion → Expresso style mapping used below: neutral→default/
 * narration, happy→happy, sad→sad-sympathetic, angry→angry,
 * fearful→fearful (only ex02/ex04 recorded it), surprised→laughing,
 * whisper→whisper. Missing variants fall back to neutral at runtime.
 */
export const EMOTIONAL_SPEAKERS: EmotionalSpeaker[] = [
  expresso('ex01', 'Expresso 01 (warm female)', 'female', {
    neutral: 'ex01-ex02_default_001_channel1_168s.wav',
    happy: 'ex03-ex01_happy_001_channel2_257s.wav',
    sad: 'ex04-ex01_sad-sympathetic_001_channel2_346s.wav',
    angry: 'ex03-ex01_angry_001_channel2_181s.wav',
    surprised: 'ex03-ex01_laughing_002_channel2_232s.wav',
    whisper: 'ex01-ex02_whisper_001_channel1_579s.wav',
  }),
  expresso('ex02', 'Expresso 02 (steady male)', 'male', {
    neutral: 'ex01-ex02_default_001_channel2_198s.wav',
    happy: 'ex04-ex02_happy_001_channel2_140s.wav',
    sad: 'ex03-ex02_sympathetic-sad_008_channel2_268s.wav',
    angry: 'ex04-ex02_angry_001_channel2_150s.wav',
    fearful: 'ex04-ex02_fearful_001_channel2_266s.wav',
    surprised: 'ex04-ex02_laughing_001_channel2_159s.wav',
    whisper: 'ex01-ex02_whisper_001_channel2_717s.wav',
  }),
  expresso('ex03', 'Expresso 03 (narrator male)', 'male', {
    neutral: 'ex04-ex03_default_002_channel2_239s.wav',
    happy: 'ex03-ex01_happy_001_channel1_334s.wav',
    sad: 'ex03-ex02_sympathetic-sad_008_channel1_215s.wav',
    angry: 'ex03-ex01_angry_001_channel1_201s.wav',
    surprised: 'ex03-ex01_laughing_001_channel1_188s.wav',
    whisper: 'ex04-ex03_whisper_002_channel2_266s.wav',
  }),
  expresso('ex04', 'Expresso 04 (bright female)', 'female', {
    neutral: 'ex04-ex01_narration_001_channel1_605s.wav',
    happy: 'ex04-ex02_happy_001_channel1_118s.wav',
    sad: 'ex04-ex01_sad-sympathetic_001_channel1_267s.wav',
    angry: 'ex04-ex02_angry_001_channel1_119s.wav',
    fearful: 'ex04-ex02_fearful_001_channel1_316s.wav',
    surprised: 'ex04-ex02_laughing_001_channel1_147s.wav',
    whisper: 'ex04-ex03_whisper_001_channel1_198s.wav',
  }),
];

/** Default speaker for the narrator. Override via voice map UI. */
export const DEFAULT_NARRATOR_SPEAKER_ID = 'ex03';

// ── Predefined prompt states (single-style fallback pool) ───────

const donation = (
  id: string,
  label: string,
  gender: DonationVoice['gender'],
  embeddingName: string,
): DonationVoice => ({ id, label, gender, embeddingName });

/**
 * All 26 embeddings shipped in the ungated model repo. Gender labels
 * follow the source material (Les Misérables cast names, LibriVox
 * narrators) and common name usage.
 */
export const DONATION_VOICES: DonationVoice[] = [
  donation('pd_alba', 'Alba', 'female', 'alba'),
  donation('pd_anna', 'Anna', 'female', 'anna'),
  donation('pd_azelma', 'Azelma', 'female', 'azelma'),
  donation('pd_cosette', 'Cosette', 'female', 'cosette'),
  donation('pd_eponine', 'Éponine', 'female', 'eponine'),
  donation('pd_estelle', 'Estelle', 'female', 'estelle'),
  donation('pd_eve', 'Eve', 'female', 'eve'),
  donation('pd_fantine', 'Fantine', 'female', 'fantine'),
  donation('pd_jane', 'Jane', 'female', 'jane'),
  donation('pd_lola', 'Lola', 'female', 'lola'),
  donation('pd_mary', 'Mary', 'female', 'mary'),
  donation('pd_vera', 'Vera', 'female', 'vera'),
  donation('pd_caro_davy', 'Caro Davy', 'female', 'caro_davy'),
  donation('pd_bill_boerst', 'Bill Boerst', 'male', 'bill_boerst'),
  donation('pd_charles', 'Charles', 'male', 'charles'),
  donation('pd_george', 'George', 'male', 'george'),
  donation('pd_giovanni', 'Giovanni', 'male', 'giovanni'),
  donation('pd_javert', 'Javert', 'male', 'javert'),
  donation('pd_jean', 'Jean', 'male', 'jean'),
  donation('pd_juergen', 'Juergen', 'male', 'juergen'),
  donation('pd_marius', 'Marius', 'male', 'marius'),
  donation('pd_michael', 'Michael', 'male', 'michael'),
  donation('pd_paul', 'Paul', 'male', 'paul'),
  donation('pd_peter_yearsley', 'Peter Yearsley', 'male', 'peter_yearsley'),
  donation('pd_rafael', 'Rafael', 'male', 'rafael'),
  donation('pd_stuart_bell', 'Stuart Bell', 'male', 'stuart_bell'),
];

// ── Lookup helpers ──────────────────────────────────────────────

export const findEmotionalSpeaker = (
  id: string,
): EmotionalSpeaker | undefined => EMOTIONAL_SPEAKERS.find(s => s.id === id);

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
export const MAX_MAIN_CHARACTER_EMOTIONAL_SLOTS = EMOTIONAL_SPEAKERS.length - 1;
