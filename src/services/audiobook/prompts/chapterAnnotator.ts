import { CharacterGlossary } from '../types';

export const ANNOTATION_TOOL_NAME = 'emit_annotation';
export const ANNOTATION_TOOL_DESCRIPTION =
  'Emit the segmented chapter annotation for TTS rendering.';

export const ANNOTATION_TOOL_INPUT_SCHEMA = {
  type: 'object',
  required: ['segments'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'text',
          'speaker',
          'emotion',
          'intensity',
          'isDialogue',
          'pauseBefore',
        ],
        properties: {
          text: {
            type: 'string',
            description: 'Exact text of this segment, preserving wording.',
          },
          speaker: {
            type: 'string',
            description:
              'Speaker name from the glossary, or "narrator" / "system" / "crowd".',
          },
          emotion: {
            type: 'string',
            enum: [
              'neutral',
              'happy',
              'sad',
              'angry',
              'fearful',
              'surprised',
              'whisper',
              'shouting',
              'amused',
              'tender',
              'cold',
              'distressed',
            ],
          },
          intensity: {
            type: 'integer',
            minimum: 1,
            maximum: 3,
            description:
              '1 = subtle, 2 = clear, 3 = extreme. Defaults to 2 when uncertain.',
          },
          isDialogue: { type: 'boolean' },
          pauseBefore: {
            type: 'string',
            enum: ['short', 'medium', 'long'],
          },
        },
      },
    },
  },
} as const;

export const ANNOTATION_SYSTEM_PROMPT = `You are an audiobook director. Your task is to segment a chapter for multi-voice TTS rendering.

Break the chapter into segments. Each segment is one of:
- Narration: speaker = "narrator".
- Dialogue: speaker = the speaking character (use the glossary name).
- Internal monologue: speaker = the character thinking; isDialogue = false.
- System/status text (LitRPG): speaker = "system".

For each segment determine:
1. Exact text (preserve original wording, including quote marks).
2. Speaker (from the glossary, or one of: "narrator", "system", "crowd").
3. Emotion: how the segment should SOUND.
4. Intensity: 1 = subtle, 2 = clear, 3 = extreme.
5. isDialogue: true if it's spoken aloud (in quote marks).
6. pauseBefore: silence before this segment.
   - "short" between consecutive narration sentences.
   - "medium" at paragraph or speaker change.
   - "long" at scene break.

Examples:

Input: \`"I'll kill you!" he hissed, knuckles white.\`
Output:
- {text: "\\"I'll kill you!\\"", speaker: "Kael", emotion: "angry", intensity: 3, isDialogue: true, pauseBefore: "medium"}
- {text: "he hissed, knuckles white.", speaker: "narrator", emotion: "neutral", intensity: 2, isDialogue: false, pauseBefore: "short"}

Input: \`Rimuru smiled. "It's nothing," he said softly.\`
Output:
- {text: "Rimuru smiled.", speaker: "narrator", emotion: "happy", intensity: 1, isDialogue: false, pauseBefore: "medium"}
- {text: "\\"It's nothing,\\"", speaker: "Rimuru", emotion: "tender", intensity: 1, isDialogue: true, pauseBefore: "short"}
- {text: "he said softly.", speaker: "narrator", emotion: "neutral", intensity: 1, isDialogue: false, pauseBefore: "short"}

Guidelines:
- Keep segments 1-4 sentences for natural TTS pacing.
- Use the speaker name EXACTLY as it appears in the glossary.
- For unnamed speakers, use "crowd" if it's a generic group, otherwise "narrator".
- Don't invent character names — if you don't know who's speaking, use "narrator".
- Combine very short narration ("he said") with adjacent dialogue when natural.
- Emotion describes how to SAY it, not what is described. "She watched the sunset" = neutral, not happy.

Respond by calling the emit_annotation tool with structured arguments. Do NOT respond with prose.`;

export function buildAnnotationUserMessage(
  glossary: CharacterGlossary,
  chapterText: string,
): string {
  const characters = glossary.characters
    .map(c => `- ${c.name} (${c.gender}): ${c.description}`)
    .join('\n');
  return [
    `Narrator: ${glossary.narratorGender}, hints: ${glossary.narratorVoiceHints.join(', ') || '—'}`,
    '',
    'Characters:',
    characters || '(none yet)',
    '',
    'Annotate this chapter:',
    '',
    chapterText,
  ].join('\n');
}
