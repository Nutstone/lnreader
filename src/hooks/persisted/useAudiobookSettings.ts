import { useMMKVObject } from 'react-native-mmkv';
import { LLMProvider } from '@services/audiobook/types';

export const AUDIOBOOK_SETTINGS = 'AUDIOBOOK_SETTINGS';

/**
 * Audiobook settings.
 *
 * One LLM provider (Anthropic default) + optional Ollama. One TTS
 * engine (Kokoro hosted in a WebView) — no engine choice in settings.
 *
 * See docs/audiobook/DECISIONS.md.
 */
export interface AudiobookSettings {
  /** LLM provider: 'anthropic' (default) | 'ollama'. */
  llmProvider: LLMProvider;
  /** Anthropic API key — never log or include in error reports. */
  apiKey: string;
  /** Ollama base URL when llmProvider === 'ollama'. */
  baseUrl: string;
  /** Override the provider's default model. Empty = use recommended. */
  model: string;
  /** Default true; disables Anthropic prompt-caching when false. */
  enablePromptCaching: boolean;
  /**
   * Kokoro model dtype — quality/speed/size trade-off.
   * Default 'q8f16' (~86 MB).
   */
  ttsDtype: 'q4' | 'q8' | 'q8f16' | 'fp16';
  /** Number of segments rendered ahead of playback (1..6). */
  lookaheadSegments: number;
  /** Auto-advance to next chapter when finished. */
  autoAdvanceChapter: boolean;
  /** Apply post-render volume gain on whisper/shouting. */
  emotionShaping: boolean;
  /** Maximum disk used by rendered audio (MB). */
  maxCacheSizeMB: number;
}

const initialSettings: AudiobookSettings = {
  llmProvider: 'anthropic',
  apiKey: '',
  baseUrl: 'http://localhost:11434',
  model: '',
  enablePromptCaching: true,
  ttsDtype: 'q8f16',
  lookaheadSegments: 3,
  autoAdvanceChapter: true,
  emotionShaping: true,
  maxCacheSizeMB: 1024,
};

export const useAudiobookSettings = () => {
  const [stored = initialSettings, setSettings] =
    useMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);

  // Always merge with defaults so a partial stored object stays valid.
  const merged: AudiobookSettings = { ...initialSettings, ...stored };

  const setAudiobookSettings = (values: Partial<AudiobookSettings>) =>
    setSettings({ ...merged, ...values });

  return { ...merged, setAudiobookSettings };
};
