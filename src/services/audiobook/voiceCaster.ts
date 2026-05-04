/**
 * Voice caster — assigns each character a `BlendedVoice` made of
 * Kokoro voice components.
 *
 * Algorithm:
 *   1. Match the character to an archetype via the keyword scoring
 *      matrix (`voiceArchetypes/`).
 *   2. Pick a 3-component recipe for that archetype + gender — the
 *      primary voice from `voicesForArchetype`, plus two filler voices.
 *   3. Perturb weights deterministically per character so two
 *      characters with the same archetype don't sound identical.
 *   4. Apply a distinct-voice guarantee pass — re-perturb if any two
 *      blends are too close.
 *
 * Output is a per-speaker `BlendedVoice` ready for the renderer.
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

// ── Archetype profiles ──────────────────────────────────────────

interface ArchetypeProfile {
  /** Speed multiplier relative to default 1.0. */
  speed: number;
}

const ARCHETYPE_PROFILES: Record<VoiceArchetype, ArchetypeProfile> = {
  warrior: { speed: 1.05 },
  mentor: { speed: 0.92 },
  villain: { speed: 0.97 },
  gentle: { speed: 0.97 },
  trickster: { speed: 1.1 },
  noble: { speed: 0.95 },
  child: { speed: 1.08 },
  elder: { speed: 0.85 },
  narrator: { speed: 1.0 },
  system: { speed: 1.0 },
  crowd: { speed: 1.05 },
};

// Reserved-speaker fixed recipes (so users get the same narrator voice
// across novels for consistency).
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

// ── Public API ──────────────────────────────────────────────────

export class VoiceCaster {
  /**
   * Build a fresh voice map from a glossary. Existing user overrides
   * are not respected (use `extendVoiceMap` to preserve them).
   */
  buildVoiceMap(glossary: CharacterGlossary): VoiceMap {
    const mappings: Record<string, BlendedVoice> = {};

    // Reserved speakers — fixed recipes.
    mappings.narrator = this.buildReserved(
      'Narrator',
      'narrator',
      glossary.narratorGender === 'female' ? 'female' : 'male',
    );
    mappings.system = this.buildReserved('System', 'system', 'male');
    mappings.crowd = this.buildReserved('Crowd', 'crowd', 'male');

    // Per-character voices.
    glossary.characters.forEach((char, idx) => {
      mappings[char.name] = this.castCharacter(char, idx);
    });

    // Distinct-voice guarantee.
    enforceDistinctness(mappings);

    return {
      novelId: glossary.novelId,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Apply a user override; bumps voiceVersion so cached audio is
   * invalidated on next playback.
   */
  overrideVoice(
    voiceMap: VoiceMap,
    speaker: string,
    next: Pick<BlendedVoice, 'components' | 'speed' | 'label'>,
  ): VoiceMap {
    const existing = voiceMap.mappings[speaker];
    const components = normaliseWeights(next.components);
    return {
      ...voiceMap,
      mappings: {
        ...voiceMap.mappings,
        [speaker]: {
          label: next.label ?? existing?.label ?? speaker,
          components,
          speed: next.speed,
          voiceVersion: (existing?.voiceVersion ?? 0) + 1,
        },
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Add new characters to an existing voice map without disturbing
   * existing entries. Used for incremental glossary discovery.
   */
  extendVoiceMap(
    voiceMap: VoiceMap,
    newCharacters: Character[],
  ): VoiceMap {
    const mappings = { ...voiceMap.mappings };
    const startIdx = Object.keys(mappings).length;
    newCharacters.forEach((char, i) => {
      if (mappings[char.name]) return;
      mappings[char.name] = this.castCharacter(char, startIdx + i);
    });
    enforceDistinctness(mappings);
    return {
      ...voiceMap,
      mappings,
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Casting helpers ─────────────────────────────────────────────

  private castCharacter(char: Character, idx: number): BlendedVoice {
    const archetype = matchArchetype(char);
    const gender =
      char.gender === 'neutral'
        ? idx % 2 === 0
          ? 'male'
          : 'female'
        : char.gender;
    const profile = ARCHETYPE_PROFILES[archetype];
    const recipe = buildRecipeForArchetype(archetype, gender);
    const seed = hashString(char.name) ^ idx;
    const perturbed = perturbWeights(recipe, seed);
    return {
      label: `${char.name}`,
      components: perturbed,
      speed: profile.speed,
      voiceVersion: 1,
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
      speed: ARCHETYPE_PROFILES[role].speed,
      voiceVersion: 1,
    };
  }
}

// ── Pure functions (exported for tests) ─────────────────────────

export function matchArchetype(c: {
  personality: string[];
  voiceHints: string[];
  gender?: 'male' | 'female' | 'neutral';
  name?: string;
}): VoiceArchetype {
  const scores: ArchetypeScores = {};
  const tokens = [...(c.personality ?? []), ...(c.voiceHints ?? [])];
  for (const tok of tokens) {
    const norm = normaliseKeyword(tok);
    const m = KEYWORD_SCORES[norm];
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
  if (bestScore <= 0) return 'gentle';
  return best;
}

export function buildRecipeForArchetype(
  archetype: VoiceArchetype,
  gender: 'male' | 'female',
): VoiceComponent[] {
  // Three-voice recipe:
  //   1. Best match for (archetype, gender)
  //   2. Second match (or fallback to a same-gender voice)
  //   3. A grounding/contrast voice from same gender
  const primary = voicesForArchetype(archetype, gender);
  const allGender = VOICE_CATALOG.filter(v => v.gender === gender);

  const pickOrFallback = (idx: number): string => {
    if (primary[idx]) return primary[idx].voiceId;
    return allGender[idx % allGender.length]?.voiceId ?? allGender[0].voiceId;
  };

  const a = pickOrFallback(0);
  const b = pickOrFallback(1);
  // For c, pick something complementary by archetype affinity, falling
  // back to a stable index in the catalog so different archetypes get
  // different "third voices".
  const c = allGender[(VOICE_CATALOG.findIndex(v => v.voiceId === a) + 5) % allGender.length].voiceId;

  return [
    { voiceId: a, weight: 50 },
    { voiceId: b === a ? pickOrFallback(2) : b, weight: 30 },
    { voiceId: c === a || c === b ? allGender[(allGender.length / 2) | 0].voiceId : c, weight: 20 },
  ];
}

/**
 * Perturb component weights by ±5 deterministically; renormalise to 100.
 */
export function perturbWeights(
  components: VoiceComponent[],
  seed: number,
): VoiceComponent[] {
  const rng = mulberry32(seed);
  const perturbed = components.map(c => ({
    voiceId: c.voiceId,
    weight: c.weight + (rng() * 10 - 5),
  }));
  return normaliseWeights(perturbed);
}

/**
 * Make weights sum to exactly 100, preserving ratios as integers.
 */
export function normaliseWeights(
  components: VoiceComponent[],
): VoiceComponent[] {
  const total = components.reduce((s, c) => s + c.weight, 0) || 1;
  const out = components.map(c => ({
    voiceId: c.voiceId,
    weight: Math.max(0, Math.round((c.weight / total) * 100)),
  }));
  // Adjust last for rounding error.
  const sum = out.reduce((s, c) => s + c.weight, 0);
  if (out.length > 0 && sum !== 100) {
    out[out.length - 1].weight += 100 - sum;
  }
  return out;
}

export function blendString(blend: BlendedVoice): string {
  return blend.components.map(c => `${c.voiceId}:${c.weight}`).join(',');
}

/**
 * Re-perturb voices that are too close to each other so a 30-character
 * cast doesn't have audible duplicates.
 */
function enforceDistinctness(
  mappings: Record<string, BlendedVoice>,
): void {
  const speakers = Object.keys(mappings).filter(
    s => s !== 'narrator' && s !== 'system' && s !== 'crowd',
  );
  const minDistance = 14;
  for (let attempt = 0; attempt < 3; attempt++) {
    let allOk = true;
    for (let i = 0; i < speakers.length; i++) {
      for (let j = i + 1; j < speakers.length; j++) {
        const a = mappings[speakers[i]];
        const b = mappings[speakers[j]];
        if (blendDistance(a, b) < minDistance) {
          const seed =
            (hashString(speakers[j]) ^ (attempt + 1) * 0x5bd1e995) >>> 0;
          mappings[speakers[j]] = {
            ...b,
            components: perturbWeights(b.components, seed),
            voiceVersion: b.voiceVersion,
          };
          allOk = false;
        }
      }
    }
    if (allOk) return;
  }
}

function blendDistance(a: BlendedVoice, b: BlendedVoice): number {
  const idsA = new Map(a.components.map(c => [c.voiceId, c.weight] as const));
  const idsB = new Map(b.components.map(c => [c.voiceId, c.weight] as const));
  const allIds = new Set([...idsA.keys(), ...idsB.keys()]);
  let total = 0;
  for (const id of allIds) {
    total += Math.abs((idsA.get(id) ?? 0) - (idsB.get(id) ?? 0));
  }
  return total;
}

// Hash & PRNG.
/* eslint-disable no-bitwise */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable no-bitwise */
