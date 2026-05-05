import { LLMMessage } from '../types';

const SYSTEM_PROMPT = `You are a literary analyst specializing in light novels and web novels. Your task is to extract a character glossary from the provided chapter text.

Analyze the text and identify all named characters. For each character, determine:
1. Their primary name (most commonly used)
2. Any aliases, titles, or alternate names
3. Their gender (male, female, or neutral if unclear)
4. Personality keywords (2-5 words like: warrior, gentle, villainous, cheerful, stoic, wise, mischievous, noble, shy, aggressive, cold, warm, cunning, innocent, mature)
5. A brief description (1 sentence)
6. An importance score from 0 to 100 reflecting how central they are to the story

Also determine the narrator's apparent gender based on writing style and perspective.

Respond with ONLY valid JSON matching this exact schema:
{
  "characters": [
    {
      "name": "string",
      "aliases": ["string"],
      "gender": "male" | "female" | "neutral",
      "personality": ["string"],
      "description": "string",
      "importance": number
    }
  ],
  "narratorGender": "male" | "female"
}

Guidelines:
- Include only characters who speak or are referenced by name
- Use the most common name form (e.g., "Rimuru" not "Rimuru Tempest" unless the full name is used more often)
- Personality keywords should reflect how they SOUND when speaking, not just their role
- If gender is truly ambiguous, use "neutral"
- Order characters by importance (most central first)
- Importance scoring:
  - 90-100: protagonist or co-protagonist, drives the story
  - 70-89: major recurring character, frequent dialogue
  - 40-69: supporting character, occasional dialogue
  - 1-39: minor or one-off character
  - The TTS engine reserves richer emotional voices for high-importance characters, so be discriminating.`;

export function buildGlossaryPrompt(chapterTexts: string[]): LLMMessage {
  const combined = chapterTexts
    .map((text, i) => `--- Chapter ${i + 1} ---\n${text}`)
    .join('\n\n');

  return {
    system: SYSTEM_PROMPT,
    user: `Extract a character glossary from these chapter(s):\n\n${combined}`,
  };
}
