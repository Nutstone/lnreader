/**
 * Voice caster — assigns each character a `BlendedVoice` made of
 * Kokoro voice components.
 *
 * Algorithm:
 *   1. Match the character to an archetype via the keyword-scoring
 *      matrix (`voiceArchetypes/`).
 *   2. Pick a 3-component recipe for that archetype + gender.
 *
 * Reserved speakers (`narrator`, `system`, `crowd`) use fixed recipes
 * so the same narrator voice persists across novels.
 */

import {
  ArchetypeScores,
  BlendedVoice,
  Character,
  CharacterGlossary,
  VoiceArchetype,
  VoiceComponent,
  VoiceMap,
} from './types';
import { KEYWORD_SCORES, normaliseKeyword } from './voiceArchetypes';
import { VOICE_CATALOG, voicesForArchetype } from './voiceCatalog';

const ARCHETYPE_SPEED: Record<VoiceArchetype, number> = {
  warrior: 1.05,
  mentor: 0.92,
  villain: 0.97,
  gentle: 0.97,
  trickster: 1.1,
  noble: 0.95,
  child: 1.08,
  elder: 0.85,
  narrator: 1.0,
  system: 1.0,
  crowd: 1.05,
};

const RESERVED_RECIPES: Record<
  'narrator' | 'system' | 'crowd',
  Record<'male' | 'female', VoiceComponent[]>
> = {
  narrator: {
    male: [
      { voiceId: 'am_michael', weight: 50 },
      { voiceId: 'bm_fable', weight: 30 },
      { voiceId: 'am_liam', weight: 20 },
    ],
    female: [
      { voiceId: 'af_jessica', weight: 50 },
      { voiceId: 'af_river', weight: 30 },
      { voiceId: 'bf_alice', weight: 20 },
    ],
  },
  system: {
    male: [
      { voiceId: 'am_onyx', weight: 60 },
      { voiceId: 'bm_lewis', weight: 40 },
    ],
    female: [
      { voiceId: 'af_kore', weight: 60 },
      { voiceId: 'bf_isabella', weight: 40 },
    ],
  },
  crowd: {
    male: [
      { voiceId: 'am_adam', weight: 60 },
      { voiceId: 'am_echo', weight: 40 },
    ],
    female: [
      { voiceId: 'af_nova', weight: 60 },
      { voiceId: 'af_sky', weight: 40 },
    ],
  },
};

export class VoiceCaster {
  buildVoiceMap(glossary: CharacterGlossary): VoiceMap {
    const mappings: Record<string, BlendedVoice> = {};

    mappings.narrator = this.buildReserved(
      'Narrator',
      'narrator',
      glossary.narratorGender === 'female' ? 'female' : 'male',
    );
    mappings.system = this.buildReserved('System', 'system', 'male');
    mappings.crowd = this.buildReserved('Crowd', 'crowd', 'male');

    glossary.characters.forEach((char, idx) => {
      mappings[char.name] = this.castCharacter(char, idx);
    });

    return {
      novelId: glossary.novelId,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Add new characters to an existing voice map without disturbing
   * existing entries. Used for incremental glossary discovery.
   */
  extendVoiceMap(voiceMap: VoiceMap, newCharacters: Character[]): VoiceMap {
    const mappings = { ...voiceMap.mappings };
    const startIdx = Object.keys(mappings).length;
    newCharacters.forEach((char, i) => {
      if (mappings[char.name]) return;
      mappings[char.name] = this.castCharacter(char, startIdx + i);
    });
    return {
      ...voiceMap,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  private castCharacter(char: Character, idx: number): BlendedVoice {
    const archetype = matchArchetype(char);
    const gender =
      char.gender === 'neutral'
        ? idx % 2 === 0
          ? 'male'
          : 'female'
        : char.gender;
    return {
      label: char.name,
      components: buildRecipeForArchetype(archetype, gender),
      speed: ARCHETYPE_SPEED[archetype],
    };
  }

  private buildReserved(
    label: string,
    role: 'narrator' | 'system' | 'crowd',
    gender: 'male' | 'female',
  ): BlendedVoice {
    return {
      label,
      components: RESERVED_RECIPES[role][gender].slice(),
      speed: ARCHETYPE_SPEED[role],
    };
  }
}

// ── Pure helpers (exported for tests) ─────────────────────────

export function matchArchetype(c: {
  personality: string[];
  voiceHints: string[];
  gender?: 'male' | 'female' | 'neutral';
  name?: string;
}): VoiceArchetype {
  const scores: ArchetypeScores = {};
  const tokens = [...(c.personality ?? []), ...(c.voiceHints ?? [])];
  for (const tok of tokens) {
    const m = KEYWORD_SCORES[normaliseKeyword(tok)];
    if (!m) continue;
    for (const [arch, s] of Object.entries(m) as [VoiceArchetype, number][]) {
      scores[arch] = (scores[arch] ?? 0) + s;
    }
  }
  let best: VoiceArchetype = 'gentle';
  let bestScore = -Infinity;
  for (const arch of Object.keys(scores) as VoiceArchetype[]) {
    if ((scores[arch] ?? 0) > bestScore) {
      bestScore = scores[arch] ?? 0;
      best = arch;
    }
  }
  return bestScore > 0 ? best : 'gentle';
}

export function buildRecipeForArchetype(
  archetype: VoiceArchetype,
  gender: 'male' | 'female',
): VoiceComponent[] {
  const primary = voicesForArchetype(archetype, gender);
  const allGender = VOICE_CATALOG.filter(v => v.gender === gender);

  const pickOrFallback = (idx: number): string => {
    if (primary[idx]) return primary[idx].voiceId;
    return allGender[idx % allGender.length]?.voiceId ?? allGender[0].voiceId;
  };

  const a = pickOrFallback(0);
  const b = pickOrFallback(1);
  const c =
    allGender[(VOICE_CATALOG.findIndex(v => v.voiceId === a) + 5) %
      allGender.length].voiceId;

  return [
    { voiceId: a, weight: 50 },
    { voiceId: b === a ? pickOrFallback(2) : b, weight: 30 },
    {
      voiceId:
        c === a || c === b
          ? allGender[(allGender.length / 2) | 0].voiceId
          : c,
      weight: 20,
    },
  ];
}

export function blendString(blend: BlendedVoice): string {
  return blend.components.map(c => `${c.voiceId}:${c.weight}`).join(',');
}
