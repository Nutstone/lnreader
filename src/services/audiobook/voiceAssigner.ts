/**
 * VoiceAssigner — replaces the old VoiceBlender.
 *
 * Assignment rules:
 *  1. The narrator is locked to a designated Expresso speaker so it
 *     can express emotion across the book.
 *  2. The top N main characters (by `importance`, then by mention
 *     order) are locked to the remaining Expresso speakers, gender
 *     matched when possible.
 *  3. Everyone else is assigned a stable donation voice via a
 *     deterministic hash of the character name, gender-filtered.
 *     Same name → same voice across runs and chapters.
 */

import type {
  Character,
  CharacterGlossary,
  ExpressoSpeaker,
  VoiceAssignment,
  VoiceMap,
} from './types';
import {
  DEFAULT_NARRATOR_SPEAKER_ID,
  DONATION_VOICES,
  EXPRESSO_SPEAKERS,
  VOICE_BANK_SCHEMA_VERSION,
  donationsForGender,
  findExpressoSpeaker,
} from './voiceBank';

export interface VoiceAssignerOptions {
  /**
   * How many main characters get locked to Expresso speakers.
   * Capped at the number of available speakers minus the narrator.
   */
  expressoMainCharacterSlots: number;
  narratorSpeakerId?: string;
}

const DEFAULT_OPTIONS: VoiceAssignerOptions = {
  expressoMainCharacterSlots: 3,
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
      findExpressoSpeaker(
        this.options.narratorSpeakerId ?? DEFAULT_NARRATOR_SPEAKER_ID,
      ) ?? EXPRESSO_SPEAKERS[0];

    mappings.narrator = {
      kind: 'expresso',
      speakerId: narratorSpeaker.id,
      label: 'Narrator',
    };

    const remainingExpresso = EXPRESSO_SPEAKERS.filter(
      s => s.id !== narratorSpeaker.id,
    );

    const ranked = this.rankByImportance(glossary.characters);
    const slots = Math.min(
      this.options.expressoMainCharacterSlots,
      remainingExpresso.length,
    );

    const taken = new Set<string>();
    let slotIndex = 0;

    for (const character of ranked) {
      if (slotIndex >= slots) {
        break;
      }
      const speaker = pickExpressoForGender(
        remainingExpresso,
        character.gender,
        taken,
      );
      if (!speaker) {
        continue;
      }
      mappings[character.name] = {
        kind: 'expresso',
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

const pickExpressoForGender = (
  pool: ExpressoSpeaker[],
  gender: Character['gender'],
  taken: Set<string>,
): ExpressoSpeaker | undefined => {
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
