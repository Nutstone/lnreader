/**
 * LLMAnnotator integration tests with mocked fetch.
 * Validates request shape against Anthropic + Ollama APIs.
 */

import { LLMAnnotator } from '../llmAnnotator';

jest.mock('@utils/fetch/fetch', () => ({
  fetchTimeout: jest.fn(),
}));
jest.mock('@utils/sleep', () => ({ sleep: jest.fn().mockResolvedValue(undefined) }));

import { fetchTimeout } from '@utils/fetch/fetch';

const mockFetch = fetchTimeout as jest.MockedFunction<typeof fetchTimeout>;

function mockResponse(body: unknown, status = 200, ok = true) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('LLMAnnotator — Anthropic', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends correctly-shaped request with cache_control', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        content: [
          {
            type: 'tool_use',
            input: {
              narratorGender: 'male',
              narratorVoiceHints: ['warm'],
              characters: [
                {
                  name: 'Rimuru',
                  aliases: [],
                  gender: 'neutral',
                  personality: ['gentle', 'wise'],
                  voiceHints: ['medium'],
                  description: 'A slime.',
                },
              ],
            },
          },
        ],
        usage: {
          input_tokens: 1234,
          cache_read_input_tokens: 1100,
          output_tokens: 567,
        },
      }),
    );

    const annotator = new LLMAnnotator({
      provider: 'anthropic',
      apiKey: 'sk-test',
      enablePromptCaching: true,
    });
    const glossary = await annotator.buildGlossary('test', ['ch1', 'ch2']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].name).toBe('emit_glossary');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_glossary' });

    expect(glossary.characters).toHaveLength(1);
    expect(glossary.characters[0].name).toBe('Rimuru');
    expect(glossary.narratorGender).toBe('male');
  });

  it('disables cache when enablePromptCaching=false', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        content: [{ type: 'tool_use', input: { narratorGender: 'male', narratorVoiceHints: [], characters: [] } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const annotator = new LLMAnnotator({
      provider: 'anthropic',
      apiKey: 'sk-test',
      enablePromptCaching: false,
    });
    await annotator.buildGlossary('test', ['ch1']);

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.system[0].cache_control).toBeUndefined();
  });

  it('retries on 429 with backoff', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: { message: 'rate limit' } }, 429, false))
      .mockResolvedValueOnce(
        mockResponse({
          content: [{ type: 'tool_use', input: { narratorGender: 'male', narratorVoiceHints: [], characters: [] } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

    const annotator = new LLMAnnotator({
      provider: 'anthropic',
      apiKey: 'sk-test',
    });
    const result = await annotator.buildGlossary('test', ['ch']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.characters).toEqual([]);
  });

  it('fails immediately on 401 (non-retryable)', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ error: { message: 'unauthorised' } }, 401, false),
    );

    const annotator = new LLMAnnotator({ provider: 'anthropic', apiKey: 'bad' });
    await expect(annotator.buildGlossary('test', ['ch'])).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on missing API key', async () => {
    const annotator = new LLMAnnotator({ provider: 'anthropic' });
    await expect(annotator.buildGlossary('test', ['ch'])).rejects.toThrow(/Claude API key/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('annotateChapter returns segments with intensity and pause', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        content: [
          {
            type: 'tool_use',
            input: {
              segments: [
                {
                  text: 'Hello!',
                  speaker: 'Rimuru',
                  emotion: 'happy',
                  intensity: 2,
                  isDialogue: true,
                  pauseBefore: 'short',
                },
              ],
            },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );

    const annotator = new LLMAnnotator({ provider: 'anthropic', apiKey: 'sk' });
    const annotation = await annotator.annotateChapter(
      0,
      '/novel/foo/chapter-1',
      'Some chapter text.',
      {
        novelId: 't',
        narratorGender: 'male',
        narratorVoiceHints: [],
        characters: [],
        createdAt: '',
        updatedAt: '',
      },
    );
    expect(annotation.chapterId).toBe(0);
    expect(annotation.chapterKey).toMatch(/^[0-9a-f]{16}$/);
    expect(annotation.segments).toHaveLength(1);
    expect(annotation.segments[0]).toEqual({
      text: 'Hello!',
      speaker: 'Rimuru',
      emotion: 'happy',
      intensity: 2,
      isDialogue: true,
      pauseBefore: 'short',
    });
    expect(annotation.usage?.inputTokens).toBe(100);
  });

  it('falls back to JSON-parse when no tool_use block', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        content: [
          {
            type: 'text',
            text: '```json\n{"narratorGender":"female","narratorVoiceHints":["calm"],"characters":[]}\n```',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const annotator = new LLMAnnotator({ provider: 'anthropic', apiKey: 'sk' });
    const glossary = await annotator.buildGlossary('test', ['ch']);
    expect(glossary.narratorGender).toBe('female');
  });
});

describe('LLMAnnotator — Ollama', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends correctly-shaped request', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        message: {
          content: JSON.stringify({
            narratorGender: 'male',
            narratorVoiceHints: [],
            characters: [],
          }),
        },
        prompt_eval_count: 100,
        eval_count: 50,
      }),
    );

    const annotator = new LLMAnnotator({
      provider: 'ollama',
      baseUrl: 'http://192.168.1.100:11434',
      model: 'llama3.1:70b',
    });
    await annotator.buildGlossary('test', ['ch1']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://192.168.1.100:11434/api/chat');

    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('llama3.1:70b');
    expect(body.format).toBe('json');
    expect(body.keep_alive).toBe('1h');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('does not require API key', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        message: {
          content: JSON.stringify({
            narratorGender: 'male',
            narratorVoiceHints: [],
            characters: [],
          }),
        },
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    );

    const annotator = new LLMAnnotator({ provider: 'ollama' });
    const result = await annotator.buildGlossary('test', ['ch']);
    expect(result).toBeDefined();
  });
});
