/**
 * Claude annotator.
 *
 * Single provider (Anthropic). Structured output via tool_choice so we
 * don't have to parse free-form JSON. Retries 429/503 with bounded
 * exponential backoff; surfaces other errors verbatim.
 */

import { fetchTimeout } from '@utils/fetch/fetch';
import { sleep } from '@utils/sleep';
import {
  AnnotatedSegment,
  Character,
  CharacterGlossary,
  ChapterAnnotation,
  LLMConfig,
} from './types';
import {
  ANNOTATION_SYSTEM_PROMPT,
  ANNOTATION_TOOL_DESCRIPTION,
  ANNOTATION_TOOL_INPUT_SCHEMA,
  ANNOTATION_TOOL_NAME,
  buildAnnotationUserMessage,
} from './prompts/chapterAnnotator';
import {
  GLOSSARY_SYSTEM_PROMPT,
  GLOSSARY_TOOL_DESCRIPTION,
  GLOSSARY_TOOL_INPUT_SCHEMA,
  GLOSSARY_TOOL_NAME,
  buildGlossaryPromptUserMessage,
} from './prompts/glossaryBuilder';
import { chapterKeyFor } from './chapterPath';

const LLM_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const DEFAULT_MODEL = 'claude-sonnet-4-6';

interface ToolCall<T> {
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  toolInputSchema: Record<string, unknown>;
}

export class LLMAnnotator {
  constructor(private config: LLMConfig) {}

  async buildGlossary(
    novelId: string,
    chapterSample: string[],
  ): Promise<CharacterGlossary> {
    this.requireKey();
    const data = await this.callTool<{
      narratorGender: 'male' | 'female' | 'neutral';
      narratorVoiceHints: string[];
      characters: Character[];
    }>({
      systemPrompt: GLOSSARY_SYSTEM_PROMPT,
      userMessage: buildGlossaryPromptUserMessage({ chapterSample }),
      toolName: GLOSSARY_TOOL_NAME,
      toolDescription: GLOSSARY_TOOL_DESCRIPTION,
      toolInputSchema: GLOSSARY_TOOL_INPUT_SCHEMA,
    });
    if (!Array.isArray(data.characters)) {
      throw new Error('LLM returned invalid glossary: missing characters array.');
    }
    return {
      novelId,
      narratorGender: data.narratorGender ?? 'male',
      narratorVoiceHints: data.narratorVoiceHints ?? [],
      characters: data.characters.map(c => ({
        ...c,
        voiceHints: c.voiceHints ?? [],
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async annotateChapter(
    chapterId: number,
    chapterPath: string,
    chapterText: string,
    glossary: CharacterGlossary,
  ): Promise<ChapterAnnotation> {
    this.requireKey();
    const data = await this.callTool<{ segments: AnnotatedSegment[] }>({
      systemPrompt: ANNOTATION_SYSTEM_PROMPT,
      userMessage: buildAnnotationUserMessage(glossary, chapterText),
      toolName: ANNOTATION_TOOL_NAME,
      toolDescription: ANNOTATION_TOOL_DESCRIPTION,
      toolInputSchema: ANNOTATION_TOOL_INPUT_SCHEMA,
    });
    if (!Array.isArray(data.segments)) {
      throw new Error('LLM returned invalid annotation: missing segments array.');
    }
    return {
      chapterId,
      chapterKey: chapterKeyFor(chapterPath),
      segments: data.segments.map(s => ({
        text: s.text ?? '',
        speaker: s.speaker || 'narrator',
        emotion: s.emotion ?? 'neutral',
        intensity: (s.intensity ?? 2) as 1 | 2 | 3,
        isDialogue: !!s.isDialogue,
        pauseBefore: s.pauseBefore ?? 'short',
      })),
      createdAt: new Date().toISOString(),
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  private async callTool<T>(req: ToolCall<T>): Promise<T> {
    const model = this.config.model || DEFAULT_MODEL;
    const body = {
      model,
      max_tokens: 8192,
      system: req.systemPrompt,
      tools: [
        {
          name: req.toolName,
          description: req.toolDescription,
          input_schema: req.toolInputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: req.toolName },
      messages: [{ role: 'user', content: req.userMessage }],
    };

    const data = await this.withRetry(async () => {
      const response = await fetchTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey ?? '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        },
        LLM_TIMEOUT_MS,
      );
      if (!response.ok) {
        const text = await safeText(response);
        const status = response.status;
        if (status === 429 || status === 503) {
          throw new RetryableError(`Anthropic ${status}: ${text}`);
        }
        throw new Error(`Anthropic ${status}: ${text}`);
      }
      const json = await response.json();
      if (json.error) {
        throw new Error(`Anthropic API error: ${json.error.message}`);
      }
      return json;
    });

    const toolUse = (data.content ?? []).find(
      (c: { type: string }) => c.type === 'tool_use',
    );
    if (!toolUse?.input) {
      throw new Error('Anthropic response had no tool_use block.');
    }
    return toolUse.input as T;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof RetryableError && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt] + Math.random() * 500);
          continue;
        }
        throw e;
      }
    }
    throw new Error('Unreachable retry loop');
  }

  private requireKey() {
    if (!this.config.apiKey) {
      throw new Error(
        'Claude API key is not configured. Open Audiobook Settings to add one.',
      );
    }
  }
}

class RetryableError extends Error {}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
