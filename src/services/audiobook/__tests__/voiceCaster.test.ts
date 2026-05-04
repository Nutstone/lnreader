import {
  matchArchetype,
  perturbWeights,
  normaliseWeights,
  blendString,
  buildRecipeForArchetype,
  VoiceCaster,
} from '@services/audiobook/voiceCaster';
import { Character, CharacterGlossary } from '@services/audiobook/types';

const mockChar = (overrides: Partial<Character> = {}): Character => ({
  name: 'Test',
  aliases: [],
  gender: 'neutral',
  personality: [],
  voiceHints: [],
  description: '',
  ...overrides,
});

describe('matchArchetype', () => {
  it.each<[string[], string]>([
    [['warrior', 'fierce'], 'warrior'],
    [['wise', 'old', 'mentor'], 'mentor'],
    [['cold', 'cunning'], 'villain'],
    [['cheerful', 'playful'], 'trickster'],
    [['regal', 'elegant'], 'noble'],
    [['child', 'innocent'], 'child'],
    [['ancient', 'weathered'], 'elder'],
    [['gentle', 'kind'], 'gentle'],
    [['tsundere'], 'trickster'],
    [['shounen'], 'warrior'],
  ])('matches %j → %s', (personality, expected) => {
    expect(matchArchetype(mockChar({ personality }))).toBe(expected);
  });

  it('falls back to gentle on unknown keywords', () => {
    expect(matchArchetype(mockChar({ personality: ['xxxxxx'] }))).toBe('gentle');
  });

  it('combines personality + voiceHints', () => {
    expect(
      matchArchetype(
        mockChar({
          personality: ['warrior'],
          voiceHints: ['deep', 'gravelly'],
        }),
      ),
    ).toBe('warrior');
  });
});

describe('normaliseWeights', () => {
  it('normalises to exactly 100', () => {
    const out = normaliseWeights([
      { voiceId: 'a', weight: 30 },
      { voiceId: 'b', weight: 50 },
      { voiceId: 'c', weight: 20 },
    ]);
    expect(out.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });

  it('handles imprecise weights', () => {
    const out = normaliseWeights([
      { voiceId: 'a', weight: 33.33 },
      { voiceId: 'b', weight: 33.33 },
      { voiceId: 'c', weight: 33.34 },
    ]);
    expect(out.reduce((s, c) => s + c.weight, 0)).toBe(100);
  });

  it('handles single component', () => {
    const out = normaliseWeights([{ voiceId: 'a', weight: 7 }]);
    expect(out).toEqual([{ voiceId: 'a', weight: 100 }]);
  });
});

describe('perturbWeights', () => {
  it('produces deterministic blends from a seed', () => {
    const base = [
      { voiceId: 'a', weight: 50 },
      { voiceId: 'b', weight: 30 },
      { voiceId: 'c', weight: 20 },
    ];
    expect(perturbWeights(base, 42)).toEqual(perturbWeights(base, 42));
  });

  it('always sums to 100 after perturbation', () => {
    const base = [
      { voiceId: 'a', weight: 50 },
      { voiceId: 'b', weight: 30 },
      { voiceId: 'c', weight: 20 },
    ];
    for (let seed = 1; seed < 20; seed++) {
      const out = perturbWeights(base, seed);
      expect(out.reduce((s, c) => s + c.weight, 0)).toBe(100);
    }
  });
});

describe('blendString', () => {
  it('serialises components as id:weight,id:weight', () => {
    expect(
      blendString({
        label: 'x',
        voiceVersion: 1,
        speed: 1,
        components: [
          { voiceId: 'af_bella', weight: 50 },
          { voiceId: 'af_nova', weight: 30 },
        ],
      }),
    ).toBe('af_bella:50,af_nova:30');
  });
});

describe('buildRecipeForArchetype', () => {
  it('returns a 3-component recipe', () => {
    const r = buildRecipeForArchetype('warrior', 'female');
    expect(r).toHaveLength(3);
    const ids = new Set(r.map(c => c.voiceId));
    expect(ids.size).toBeGreaterThanOrEqual(2);
  });
});

describe('VoiceCaster integration', () => {
  it('builds a voice map with reserved speakers + characters', () => {
    const glossary: CharacterGlossary = {
      novelId: 't',
      narratorGender: 'male',
      narratorVoiceHints: ['warm'],
      characters: [
        mockChar({
          name: 'Rimuru',
          gender: 'neutral',
          personality: ['gentle', 'wise'],
        }),
        mockChar({
          name: 'Veldora',
          gender: 'male',
          personality: ['mentor', 'wise'],
        }),
        mockChar({
          name: 'Shion',
          gender: 'female',
          personality: ['warrior', 'fierce'],
        }),
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const map = new VoiceCaster().buildVoiceMap(glossary);
    expect(Object.keys(map.mappings)).toEqual(
      expect.arrayContaining([
        'narrator',
        'system',
        'crowd',
        'Rimuru',
        'Veldora',
        'Shion',
      ]),
    );
    for (const v of Object.values(map.mappings)) {
      expect(v.components.reduce((s, c) => s + c.weight, 0)).toBe(100);
    }
  });

  it('overrideVoice bumps voiceVersion', () => {
    const glossary: CharacterGlossary = {
      novelId: 't',
      narratorGender: 'male',
      narratorVoiceHints: [],
      characters: [mockChar({ name: 'A', gender: 'female' })],
      createdAt: '',
      updatedAt: '',
    };
    const caster = new VoiceCaster();
    const map = caster.buildVoiceMap(glossary);
    const before = map.mappings.A.voiceVersion;
    const next = caster.overrideVoice(map, 'A', {
      label: 'A',
      components: [{ voiceId: 'af_bella', weight: 100 }],
      speed: 1.0,
    });
    expect(next.mappings.A.voiceVersion).toBe(before + 1);
  });

  it('extendVoiceMap preserves existing entries', () => {
    const glossary: CharacterGlossary = {
      novelId: 't',
      narratorGender: 'male',
      narratorVoiceHints: [],
      characters: [mockChar({ name: 'A', gender: 'female' })],
      createdAt: '',
      updatedAt: '',
    };
    const caster = new VoiceCaster();
    const map = caster.buildVoiceMap(glossary);
    const originalA = map.mappings.A;
    const extended = caster.extendVoiceMap(map, [
      mockChar({ name: 'B', gender: 'male' }),
    ]);
    expect(extended.mappings.A).toBe(originalA);
    expect(extended.mappings.B).toBeDefined();
  });
});
