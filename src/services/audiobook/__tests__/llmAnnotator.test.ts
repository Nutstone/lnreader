/**
 * LLMAnnotator request-shape tests against Anthropic's documented API.
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

describe('LLMAnnotator', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends correctly-shaped Anthropic request', async () => {
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
      }),
    );

    const annotator = new LLMAnnotator({ apiKey: 'sk-test' });
    const glossary = await annotator.buildGlossary('test', ['ch1', 'ch2']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.tools[0].name).toBe('emit_glossary');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_glossary' });

    expect(glossary.characters).toHaveLength(1);
    expect(glossary.characters[0].name).toBe('Rimuru');
    expect(glossary.narratorGender).toBe('male');
  });

  it('retries on 429 with backoff', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ error: { message: 'rate limit' } }, 429, false),
      )
      .mockResolvedValueOnce(
        mockResponse({
          content: [
            {
              type: 'tool_use',
              input: {
                narratorGender: 'male',
                narratorVoiceHints: [],
                characters: [],
              },
            },
          ],
        }),
      );

    const annotator = new LLMAnnotator({ apiKey: 'sk-test' });
    const result = await annotator.buildGlossary('test', ['ch']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.characters).toEqual([]);
  });

  it('fails immediately on 401 (non-retryable)', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ error: { message: 'unauthorised' } }, 401, false),
    );

    const annotator = new LLMAnnotator({ apiKey: 'bad' });
    await expect(annotator.buildGlossary('test', ['ch'])).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on missing API key', async () => {
    const annotator = new LLMAnnotator({});
    await expect(annotator.buildGlossary('test', ['ch'])).rejects.toThrow(
      /Claude API key/,
    );
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
      }),
    );

    const annotator = new LLMAnnotator({ apiKey: 'sk' });
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
  });
});
