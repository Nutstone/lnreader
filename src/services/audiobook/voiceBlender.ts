import {
  Character,
  CharacterGlossary,
  VoiceArchetype,
  VoiceComponent,
  BlendedVoice,
  VoiceMap,
} from './types';

// ── Archetype Recipes ───────────────────────────────────────────
// Each archetype has male and female voice blend recipes using
// Kokoro's base voices. Weights must sum to 100.

const ARCHETYPE_RECIPES: Record<
  VoiceArchetype,
  { male: VoiceComponent[]; female: VoiceComponent[]; speed: number }
> = {
  warrior: {
    female: [
      { voiceId: 'af_bella', weight: 50 },
      { voiceId: 'af_nova', weight: 30 },
      { voiceId: 'af_jessica', weight: 20 },
    ],
    male: [
      { voiceId: 'am_eric', weight: 50 },
      { voiceId: 'am_onyx', weight: 30 },
      { voiceId: 'am_adam', weight: 20 },
    ],
    speed: 1.05,
  },
  mentor: {
    female: [
      { voiceId: 'bf_emma', weight: 50 },
      { voiceId: 'af_sarah', weight: 30 },
      { voiceId: 'bf_lily', weight: 20 },
    ],
    male: [
      { voiceId: 'bm_fable', weight: 50 },
      { voiceId: 'bm_george', weight: 30 },
      { voiceId: 'am_michael', weight: 20 },
    ],
    speed: 0.9,
  },
  villain: {
    female: [
      { voiceId: 'af_kore', weight: 50 },
      { voiceId: 'bf_isabella', weight: 30 },
      { voiceId: 'af_nicole', weight: 20 },
    ],
    male: [
      { voiceId: 'bm_lewis', weight: 50 },
      { voiceId: 'am_onyx', weight: 30 },
      { voiceId: 'bm_daniel', weight: 20 },
    ],
    speed: 0.95,
  },
  gentle: {
    female: [
      { voiceId: 'af_heart', weight: 50 },
      { voiceId: 'af_sky', weight: 30 },
      { voiceId: 'bf_lily', weight: 20 },
    ],
    male: [
      { voiceId: 'am_liam', weight: 50 },
      { voiceId: 'am_michael', weight: 30 },
      { voiceId: 'bm_fable', weight: 20 },
    ],
    speed: 0.95,
  },
  trickster: {
    female: [
      { voiceId: 'af_nova', weight: 50 },
      { voiceId: 'af_alloy', weight: 30 },
      { voiceId: 'af_river', weight: 20 },
    ],
    male: [
      { voiceId: 'am_echo', weight: 50 },
      { voiceId: 'am_adam', weight: 30 },
      { voiceId: 'bm_fable', weight: 20 },
    ],
    speed: 1.1,
  },
  noble: {
    female: [
      { voiceId: 'bf_alice', weight: 50 },
      { voiceId: 'bf_emma', weight: 30 },
      { voiceId: 'af_jessica', weight: 20 },
    ],
    male: [
      { voiceId: 'bm_george', weight: 50 },
      { voiceId: 'bm_daniel', weight: 30 },
      { voiceId: 'am_liam', weight: 20 },
    ],
    speed: 0.95,
  },
  child: {
    female: [
      { voiceId: 'af_sky', weight: 50 },
      { voiceId: 'af_heart', weight: 30 },
      { voiceId: 'af_aoede', weight: 20 },
    ],
    male: [
      { voiceId: 'am_adam', weight: 50 },
      { voiceId: 'am_echo', weight: 30 },
      { voiceId: 'am_liam', weight: 20 },
    ],
    speed: 1.1,
  },
  elder: {
    female: [
      { voiceId: 'bf_emma', weight: 50 },
      { voiceId: 'af_sarah', weight: 30 },
      { voiceId: 'af_nicole', weight: 20 },
    ],
    male: [
      { voiceId: 'bm_george', weight: 50 },
      { voiceId: 'bm_fable', weight: 30 },
      { voiceId: 'bm_lewis', weight: 20 },
    ],
    speed: 0.85,
  },
  narrator: {
    female: [
      { voiceId: 'af_jessica', weight: 50 },
      { voiceId: 'af_river', weight: 30 },
      { voiceId: 'bf_alice', weight: 20 },
    ],
    male: [
      { voiceId: 'am_michael', weight: 50 },
      { voiceId: 'bm_fable', weight: 30 },
      { voiceId: 'am_liam', weight: 20 },
    ],
    speed: 1.0,
  },
};

// ── Personality keyword → archetype mapping ─────────────────────

const KEYWORD_ARCHETYPE_MAP: Record<string, VoiceArchetype> = {
  warrior: 'warrior',
  fighter: 'warrior',
  aggressive: 'warrior',
  fierce: 'warrior',
  brave: 'warrior',
  bold: 'warrior',
  hotblooded: 'warrior',

  mentor: 'mentor',
  wise: 'mentor',
  teacher: 'mentor',
  sage: 'mentor',
  knowledgeable: 'mentor',
  guide: 'mentor',

  villain: 'villain',
  villainous: 'villain',
  evil: 'villain',
  dark: 'villain',
  sinister: 'villain',
  cunning: 'villain',
  cruel: 'villain',
  cold: 'villain',

  gentle: 'gentle',
  kind: 'gentle',
  warm: 'gentle',
  caring: 'gentle',
  soft: 'gentle',
  shy: 'gentle',
  timid: 'gentle',

  trickster: 'trickster',
  mischievous: 'trickster',
  playful: 'trickster',
  cheerful: 'trickster',
  energetic: 'trickster',
  witty: 'trickster',
  sarcastic: 'trickster',

  noble: 'noble',
  regal: 'noble',
  dignified: 'noble',
  proud: 'noble',
  royal: 'noble',
  elegant: 'noble',
  authoritative: 'noble',

  child: 'child',
  young: 'child',
  innocent: 'child',
  naive: 'child',
  cute: 'child',
  small: 'child',

  elder: 'elder',
  old: 'elder',
  ancient: 'elder',
  mature: 'elder',
  veteran: 'elder',
  experienced: 'elder',
};

// ── VoiceBlender ────────────────────────────────────────────────

export class VoiceBlender {
  buildVoiceMap(glossary: CharacterGlossary): VoiceMap {
    const mappings: Record<string, BlendedVoice> = {};

    // Assign narrator voice
    const narratorRecipe = ARCHETYPE_RECIPES.narrator;
    const narratorBase =
      glossary.narratorGender === 'female'
        ? narratorRecipe.female
        : narratorRecipe.male;
    mappings.narrator = {
      label: 'Narrator',
      components: [...narratorBase],
      speed: narratorRecipe.speed,
    };

    // Assign character voices
    glossary.characters.forEach((character, index) => {
      const archetype = this.matchArchetype(character);
      const recipe = ARCHETYPE_RECIPES[archetype];
      const genderKey = character.gender === 'female' ? 'female' : 'male';
      const baseComponents = recipe[genderKey];

      const seed = this.hashString(character.name) + index;
      const perturbedComponents = this.perturbWeights(baseComponents, seed);

      mappings[character.name] = {
        label: `${character.name}'s voice`,
        components: perturbedComponents,
        speed: recipe.speed,
      };
    });

    return {
      novelId: glossary.novelId,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  overrideVoice(
    voiceMap: VoiceMap,
    characterName: string,
    voice: BlendedVoice,
  ): VoiceMap {
    return {
      ...voiceMap,
      mappings: {
        ...voiceMap.mappings,
        [characterName]: voice,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  getBlendString(voice: BlendedVoice): string {
    return voice.components.map(c => `${c.voiceId}:${c.weight}`).join(',');
  }

  private matchArchetype(character: Character): VoiceArchetype {
    const scores: Partial<Record<VoiceArchetype, number>> = {};

    for (const keyword of character.personality) {
      const normalized = keyword.toLowerCase().replace(/[^a-z]/g, '');
      const archetype = KEYWORD_ARCHETYPE_MAP[normalized];
      if (archetype) {
        scores[archetype] = (scores[archetype] || 0) + 1;
      }
    }

    // Find highest scoring archetype
    let bestArchetype: VoiceArchetype = 'gentle';
    let bestScore = 0;
    for (const [archetype, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestArchetype = archetype as VoiceArchetype;
      }
    }

    return bestArchetype;
  }

  private perturbWeights(
    base: VoiceComponent[],
    seed: number,
  ): VoiceComponent[] {
    const rng = this.seededRandom(seed);
    const perturbed = base.map(component => ({
      voiceId: component.voiceId,
      weight: component.weight + (rng() * 10 - 5), // ±5 variation
    }));

    // Normalize weights to sum to exactly 100
    const total = perturbed.reduce((sum, c) => sum + c.weight, 0);
    const normalized = perturbed.map(c => ({
      voiceId: c.voiceId,
      weight: Math.round((c.weight / total) * 100),
    }));
    // Adjust last component to ensure weights sum to exactly 100
    const roundedTotal = normalized.reduce((sum, c) => sum + c.weight, 0);
    if (normalized.length > 0 && roundedTotal !== 100) {
      normalized[normalized.length - 1].weight += 100 - roundedTotal;
    }
    return normalized;
  }

  /* eslint-disable no-bitwise */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }
  /* eslint-enable no-bitwise */
}
