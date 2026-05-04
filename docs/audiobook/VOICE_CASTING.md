# Voice Casting

How characters get assigned voices. The current implementation works as
described in the original concept (9 archetypes + per-character
perturbation) but is missing the human-in-the-loop step that makes the
casting actually good.

## Today's algorithm

```
LLM → glossary {characters: [{name, gender, personality[], description}]}
      ↓
   matchArchetype(personality keywords) → 'warrior' | 'mentor' | ...
      ↓
   recipe = ARCHETYPE_RECIPES[archetype][gender]   # 3 voice components
      ↓
   perturbWeights(recipe, hashSeed(name))          # ±5 per weight
      ↓
   normalise weights to sum 100
      ↓
   blendString = "af_bella:50,af_nova:30,af_jessica:20"
      ↓
   stored in voice-map.json
```

Source: `src/services/audiobook/voiceBlender.ts`.

This is a solid baseline. The improvements below assume it stays.

## Improvement 1 — Glossary review

The model picks 14 characters. Sometimes the model is wrong:

- "Master" gets cast as a separate character because dialogue says
  "Master, please.".
- "the merchant" appears in three chapters but never has a name.
- A dog named "Buddy" gets cast with a male human voice.

The user must be able to fix this **before** $5 of API credit is spent
on full annotation.

Flow (from `UX_GUIDELINES.md` §2):

1. After glossary build, show the cast in a screen.
2. User can:
   - Edit a character's name, aliases, gender, personality.
   - Merge two characters ("Master" → "Rimuru").
   - Delete (downgrades to "narrator").
   - Override voice with the voice picker.
3. **Confirm** persists the glossary and runs voice mapping.
4. Skipping confirm uses the LLM's choices verbatim (the current behaviour).

Implementation:

```ts
// pipeline.ts
async confirmGlossary(edited: CharacterGlossary): Promise<VoiceMap> {
  await this.writeJSON(`${this.novelDir}/glossary.json`, edited);
  const voiceMap = this.blender.buildVoiceMap(edited);
  await this.writeJSON(`${this.novelDir}/voice-map.json`, voiceMap);
  return voiceMap;
}

async mergeCharacters(into: string, mergedNames: string[]): Promise<void> {
  // Re-write existing annotations: any speaker == mergedNames[i]
  // becomes `into`. Rebuild voice map.
}
```

The annotation cache must be patched on merge — otherwise a chapter
already annotated still says "Master" and gets the wrong voice.

## Improvement 2 — Better keyword → archetype matching

Today's matcher is a flat lookup table:

```ts
const KEYWORD_ARCHETYPE_MAP = {
  warrior: 'warrior', fighter: 'warrior', aggressive: 'warrior', ...
  mentor: 'mentor', wise: 'mentor', ...
};
```

It's brittle: "wise but cold" produces a tie that resolves to whichever
key appeared first in iteration order.

Replace with a scoring matrix where each keyword can vote for multiple
archetypes:

```ts
type ArchetypeScores = Partial<Record<VoiceArchetype, number>>;

const KEYWORD_SCORES: Record<string, ArchetypeScores> = {
  wise:        { mentor: 3, elder: 1, noble: 1 },
  fierce:      { warrior: 3, villain: 1 },
  cold:        { villain: 2, noble: 1, mentor: 0.5 },
  cheerful:    { trickster: 3, child: 1, gentle: 1 },
  mysterious:  { villain: 2, mentor: 1, noble: 1 },
  // ...
};
```

For each character, sum the scores. Tie-break by character description
(also free-text passed to the same matrix). On a true tie, fall back to
'gentle' (a safe neutral default).

Add unit tests with 50+ keyword combinations from real novels — this is
the single most user-visible quality lever.

## Improvement 3 — Per-character voice override (UI)

The engine supports it (`pipeline.overrideVoice(characterName, voice)`)
but no UI calls it. Build the voice picker from `UX_GUIDELINES.md` §3
and wire it to:

```ts
// In glossary review screen
onVoiceChange(charName: string, newVoice: BlendedVoice) {
  pipeline.overrideVoice(charName, newVoice);
  // Invalidate any cached audio for this character
  audioCache.invalidateByCharacter(novelId, charName);
}
```

`audioCache.invalidateByCharacter` walks the manifest, deletes
`*.opus` files where `speaker === charName`, increments the
`voiceVersion`. Next playback re-renders affected segments only — the
rest of the chapter audio cache is preserved.

## Improvement 4 — Distinct-voice guarantee

Two characters that score the same archetype + gender currently get
similar voices (perturbation does ±5, which is barely audible). Add
a uniqueness pass:

```ts
function ensureDistinct(voices: BlendedVoice[]): BlendedVoice[] {
  const minDistance = 12;  // weight units
  for (let i = 0; i < voices.length; i++) {
    for (let j = i + 1; j < voices.length; j++) {
      while (blendDistance(voices[i], voices[j]) < minDistance) {
        voices[j] = perturbMore(voices[j]);
      }
    }
  }
  return voices;
}
```

`blendDistance` is sum-of-absolute-differences across matching voice
components, plus weighted Hamming distance for non-matching components.

For novels with > 20 characters this matters most — by character 15
you'll start hearing duplicates without it.

## Improvement 5 — Speed and pitch beyond emotion

Current code modulates speed by emotion. Add pitch perturbation per
character in a small range (±0.05) — it's subtle but distinguishes
voices that share a blend.

Kokoro doesn't expose a pitch parameter; bake it in at the audio
post-processing step using the existing `expo-av` rate (which preserves
pitch when `shouldCorrectPitch: false`). For cleaner pitch shifting,
bring in `react-native-audio-toolkit`'s pitch shift.

## Improvement 6 — Special speakers

Three speakers need special handling:

| Speaker | Treatment |
|---------|-----------|
| `narrator` | Default voice, slowed slightly for descriptive prose. Never perturbed across novels — keep recognisable across the user's library. |
| `system` | For LitRPG / status-window text. Robotic, monotone. Reserved keyword. |
| `crowd` / `unknown` | Fallback voice. Quiet, fast, neutral. |

Add to types:

```ts
const RESERVED_SPEAKERS = ['narrator', 'system', 'crowd', 'unknown'] as const;
```

Update the annotation prompt to use these reserved names when
appropriate. The voice blender pre-populates them with fixed (not
perturbed) blends so the user gets a consistent narrator across novels.

## Improvement 7 — Cross-novel voice memory

A user who loves their "narrator voice" in Novel A wants the same voice
as the default narrator for Novel B. Add an MMKV-stored
`AUDIOBOOK_DEFAULT_VOICES` that records the user's last used overrides
for the reserved speakers.

```ts
interface DefaultVoices {
  narrator?: BlendedVoice;  // overrides archetype default
  system?: BlendedVoice;
}
```

Surface in settings: "Default narrator voice [▶ Sample] [Change]". Users
who never change it get the auto-cast; users who do never lose their
choice.

## Improvement 8 — Prompt instructions for casting

The current glossary builder prompt describes characters in terms of
**how they ARE** (warrior, gentle, wise). For casting we want **how they
SOUND** (high-pitched, growly, hesitant). Patch the prompt:

```
For each character, also include:
  voiceHints: an array of audio descriptors like "deep", "high",
  "raspy", "youthful", "hesitant", "rapid", "slow", "monotone",
  "musical", "gravelly".

These are how the character should SOUND. A "kind queen" might be
"musical, slow, warm". A "ruthless mercenary" might be "low, clipped,
gravelly".
```

The matcher then uses both `personality` and `voiceHints`. Example:
"warrior, low, growly" maps to `warrior` archetype but biases the blend
toward `am_onyx` (deeper) over `am_eric`.

## Edge cases to handle

| Case | Behaviour |
|------|-----------|
| Character has only 1 line in glossary sample | Cast tentatively; flag in glossary review with "Only 1 line — voice may be off." |
| Character is a non-human (dragon, AI, slime) | Honour `personality` keywords; allow user to lower pitch via custom blend post-confirmation. |
| Character is a child | If `personality` includes `child`, force the `child` archetype regardless of other scores. |
| Character speaks two languages | Out of scope for v1.0 (Kokoro is English-only). Document as a known limitation. |
| Character is the narrator (1st-person POV) | Cast as the chapter narrator; emit dialogue with their voice; emit thoughts with the same voice. |

## How to test casting quality

Manual audit per release:

1. Process the first chapter of 5 well-known light novels (Slime, Mushoku
   Tensei, Overlord, Frieren, Spice and Wolf).
2. Audition each character voice against a community-judged "expected"
   voice tag.
3. Track regression: each release should not lose a character that was
   cast acceptably in the previous release.

Automated:

```ts
// __tests__/audiobook/voiceCasting.test.ts
describe('voice casting', () => {
  it('casts a "wise old mentor" to the mentor archetype', () => {
    const character = mockCharacter({ personality: ['wise', 'old', 'mentor'] });
    expect(matchArchetype(character)).toBe('mentor');
  });
  it('casts a "fierce hot-blooded warrior" to warrior', () => { ... });
  it('breaks ties in favour of the more specific keyword', () => { ... });
  // 50+ cases
});
```

## Glossary persistence schema

```json
{
  "novelId": "tensura",
  "narratorGender": "male",
  "narratorVoiceHints": ["calm", "warm", "slow"],
  "characters": [
    {
      "name": "Rimuru",
      "aliases": ["Slime-san", "Sage"],
      "gender": "neutral",
      "personality": ["gentle", "wise", "playful"],
      "voiceHints": ["medium", "warm", "thoughtful"],
      "description": "A formerly-human slime with quiet authority.",
      "firstSeenChapter": 1,
      "userOverridden": false
    }
  ],
  "createdAt": "2026-05-04T10:00:00Z",
  "updatedAt": "2026-05-04T10:00:00Z",
  "schemaVersion": 2
}
```

Bump `schemaVersion` when the shape changes; pipeline reads old
versions and migrates on save.

## Don't over-engineer

It's tempting to add per-character lip-sync, per-emotion voice
warping, character-aware sound effects… don't. The bar this feature
needs to clear is **"as good as a friend reading aloud, with different
voices for the main characters"**. Anything past that is a research
project.
