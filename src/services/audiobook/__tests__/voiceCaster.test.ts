import {
  matchArchetype,
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

describe('blendString', () => {
  it('serialises components as id:weight,id:weight', () => {
    expect(
      blendString({
        label: 'x',
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
  it('returns a 3-component recipe summing to 100', () => {
    const r = buildRecipeForArchetype('warrior', 'female');
    expect(r).toHaveLength(3);
    expect(r.reduce((s, c) => s + c.weight, 0)).toBe(100);
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
});
