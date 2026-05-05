export const GLOSSARY_TOOL_NAME = 'emit_glossary';
export const GLOSSARY_TOOL_DESCRIPTION =
  'Emit the character glossary extracted from the chapter sample.';

export const GLOSSARY_TOOL_INPUT_SCHEMA = {
  type: 'object',
  required: ['narratorGender', 'narratorVoiceHints', 'characters'],
  properties: {
    narratorGender: {
      type: 'string',
      enum: ['male', 'female', 'neutral'],
      description: 'Apparent gender of the narrator (the reading voice).',
    },
    narratorVoiceHints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'How the narrator should SOUND. 2-4 audio descriptors like "calm", "warm", "measured".',
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'name',
          'aliases',
          'gender',
          'personality',
          'voiceHints',
          'description',
        ],
        properties: {
          name: { type: 'string', description: 'Most common name.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Other names referencing this character.',
          },
          gender: {
            type: 'string',
            enum: ['male', 'female', 'neutral'],
          },
          personality: {
            type: 'array',
            items: { type: 'string' },
            description:
              'How the character ACTS. 2-5 keywords like "warrior", "wise", "playful".',
          },
          voiceHints: {
            type: 'array',
            items: { type: 'string' },
            description:
              'How the character SOUNDS. 1-3 audio descriptors like "deep", "high", "raspy".',
          },
          description: {
            type: 'string',
            description: 'One-sentence summary of the character.',
          },
        },
      },
    },
  },
} as const;

export const GLOSSARY_SYSTEM_PROMPT = `You are a literary analyst specialising in light novels and web novels. Your task is to extract a character glossary from a sample of chapter text.

Identify named characters who speak or are referenced by name. For each character determine:
- The most common name (e.g. "Rimuru" not "Rimuru Tempest" unless the full name is more frequent).
- Aliases / titles / alternate forms ("Sage", "Slime-san").
- Gender — male, female, or neutral if truly ambiguous.
- Personality keywords (2-5) describing how the character ACTS.
- Voice hints (1-3) describing how the character SOUNDS — e.g. "deep", "raspy", "high", "musical", "rapid", "monotone".
- A one-sentence description.

Also determine the narrator's apparent gender and 2-4 voice hints for the narrator.

Order characters by frequency of appearance (most frequent first). Include only named characters who appear meaningfully — skip background mentions and one-line walk-ons.

Input may contain noise: raw HTML tags, HTML entities, translator
notes ("[T/N: ...]"), author's notes, footnotes ("[1]"), and
translator boilerplate (Patreon, donate, "next chapter"). Ignore all
of it when extracting characters.

Respond by calling the emit_glossary tool with structured arguments. Do NOT respond with prose.`;

export interface BuildGlossaryPromptArgs {
  chapterSample: string[];
}

export function buildGlossaryPromptUserMessage(
  args: BuildGlossaryPromptArgs,
): string {
  const combined = args.chapterSample
    .map((text, i) => `--- Chapter ${i + 1} ---\n${text}`)
    .join('\n\n');
  return `Extract a character glossary from this chapter sample:\n\n${combined}`;
}

/**
 * Mini glossary update prompt — used when new speakers appear mid-novel.
 */
export const GLOSSARY_UPDATE_SYSTEM_PROMPT = `You are extending an existing character glossary. New speakers have been seen in recent chapters. Add them to the glossary using the same fields as the original.

Use the same emit_glossary tool. Output ONLY the new characters — not the existing ones. Keep voice hints and personality 1-3 keywords each.`;

export interface UpdateGlossaryArgs {
  existing: import('../types').CharacterGlossary;
  newSpeakers: string[];
  recentExcerpts: string[];
}

export function buildGlossaryUpdateUserMessage(
  args: UpdateGlossaryArgs,
): string {
  const knownNames = args.existing.characters
    .flatMap(c => [c.name, ...c.aliases])
    .join(', ');
  return [
    `Existing characters (do not re-emit): ${knownNames}`,
    '',
    `New speakers seen recently: ${args.newSpeakers.join(', ')}`,
    '',
    'Recent excerpts:',
    ...args.recentExcerpts.map((e, i) => `--- Excerpt ${i + 1} ---\n${e}`),
  ].join('\n');
}
