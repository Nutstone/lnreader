/**
 * LLM annotator.
 *
 * Two providers:
 *   - "anthropic": Claude (default). Uses prompt caching + structured
 *     output via tool_choice to remove parsing fragility.
 *   - "ollama": local fallback. Plain JSON-mode chat.
 *
 * Retries 429/503 with bounded exponential backoff; surfaces other
 * errors verbatim. Records token usage for cost reporting.
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
  buildGlossarySummary,
} from './prompts/chapterAnnotator';
import {
  GLOSSARY_SYSTEM_PROMPT,
  GLOSSARY_TOOL_DESCRIPTION,
  GLOSSARY_TOOL_INPUT_SCHEMA,
  GLOSSARY_TOOL_NAME,
  GLOSSARY_UPDATE_SYSTEM_PROMPT,
  buildGlossaryPromptUserMessage,
  buildGlossaryUpdateUserMessage,
} from './prompts/glossaryBuilder';
import { parseLLMJSON } from './streamingParser';
import { recommendedModelFor } from './pricing';
import { chapterKeyFor } from './chapterPath';

const LLM_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

interface AnnotatorEvents {
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  onUsage?: (
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
  ) => void;
}

interface CallResult<T> {
  data: T;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export class LLMAnnotator {
  private config: LLMConfig;
  private events: AnnotatorEvents;

  constructor(config: LLMConfig, events: AnnotatorEvents = {}) {
    this.config = config;
    this.events = events;
  }

  // ── Public API ──────────────────────────────────────────────────

  async buildGlossary(
    novelId: string,
    chapterSample: string[],
  ): Promise<CharacterGlossary> {
    this.requireKeyForCloud();
    const userMessage = buildGlossaryPromptUserMessage({ chapterSample });
    const { data } = await this.callTool<{
      narratorGender: 'male' | 'female' | 'neutral';
      narratorVoiceHints: string[];
      characters: Character[];
    }>({
      systemPrompt: GLOSSARY_SYSTEM_PROMPT,
      userMessage,
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
        userOverridden: false,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async extendGlossary(
    existing: CharacterGlossary,
    newSpeakers: string[],
    recentExcerpts: string[],
  ): Promise<Character[]> {
    this.requireKeyForCloud();
    const userMessage = buildGlossaryUpdateUserMessage({
      existing,
      newSpeakers,
      recentExcerpts,
    });
    const { data } = await this.callTool<{
      narratorGender?: 'male' | 'female' | 'neutral';
      narratorVoiceHints?: string[];
      characters: Character[];
    }>({
      systemPrompt: GLOSSARY_UPDATE_SYSTEM_PROMPT,
      userMessage,
      toolName: GLOSSARY_TOOL_NAME,
      toolDescription: GLOSSARY_TOOL_DESCRIPTION,
      toolInputSchema: GLOSSARY_TOOL_INPUT_SCHEMA,
    });
    return (data.characters ?? []).map(c => ({
      ...c,
      voiceHints: c.voiceHints ?? [],
      userOverridden: false,
    }));
  }

  async annotateChapter(
    chapterId: number,
    chapterPath: string,
    chapterText: string,
    glossary: CharacterGlossary,
  ): Promise<ChapterAnnotation> {
    this.requireKeyForCloud();
    const userMessage = buildAnnotationUserMessage(glossary, chapterText);
    const { data, usage } = await this.callTool<{ segments: AnnotatedSegment[] }>(
      {
        systemPrompt: ANNOTATION_SYSTEM_PROMPT,
        userMessage,
        toolName: ANNOTATION_TOOL_NAME,
        toolDescription: ANNOTATION_TOOL_DESCRIPTION,
        toolInputSchema: ANNOTATION_TOOL_INPUT_SCHEMA,
      },
    );
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
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
      },
    };
  }

  // ── Provider dispatch ───────────────────────────────────────────

  private async callTool<T>(req: {
    systemPrompt: string;
    userMessage: string;
    toolName: string;
    toolDescription: string;
    toolInputSchema: Record<string, unknown>;
  }): Promise<CallResult<T>> {
    if (this.config.provider === 'anthropic') {
      return this.callAnthropic<T>(req);
    }
    return this.callOllama<T>(req);
  }

  // ── Anthropic ───────────────────────────────────────────────────

  private async callAnthropic<T>(req: {
    systemPrompt: string;
    userMessage: string;
    toolName: string;
    toolDescription: string;
    toolInputSchema: Record<string, unknown>;
  }): Promise<CallResult<T>> {
    const model = this.config.model || recommendedModelFor('anthropic').model;
    const useCache = this.config.enablePromptCaching !== false;
    const systemBlocks: Array<Record<string, unknown>> = useCache
      ? [
          {
            type: 'text',
            text: req.systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : [{ type: 'text', text: req.systemPrompt }];

    const body = {
      model,
      max_tokens: 8192,
      system: systemBlocks,
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

    // Pull the tool_use block.
    const toolUse = (data.content ?? []).find(
      (c: { type: string }) => c.type === 'tool_use',
    );
    if (!toolUse || !toolUse.input) {
      // Fall back: try text block + JSON parse (defensive).
      const textBlock = (data.content ?? []).find(
        (c: { type: string }) => c.type === 'text',
      );
      if (!textBlock) {
        throw new Error('Anthropic response had no tool_use or text block.');
      }
      return {
        data: parseLLMJSON<T>(textBlock.text),
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    }

    const usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
    this.events.onUsage?.(usage.inputTokens, usage.cachedInputTokens, usage.outputTokens);
    return { data: toolUse.input as T, usage };
  }

  // ── Ollama ──────────────────────────────────────────────────────

  private async callOllama<T>(req: {
    systemPrompt: string;
    userMessage: string;
    toolName: string;
    toolDescription: string;
    toolInputSchema: Record<string, unknown>;
  }): Promise<CallResult<T>> {
    const model = this.config.model || recommendedModelFor('ollama').model;
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const url = `${baseUrl.replace(/\/+$/, '')}/api/chat`;

    // Ollama doesn't have native tool_choice on every model; ask for
    // strict JSON instead, with the schema embedded in the system prompt.
    const enrichedSystem = [
      req.systemPrompt,
      '',
      'Output STRICT JSON matching this schema (no prose, no fences):',
      JSON.stringify(req.toolInputSchema),
    ].join('\n');

    const body = {
      model,
      stream: false,
      format: 'json',
      keep_alive: '1h',
      messages: [
        { role: 'system', content: enrichedSystem },
        { role: 'user', content: req.userMessage },
      ],
    };

    const data = await this.withRetry(async () => {
      const response = await fetchTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        LLM_TIMEOUT_MS * 2,
      );

      if (!response.ok) {
        const text = await safeText(response);
        const status = response.status;
        if (status === 429 || status === 503) {
          throw new RetryableError(`Ollama ${status}: ${text}`);
        }
        throw new Error(`Ollama ${status}: ${text}`);
      }

      const json = await response.json();
      if (json.error) {
        throw new Error(`Ollama API error: ${json.error}`);
      }
      return json;
    });

    const text = data.message?.content ?? '';
    const parsed = parseLLMJSON<T>(text);
    const usage = {
      inputTokens: data.prompt_eval_count ?? 0,
      cachedInputTokens: 0,
      outputTokens: data.eval_count ?? 0,
    };
    this.events.onUsage?.(usage.inputTokens, 0, usage.outputTokens);
    return { data: parsed, usage };
  }

  // ── Internals ───────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof RetryableError && attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt] + Math.random() * 500;
          this.events.onRetry?.(attempt + 1, delay, (e as Error).message);
          await sleep(delay);
          continue;
        }
        throw e;
      }
    }
    throw new Error('Unreachable retry loop');
  }

  private requireKeyForCloud() {
    if (this.config.provider === 'anthropic' && !this.config.apiKey) {
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

// Small wrapper used by callers that don't care about glossary summary
// (e.g. cost estimation / token counting).
export { buildGlossarySummary };
