import {
  AudiobookSettings,
  isLLMConfigured,
  providerSettingsFor,
  resolveLLMConfig,
} from '@hooks/persisted/useAudiobookSettings';

const base: AudiobookSettings = {
  llmProvider: 'gemini',
  ttsPrecision: 'int8',
  lookaheadSegments: 4,
  mainCharacterEmotionalSlots: 10,
};

describe('per-provider LLM settings', () => {
  it('reads per-provider entries independently', () => {
    const settings: AudiobookSettings = {
      ...base,
      providers: {
        gemini: { apiKey: 'g-key', model: '', baseUrl: '' },
        anthropic: { apiKey: 'a-key', model: 'claude-haiku-4-5', baseUrl: '' },
      },
    };
    expect(providerSettingsFor(settings, 'gemini').apiKey).toBe('g-key');
    expect(providerSettingsFor(settings, 'anthropic').model).toBe(
      'claude-haiku-4-5',
    );
    expect(providerSettingsFor(settings, 'ollama').apiKey).toBe('');
  });

  it('migrates legacy flat fields to the selected provider only', () => {
    const legacy: AudiobookSettings = {
      ...base,
      llmProvider: 'anthropic',
      apiKey: 'old-key',
      model: 'old-model',
      baseUrl: '',
    };
    expect(providerSettingsFor(legacy, 'anthropic')).toEqual({
      apiKey: 'old-key',
      model: 'old-model',
      baseUrl: '',
    });
    // The flat key belonged to anthropic; gemini must not inherit it.
    expect(providerSettingsFor(legacy, 'gemini').apiKey).toBe('');
  });

  it('prefers per-provider entries over legacy flat fields', () => {
    const settings: AudiobookSettings = {
      ...base,
      apiKey: 'stale-flat-key',
      providers: { gemini: { apiKey: 'new-key', model: '', baseUrl: '' } },
    };
    expect(resolveLLMConfig(settings)).toEqual({
      provider: 'gemini',
      apiKey: 'new-key',
      model: undefined,
      baseUrl: undefined,
    });
  });

  it('resolves a callable config for the selected provider', () => {
    const settings: AudiobookSettings = {
      ...base,
      llmProvider: 'ollama',
      providers: {
        ollama: { apiKey: '', model: 'qwen3:8b', baseUrl: 'http://pc:11434' },
      },
    };
    const config = resolveLLMConfig(settings);
    expect(config).toEqual({
      provider: 'ollama',
      apiKey: undefined,
      model: 'qwen3:8b',
      baseUrl: 'http://pc:11434',
    });
    expect(isLLMConfigured(config)).toBe(true);
  });

  it('defaults to unconfigured gemini when nothing is stored', () => {
    const config = resolveLLMConfig(undefined);
    expect(config.provider).toBe('gemini');
    expect(isLLMConfigured(config)).toBe(false);
  });

  it('requires a key for cloud providers and a URL for ollama', () => {
    expect(isLLMConfigured({ provider: 'anthropic', apiKey: 'k' })).toBe(true);
    expect(isLLMConfigured({ provider: 'anthropic' })).toBe(false);
    expect(isLLMConfigured({ provider: 'gemini', apiKey: 'k' })).toBe(true);
    expect(isLLMConfigured({ provider: 'ollama' })).toBe(false);
    expect(
      isLLMConfigured({ provider: 'ollama', baseUrl: 'http://pc:11434' }),
    ).toBe(true);
  });
});
