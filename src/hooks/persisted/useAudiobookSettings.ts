import { useMMKVObject } from 'react-native-mmkv';
import type { LLMConfig, TTSPrecision } from '@services/audiobook/types';

export const AUDIOBOOK_SETTINGS = 'AUDIOBOOK_SETTINGS';

export type LLMProvider = LLMConfig['provider'];

/** Credentials/overrides stored separately for each provider, so
 * switching providers never loses a key. */
export interface ProviderSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface AudiobookSettings {
  llmProvider: LLMProvider;
  providers?: Partial<Record<LLMProvider, ProviderSettings>>;
  /** @deprecated Flat pre-per-provider fields; migrated on read by
   * `providerSettingsFor`. Kept so old persisted settings keep
   * working after upgrade. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  ttsPrecision: TTSPrecision;
  lookaheadSegments: number;
  mainCharacterEmotionalSlots: number;
}

const initialAudiobookSettings: AudiobookSettings = {
  llmProvider: 'gemini',
  providers: {},
  ttsPrecision: 'int8',
  lookaheadSegments: 4,
  mainCharacterEmotionalSlots: 10,
};

const EMPTY_PROVIDER: ProviderSettings = { apiKey: '', model: '', baseUrl: '' };

/**
 * Maps stored precision values (including the pre-rewrite 'q8'/'fp16'
 * tiers, which no longer exist in the exported bundle) onto the tiers
 * the bundle actually ships.
 */
export const sanitizeTTSPrecision = (value: unknown): TTSPrecision =>
  value === 'fp32' || value === 'fp16' ? 'fp32' : 'int8';

/**
 * The stored settings for one provider. Falls back to the legacy
 * flat apiKey/model/baseUrl fields for the provider that was
 * selected when they were written.
 */
export const providerSettingsFor = (
  settings: AudiobookSettings | undefined,
  provider: LLMProvider,
): ProviderSettings => {
  const stored = settings?.providers?.[provider];
  if (stored) {
    return { ...EMPTY_PROVIDER, ...stored };
  }
  if (settings && settings.llmProvider === provider) {
    return {
      apiKey: settings.apiKey ?? '',
      model: settings.model ?? '',
      baseUrl: settings.baseUrl ?? '',
    };
  }
  return EMPTY_PROVIDER;
};

/** The LLM config for whichever provider is currently selected. */
export const resolveLLMConfig = (
  settings: AudiobookSettings | undefined,
): LLMConfig => {
  const provider = settings?.llmProvider ?? 'gemini';
  const stored = providerSettingsFor(settings, provider);
  return {
    provider,
    apiKey: stored.apiKey || undefined,
    model: stored.model || undefined,
    baseUrl: stored.baseUrl || undefined,
  };
};

/**
 * Whether the selected provider can be called at all: Anthropic and
 * Gemini need an API key; Ollama needs a reachable server URL (the
 * localhost default is meaningless on a phone).
 */
export const isLLMConfigured = (config: LLMConfig): boolean =>
  config.provider === 'ollama' ? !!config.baseUrl : !!config.apiKey;

export const useAudiobookSettings = () => {
  const [audiobookSettings = initialAudiobookSettings, setSettings] =
    useMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);

  const setAudiobookSettings = (values: Partial<AudiobookSettings>) =>
    setSettings({ ...audiobookSettings, ...values });

  /** Merges a partial update into one provider's stored settings. */
  const setProviderSettings = (
    provider: LLMProvider,
    values: Partial<ProviderSettings>,
  ) =>
    setSettings({
      ...audiobookSettings,
      providers: {
        ...audiobookSettings.providers,
        [provider]: {
          ...providerSettingsFor(audiobookSettings, provider),
          ...values,
        },
      },
    });

  return {
    ...audiobookSettings,
    settings: audiobookSettings,
    setAudiobookSettings,
    setProviderSettings,
  };
};
