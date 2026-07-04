import { useMMKVObject } from 'react-native-mmkv';
import type { TTSPrecision } from '@services/audiobook/types';

export const AUDIOBOOK_SETTINGS = 'AUDIOBOOK_SETTINGS';

export interface AudiobookSettings {
  llmProvider: 'anthropic' | 'gemini' | 'ollama';
  apiKey: string;
  baseUrl: string;
  model: string;
  ttsPrecision: TTSPrecision;
  lookaheadSegments: number;
  mainCharacterEmotionalSlots: number;
}

const initialAudiobookSettings: AudiobookSettings = {
  llmProvider: 'gemini',
  apiKey: '',
  baseUrl: '',
  model: '',
  ttsPrecision: 'int8',
  lookaheadSegments: 4,
  mainCharacterEmotionalSlots: 10,
};

/**
 * Maps stored precision values (including the pre-rewrite 'q8'/'fp16'
 * tiers, which no longer exist in the exported bundle) onto the tiers
 * the bundle actually ships.
 */
export const sanitizeTTSPrecision = (value: unknown): TTSPrecision =>
  value === 'fp32' || value === 'fp16' ? 'fp32' : 'int8';

export const useAudiobookSettings = () => {
  const [audiobookSettings = initialAudiobookSettings, setSettings] =
    useMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);

  const setAudiobookSettings = (values: Partial<AudiobookSettings>) =>
    setSettings({ ...audiobookSettings, ...values });

  return {
    ...audiobookSettings,
    setAudiobookSettings,
  };
};
