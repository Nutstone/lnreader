import { fetchTimeout } from '@utils/fetch/fetch';
import {
  LLMConfig,
  CharacterGlossary,
  ChapterAnnotation,
  AnnotatedSegment,
  Character,
} from './types';
import { buildGlossaryPrompt } from './prompts/glossaryBuilder';
import { buildAnnotationPrompt } from './prompts/chapterAnnotator';

const DEFAULT_MODELS: Record<LLMConfig['provider'], string> = {
  anthropic: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.1:8b',
};

const LLM_TIMEOUT = 60000;

export class LLMAnnotator {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async buildGlossary(
    novelId: string,
    chapterTexts: string[],
  ): Promise<CharacterGlossary> {
    if (!this.config.apiKey) {
      throw new Error(
        'LLM API key is not configured. Please set it in Audiobook Settings.',
      );
    }

    const prompt = buildGlossaryPrompt(chapterTexts);
    const response = await this.callLLM(prompt.system, prompt.user);
    const parsed = this.parseJSON<{
      characters: Character[];
      narratorGender: 'male' | 'female';
    }>(response);

    if (!Array.isArray(parsed.characters)) {
      throw new Error(
        'LLM returned invalid glossary: missing "characters" array',
      );
    }

    return {
      novelId,
      characters: parsed.characters,
      narratorGender: parsed.narratorGender || 'male',
      createdAt: new Date().toISOString(),
    };
  }

  async annotateChapter(
    chapterId: number,
    chapterText: string,
    glossary: CharacterGlossary,
  ): Promise<ChapterAnnotation> {
    if (!this.config.apiKey) {
      throw new Error(
        'LLM API key is not configured. Please set it in Audiobook Settings.',
      );
    }

    const prompt = buildAnnotationPrompt(chapterText, glossary, chapterId);
    const response = await this.callLLM(prompt.system, prompt.user);
    const parsed = this.parseJSON<{ segments: AnnotatedSegment[] }>(response);

    if (!Array.isArray(parsed.segments)) {
      throw new Error(
        'LLM returned invalid annotation: missing "segments" array',
      );
    }

    return {
      chapterId,
      segments: parsed.segments,
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

  private async callAnthropic(system: string, user: string): Promise<string> {
    const model = this.config.model || DEFAULT_MODELS.anthropic;
    const response = await fetchTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      },
      LLM_TIMEOUT,
    );

    const data = await response.json();
    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.message}`);
    }
    return data.content[0].text;
  }

  private async callGemini(system: string, user: string): Promise<string> {
    const model = this.config.model || DEFAULT_MODELS.gemini;
    const baseUrl =
      this.config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseUrl}/models/${model}:generateContent?key=${this.config.apiKey}`;

    const response = await fetchTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 8192 },
        }),
      },
      LLM_TIMEOUT,
    );

    const data = await response.json();
    if (data.error) {
      throw new Error(`Gemini API error: ${data.error.message}`);
    }
    return data.candidates[0].content.parts[0].text;
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
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      LLM_TIMEOUT * 2,
    );

    const data = await response.json();
    if (data.error) {
      throw new Error(`Ollama API error: ${data.error}`);
    }
    return data.message.content;
  }

  private parseJSON<T>(text: string): T {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
    return JSON.parse(jsonStr) as T;
  }
}
