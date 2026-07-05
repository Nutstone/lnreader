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

    // Map aliases to the same assignment so segments the annotator
    // attributes to an alias don't fall back to the narrator voice.
    for (const character of glossary.characters) {
      const assignment = mappings[character.name];
      for (const alias of character.aliases ?? []) {
        if (!mappings[alias]) {
          mappings[alias] = assignment;
        }
      }
    }

    return {
      novelId: glossary.novelId,
      schemaVersion: VOICE_BANK_SCHEMA_VERSION,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Extends an existing voice map with characters the evolving
   * glossary discovered since the map was built. Stability rule: a
   * character's voice NEVER changes once assigned — existing entries
   * (including user-pinned ones) are untouched; only unmapped
   * characters and aliases receive voices.
   */
  extendVoiceMap(voiceMap: VoiceMap, glossary: CharacterGlossary): VoiceMap {
    const mappings: Record<string, VoiceAssignment> = {
      ...voiceMap.mappings,
    };

    // Self-heal a missing narrator entry (e.g. after a narrator
    // 'reset to auto') — every chapter has narrator segments, so a
    // narrator-less map would break all playback.
    if (!mappings.narrator) {
      const narratorSpeaker =
        findEmotionalSpeaker(
          this.options.narratorSpeakerId ?? DEFAULT_NARRATOR_SPEAKER_ID,
        ) ?? EMOTIONAL_SPEAKERS[0];
      mappings.narrator = {
        kind: 'emotional',
        speakerId: narratorSpeaker.id,
        label: 'Narrator',
      };
    }

    const narratorSpeakerId =
      mappings.narrator.kind === 'emotional'
        ? mappings.narrator.speakerId
        : this.options.narratorSpeakerId ?? DEFAULT_NARRATOR_SPEAKER_ID;

    // Emotional speakers already in use stay off-limits so two main
    // characters never share a voice.
    const taken = new Set<string>();
    for (const [name, assignment] of Object.entries(mappings)) {
      if (name !== 'narrator' && assignment.kind === 'emotional') {
        taken.add(assignment.speakerId);
      }
    }

    const slots = Math.min(
      this.options.mainCharacterEmotionalSlots,
      MAX_MAIN_CHARACTER_EMOTIONAL_SLOTS,
    );
    const remainingEmotional = EMOTIONAL_SPEAKERS.filter(
      s => s.id !== narratorSpeakerId,
    );

    const newcomers = this.rankByImportance(glossary.characters).filter(
      character => !mappings[character.name],
    );
    let usedSlots = taken.size;
    for (const character of newcomers) {
      if (usedSlots >= slots) {
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
      usedSlots++;
    }

    for (const character of glossary.characters) {
      if (!mappings[character.name]) {
        mappings[character.name] = this.assignDonationVoice(character);
      }
    }

    for (const character of glossary.characters) {
      const assignment = mappings[character.name];
      for (const alias of character.aliases ?? []) {
        if (!mappings[alias]) {
          mappings[alias] = assignment;
        }
      }
    }

    return {
      ...voiceMap,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Pins a manual voice pick. The character's aliases (when the
   * glossary is provided) follow along — segments the annotator
   * attributes to an alias must not keep speaking in the old voice.
   */
  overrideVoice(
    voiceMap: VoiceMap,
    characterName: string,
    assignment: VoiceAssignment,
    glossary?: CharacterGlossary,
  ): VoiceMap {
    const pinnedAssignment: VoiceAssignment = { ...assignment, pinned: true };
    const mappings = {
      ...voiceMap.mappings,
      [characterName]: pinnedAssignment,
    };
    for (const alias of this.aliasesOf(characterName, glossary)) {
      mappings[alias] = pinnedAssignment;
    }
    return {
      ...voiceMap,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Clears a manual pick and reassigns the character as if it were a
   * newcomer (stability for everyone else is preserved). Alias
   * entries are cleared with the primary name — a stale alias would
   * both hold the old voice and keep its emotional slot occupied.
   */
  resetVoice(
    voiceMap: VoiceMap,
    characterName: string,
    glossary: CharacterGlossary,
  ): VoiceMap {
    const mappings = { ...voiceMap.mappings };
    delete mappings[characterName];
    for (const alias of this.aliasesOf(characterName, glossary)) {
      delete mappings[alias];
    }
    return this.extendVoiceMap({ ...voiceMap, mappings }, glossary);
  }

  /**
   * Adjusts a voice's playback speed without re-pinning or changing
   * the voice itself. Aliases follow the primary name.
   */
  setVoiceSpeed(
    voiceMap: VoiceMap,
    characterName: string,
    speed: number,
    glossary?: CharacterGlossary,
  ): VoiceMap {
    const current = voiceMap.mappings[characterName];
    if (!current) {
      return voiceMap;
    }
    const updated: VoiceAssignment = { ...current, speed };
    const mappings = { ...voiceMap.mappings, [characterName]: updated };
    for (const alias of this.aliasesOf(characterName, glossary)) {
      if (mappings[alias]) {
        mappings[alias] = updated;
      }
    }
    return {
      ...voiceMap,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  private aliasesOf(
    characterName: string,
    glossary?: CharacterGlossary,
  ): string[] {
    return (
      glossary?.characters.find(c => c.name === characterName)?.aliases ?? []
    );
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
