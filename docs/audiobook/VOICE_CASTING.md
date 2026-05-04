# Voice Casting

How characters get assigned voices.

## The pipeline

```
LLM glossary → matchArchetype(personality + voiceHints)
            → buildRecipeForArchetype(archetype, gender)
            → perturbWeights(seed = hash(name) ^ index)
            → enforceDistinctness(all character voices)
            → BlendedVoice { label, components, speed, voiceVersion }
```

## Archetype scoring

`KEYWORD_SCORES` (in `voiceArchetypes/en.ts`) maps each keyword to one
or more archetype scores. The matcher sums scores across all
personality + voiceHint tokens for a character; the highest archetype
wins.

Each keyword can vote for multiple archetypes:

```ts
wise:        { mentor: 3, elder: 1, noble: 1 },
fierce:      { warrior: 3, villain: 1 },
cold:        { villain: 2, noble: 1, mentor: 0.5 },
```

This makes ties resolve naturally — "wise but cold" gets some mentor,
some noble, some villain — no winner-take-all bias.

The matcher's tie-break for true ties is `'gentle'` (a safe neutral).

## Voice hints (audio descriptors)

The LLM emits `voiceHints` for each character — `deep`, `raspy`, `high`,
`musical`, `rapid`, `monotone`, etc. These are mapped into the same
scoring matrix. A "warrior" with `voiceHints: ['deep', 'gravelly']`
biases the blend toward deeper male voices in the catalog.

Voice hints are how non-English-coded characters work: a samurai with
`personality: ['warrior', 'noble']` and `voiceHints: ['low', 'measured']`
gets the warrior archetype but skews the blend toward `am_onyx` or
`bm_george` rather than the brighter `am_eric`.

## Blend recipes

`buildRecipeForArchetype(archetype, gender)` returns a 3-component
recipe with weights 50/30/20:

- Component 1: best match for (archetype, gender) from
  `voicesForArchetype(archetype, gender)`.
- Component 2: second match, falling back to a same-gender voice.
- Component 3: a complementary voice 5 slots away in the catalog (so
  different archetypes get different "third voices").

After the recipe is built, `perturbWeights(seed)` adds ±5 jitter and
renormalises to exactly 100. The seed is `hash(character.name) ^
index` — deterministic per character.

## Distinct-voice guarantee

After casting, `enforceDistinctness(mappings)` walks every pair of
character voices and checks the L1 distance between their weight
vectors. Pairs under `minDistance = 14` get re-perturbed with a
different seed, up to 3 attempts. This stops 30-character casts from
having two characters that sound nearly identical.

Distance metric: sum-of-absolute-differences across matched voice
components, plus the unmatched-component weights.

## Reserved speakers

`narrator`, `system`, `crowd` get fixed recipes (no perturbation) so the
narrator voice is consistent across novels. Recipes live in
`voiceCaster.ts:RESERVED_RECIPES`.

A character whose `personality` contains `narrator` does NOT get the
reserved narrator voice — only the literal speaker name `narrator`
does. This is intentional: it lets the LLM emit `speaker: "Rimuru"` for
Rimuru's narrated thoughts and `speaker: "narrator"` for
authorial-voice prose.

## User overrides

`pipeline.setVoiceMap(updated)` saves a new voice map. The voice picker
calls this with `voiceCaster.overrideVoice(map, speaker, next)` which
also bumps `voiceVersion`. The audio cache keys off `voiceVersion`, so
next playback re-renders only that character's segments — the rest of
the chapter audio is reused.

## Pronunciation overrides

Each character has an optional `pronunciation` field. At render time,
the pipeline applies whole-word substitutions across the segment text
for any character whose name appears with a non-empty `pronunciation`
override. Substitutions are case-sensitive whole-word matches.

If `name = "Veldora"` and `pronunciation = "Vel-DOR-uh"`, every
occurrence of `Veldora` in the segment text becomes `Vel-DOR-uh`
before the renderer sees it. The visible chapter text is untouched.

## Glossary structure

```ts
interface Character {
  name: string;
  aliases: string[];
  gender: 'male' | 'female' | 'neutral';
  personality: string[];   // free-form keywords
  voiceHints: string[];    // audio descriptors
  description: string;
  pronunciation?: string;  // override for the spoken form
  firstSeenChapter?: number;
  userOverridden?: boolean;
}

interface CharacterGlossary {
  novelId: string;
  narratorGender: 'male' | 'female' | 'neutral';
  narratorVoiceHints: string[];
  characters: Character[];
  createdAt: string;
  updatedAt: string;
}
```

No `schemaVersion` — the feature is fresh and there's no installed-user
data to migrate from. Future shape changes can be additive.

## Why not voice cloning / per-character speech models

Out of scope. ElevenLabs/Cartesia-style cloning is a research project
on its own and most users won't pay for the API time. The 28-voice
catalog × weighted blending gives effectively unlimited unique
character voices for free.

## Quality validation

Manual: process the first chapter of 5 well-known light novels (Slime,
Mushoku Tensei, Overlord, Frieren, Spice and Wolf), audition each
character, note jarring mismatches.

Automated: `voiceCaster.test.ts` covers `matchArchetype` with 10+
keyword combos and the integration path through `buildVoiceMap`. New
edge cases get added as keywords to `voiceArchetypes/en.ts`.
