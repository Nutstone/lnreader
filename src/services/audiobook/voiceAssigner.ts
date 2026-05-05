/**
 * VoiceAssigner — assigns characters to voices.
 *
 * Assignment rules:
 *  1. The narrator is locked to a designated emotional speaker
 *     (default Expresso ex03) so it can express emotion across
 *     the book.
 *  2. The top N main characters (by `importance`, then by mention
 *     order) are locked to remaining emotional speakers — Expresso
 *     first, then voice-zero — gender-matched when possible.
 *  3. Everyone else is assigned a stable donation voice via a
 *     deterministic hash of the character name, gender-filtered.
 *     Same name → same voice across runs and chapters.
 */

import type {
  Character,
  CharacterGlossary,
  EmotionalSpeaker,
  VoiceAssignment,
  VoiceMap,
} from './types';
import {
  DEFAULT_NARRATOR_SPEAKER_ID,
  DONATION_VOICES,
  EMOTIONAL_SPEAKERS,
  MAX_MAIN_CHARACTER_EMOTIONAL_SLOTS,
  VOICE_BANK_SCHEMA_VERSION,
  donationsForGender,
  findEmotionalSpeaker,
} from './voiceBank';

export interface VoiceAssignerOptions {
  /**
   * How many main characters get locked to emotional speakers.
   * Capped at MAX_MAIN_CHARACTER_EMOTIONAL_SLOTS.
   */
  mainCharacterEmotionalSlots: number;
  narratorSpeakerId?: string;
}

const DEFAULT_OPTIONS: VoiceAssignerOptions = {
  mainCharacterEmotionalSlots: 10,
  narratorSpeakerId: DEFAULT_NARRATOR_SPEAKER_ID,
};

export class VoiceAssigner {
  private options: VoiceAssignerOptions;

  constructor(options: Partial<VoiceAssignerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  buildVoiceMap(glossary: CharacterGlossary): VoiceMap {
    const mappings: Record<string, VoiceAssignment> = {};

    const narratorSpeaker =
      findEmotionalSpeaker(
        this.options.narratorSpeakerId ?? DEFAULT_NARRATOR_SPEAKER_ID,
      ) ?? EMOTIONAL_SPEAKERS[0];

    mappings.narrator = {
      kind: 'emotional',
      speakerId: narratorSpeaker.id,
      label: 'Narrator',
    };

    const remainingEmotional = EMOTIONAL_SPEAKERS.filter(
      s => s.id !== narratorSpeaker.id,
    );

    const ranked = this.rankByImportance(glossary.characters);
    const slots = Math.min(
      this.options.mainCharacterEmotionalSlots,
      MAX_MAIN_CHARACTER_EMOTIONAL_SLOTS,
    );

    const taken = new Set<string>();
    let slotIndex = 0;

    for (const character of ranked) {
      if (slotIndex >= slots) {
        break;
      }
      const speaker = pickEmotionalForGender(
        remainingEmotional,
        character.gender,
        taken,
      );
      if (!speaker) {
        break;
      }
      mappings[character.name] = {
        kind: 'emotional',
        speakerId: speaker.id,
        label: `${character.name} (${speaker.label})`,
      };
      taken.add(speaker.id);
      slotIndex++;
    }

    for (const character of glossary.characters) {
      if (mappings[character.name]) {
        continue;
      }
      mappings[character.name] = this.assignDonationVoice(character);
    }

    return {
      novelId: glossary.novelId,
      schemaVersion: VOICE_BANK_SCHEMA_VERSION,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  overrideVoice(
    voiceMap: VoiceMap,
    characterName: string,
    assignment: VoiceAssignment,
  ): VoiceMap {
    return {
      ...voiceMap,
      mappings: {
        ...voiceMap.mappings,
        [characterName]: assignment,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  private rankByImportance(characters: Character[]): Character[] {
    return [...characters]
      .map((c, idx) => ({ c, idx }))
      .sort((a, b) => {
        const ia = a.c.importance ?? 0;
        const ib = b.c.importance ?? 0;
        if (ib !== ia) {
          return ib - ia;
        }
        return a.idx - b.idx;
      })
      .map(x => x.c);
  }

  private assignDonationVoice(character: Character): VoiceAssignment {
    const pool = donationsForGender(character.gender);
    const fallback = pool.length > 0 ? pool : DONATION_VOICES;
    const seed = hashString(character.name);
    const voice = fallback[seed % fallback.length];
    return {
      kind: 'donation',
      voiceId: voice.id,
      label: `${character.name} (${voice.label})`,
    };
  }
}

const pickEmotionalForGender = (
  pool: EmotionalSpeaker[],
  gender: Character['gender'],
  taken: Set<string>,
): EmotionalSpeaker | undefined => {
  const matchGender = (g: 'male' | 'female') =>
    pool.find(s => !taken.has(s.id) && s.gender === g);

  if (gender === 'female') {
    return matchGender('female') ?? pool.find(s => !taken.has(s.id));
  }
  if (gender === 'male') {
    return matchGender('male') ?? pool.find(s => !taken.has(s.id));
  }
  return pool.find(s => !taken.has(s.id));
};

/* eslint-disable no-bitwise */
const hashString = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
};
/* eslint-enable no-bitwise */
