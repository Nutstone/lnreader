import { fetchTimeout } from '@utils/fetch/fetch';
import {
  LLMConfig,
  CharacterGlossary,
  ChapterAnnotation,
  AnnotatedSegment,
  Character,
  Emotion,
} from './types';
import { buildGlossaryPrompt } from './prompts/glossaryBuilder';
import { buildAnnotationPrompt } from './prompts/chapterAnnotator';

const DEFAULT_MODELS: Record<LLMConfig['provider'], string> = {
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.1:8b',
};

const LLM_TIMEOUT = 120000;

// Annotation output must re-emit the entire chunk text inside JSON, so
// chunks are sized to keep each response well under the output-token cap.
const MAX_CHUNK_CHARS = 8000;

const VALID_EMOTIONS: Emotion[] = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'surprised',
  'whisper',
];

const VALID_PAUSES = ['short', 'medium', 'long'] as const;

export class LLMAnnotator {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async buildGlossary(
    novelId: string,
    chapterTexts: string[],
  ): Promise<CharacterGlossary> {
    const prompt = buildGlossaryPrompt(chapterTexts);
    const response = await this.callLLM(prompt.system, prompt.user);
    const parsed = this.parseJSON<{
      characters: unknown;
      narratorGender: unknown;
    }>(response);

    return {
      novelId,
      characters: this.sanitizeCharacters(parsed.characters),
      narratorGender: parsed.narratorGender === 'female' ? 'female' : 'male',
      createdAt: new Date().toISOString(),
    };
  }

  async annotateChapter(
    chapterId: number,
    chapterText: string,
    glossary: CharacterGlossary,
  ): Promise<ChapterAnnotation> {
    const segments: AnnotatedSegment[] = [];
    for (const chunk of this.splitIntoChunks(chapterText)) {
      const prompt = buildAnnotationPrompt(chunk, glossary, chapterId);
      const response = await this.callLLM(prompt.system, prompt.user);
      const parsed = this.parseJSON<{ segments: unknown }>(response);
      segments.push(...this.sanitizeSegments(parsed.segments));
    }

    return {
      chapterId,
      segments,
      createdAt: new Date().toISOString(),
    };
  }

  private async callLLM(
    systemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    switch (this.config.provider) {
      case 'anthropic':
        return this.callAnthropic(systemPrompt, userMessage);
      case 'gemini':
        return this.callGemini(systemPrompt, userMessage);
      case 'ollama':
        return this.callOllama(systemPrompt, userMessage);
    }
  }

  private requireApiKey(): string {
    if (!this.config.apiKey) {
      throw new Error(
        'LLM API key is not configured. Please set it in Audiobook Settings.',
      );
    }
    return this.config.apiKey;
  }

  private async assertOk(response: Response, provider: string): Promise<void> {
    if (response.ok) {
      return;
    }
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.error || '';
    } catch {}
    throw new Error(
      `${provider} request failed (HTTP ${response.status})${
        detail ? `: ${detail}` : ''
      }`,
    );
  }

  private async callAnthropic(system: string, user: string): Promise<string> {
    const model = this.config.model || DEFAULT_MODELS.anthropic;
    const response = await fetchTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.requireApiKey(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      },
      LLM_TIMEOUT,
    );

    await this.assertOk(response, 'Anthropic');
    const data = await response.json();
    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.message}`);
    }
    const text = data.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(
        `Anthropic returned no text (stop_reason: ${
          data.stop_reason ?? 'unknown'
        })`,
      );
    }
    return text;
  }

  private async callGemini(system: string, user: string): Promise<string> {
    const model = this.config.model || DEFAULT_MODELS.gemini;
    const baseUrl =
      this.config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseUrl}/models/${model}:generateContent`;

    const response = await fetchTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.requireApiKey(),
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 8192 },
        }),
      },
      LLM_TIMEOUT,
    );

    await this.assertOk(response, 'Gemini');
    const data = await response.json();
    if (data.error) {
      throw new Error(`Gemini API error: ${data.error.message}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') {
      // Safety blocks return an empty candidate or none at all
      const reason =
        data.promptFeedback?.blockReason ??
        data.candidates?.[0]?.finishReason ??
        'unknown';
      throw new Error(`Gemini returned no text (reason: ${reason})`);
    }
    return text;
  }

  private async callOllama(system: string, user: string): Promise<string> {
    const model = this.config.model || DEFAULT_MODELS.ollama;
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const url = `${baseUrl}/api/chat`;

    const response = await fetchTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          // Ollama defaults to a small context window and silently
          // truncates the prompt without this.
          options: { num_ctx: 16384 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      LLM_TIMEOUT * 2,
    );

    await this.assertOk(response, 'Ollama');
    const data = await response.json();
    if (data.error) {
      throw new Error(`Ollama API error: ${data.error}`);
    }
    const text = data.message?.content;
    if (typeof text !== 'string') {
      throw new Error('Ollama returned no message content');
    }
    return text;
  }

  // ── Chunking ────────────────────────────────────────────────

  private splitIntoChunks(text: string): string[] {
    if (text.length <= MAX_CHUNK_CHARS) {
      return [text];
    }
    const chunks: string[] = [];
    let current = '';
    for (const paragraph of text.split(/\n{2,}/)) {
      if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = '';
      }
      // A single paragraph longer than the limit is split hard.
      if (paragraph.length > MAX_CHUNK_CHARS) {
        for (let i = 0; i < paragraph.length; i += MAX_CHUNK_CHARS) {
          chunks.push(paragraph.slice(i, i + MAX_CHUNK_CHARS));
        }
        continue;
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  }

  // ── Response Parsing & Sanitization ─────────────────────────

  private parseJSON<T>(text: string): T {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const braced =
      start !== -1 && end > start ? text.slice(start, end + 1) : null;

    for (const candidate of [fenced, text.trim(), braced]) {
      if (!candidate) {
        continue;
      }
      try {
        return JSON.parse(candidate) as T;
      } catch {}
    }
    throw new Error(
      `LLM returned malformed JSON (response may have been truncated): ${text.slice(
        0,
        200,
      )}`,
    );
  }

  private sanitizeSegments(raw: unknown): AnnotatedSegment[] {
    if (!Array.isArray(raw)) {
      throw new Error(
        'LLM returned invalid annotation: missing "segments" array',
      );
    }
    const segments: AnnotatedSegment[] = [];
    for (const item of raw) {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) {
        continue;
      }
      segments.push({
        text: item.text,
        speaker:
          typeof item.speaker === 'string' && item.speaker.trim()
            ? item.speaker.trim()
            : 'narrator',
        emotion: VALID_EMOTIONS.includes(item.emotion)
          ? item.emotion
          : 'neutral',
        isDialogue: item.isDialogue === true,
        pauseBefore: VALID_PAUSES.includes(item.pauseBefore)
          ? item.pauseBefore
          : 'medium',
      });
    }
    return segments;
  }

  private sanitizeCharacters(raw: unknown): Character[] {
    if (!Array.isArray(raw)) {
      throw new Error(
        'LLM returned invalid glossary: missing "characters" array',
      );
    }
    const characters: Character[] = [];
    for (const item of raw) {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) {
        continue;
      }
      characters.push({
        name: item.name.trim(),
        aliases: Array.isArray(item.aliases)
          ? item.aliases.filter(
              (a: unknown): a is string => typeof a === 'string' && !!a.trim(),
            )
          : [],
        gender:
          item.gender === 'male' || item.gender === 'female'
            ? item.gender
            : 'neutral',
        personality: Array.isArray(item.personality)
          ? item.personality.filter(
              (p: unknown): p is string => typeof p === 'string',
            )
          : [],
        description:
          typeof item.description === 'string' ? item.description : '',
        importance:
          typeof item.importance === 'number' &&
          Number.isFinite(item.importance)
            ? item.importance
            : undefined,
      });
    }
    return characters;
  }
}
