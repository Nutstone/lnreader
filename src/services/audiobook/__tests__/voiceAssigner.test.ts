import { VoiceAssigner } from '../voiceAssigner';
import { DEFAULT_NARRATOR_SPEAKER_ID, EMOTIONAL_SPEAKERS } from '../voiceBank';
import { Character, CharacterGlossary } from '../types';

const makeCharacter = (overrides: Partial<Character> = {}): Character => ({
  name: 'Alice',
  aliases: [],
  gender: 'female',
  personality: ['brave'],
  description: 'A brave fighter',
  importance: 5,
  ...overrides,
});

const makeGlossary = (characters: Character[]): CharacterGlossary => ({
  novelId: '1',
  characters,
  narratorGender: 'male',
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('VoiceAssigner', () => {
  it('locks the narrator to the default emotional speaker', () => {
    const assigner = new VoiceAssigner();
    const voiceMap = assigner.buildVoiceMap(makeGlossary([]));
    expect(voiceMap.mappings.narrator).toEqual(
      expect.objectContaining({
        kind: 'emotional',
        speakerId: DEFAULT_NARRATOR_SPEAKER_ID,
      }),
    );
  });

  it('gives top characters emotional speakers and the rest donation voices', () => {
    const assigner = new VoiceAssigner({ mainCharacterEmotionalSlots: 1 });
    const voiceMap = assigner.buildVoiceMap(
      makeGlossary([
        makeCharacter({ name: 'Hero', importance: 10 }),
        makeCharacter({ name: 'Extra', importance: 1, gender: 'male' }),
      ]),
    );
    expect(voiceMap.mappings.Hero.kind).toBe('emotional');
    expect(voiceMap.mappings.Extra.kind).toBe('donation');
  });

  it('never assigns the narrator speaker to a character', () => {
    const assigner = new VoiceAssigner({
      mainCharacterEmotionalSlots: EMOTIONAL_SPEAKERS.length,
    });
    const many = Array.from({ length: EMOTIONAL_SPEAKERS.length }, (_, i) =>
      makeCharacter({ name: `C${i}`, importance: 100 - i }),
    );
    const voiceMap = assigner.buildVoiceMap(makeGlossary(many));
    for (const [name, assignment] of Object.entries(voiceMap.mappings)) {
      if (name === 'narrator' || assignment.kind !== 'emotional') {
        continue;
      }
      expect(assignment.speakerId).not.toBe(DEFAULT_NARRATOR_SPEAKER_ID);
    }
  });

  it('maps aliases to the same assignment as the primary name', () => {
    const assigner = new VoiceAssigner();
    const voiceMap = assigner.buildVoiceMap(
      makeGlossary([
        makeCharacter({ name: 'Rimuru', aliases: ['Rimuru Tempest', 'Slime'] }),
      ]),
    );
    expect(voiceMap.mappings['Rimuru Tempest']).toBe(voiceMap.mappings.Rimuru);
    expect(voiceMap.mappings.Slime).toBe(voiceMap.mappings.Rimuru);
  });

  it('assigns donation voices deterministically by character name', () => {
    const assigner = new VoiceAssigner({ mainCharacterEmotionalSlots: 0 });
    const glossary = makeGlossary([makeCharacter({ name: 'Sidekick' })]);
    const first = assigner.buildVoiceMap(glossary);
    const second = assigner.buildVoiceMap(glossary);
    expect(first.mappings.Sidekick).toEqual(second.mappings.Sidekick);
  });
});
