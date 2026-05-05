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
  sampleRate: number;
  mainCharacterEmotionalSlots: number;
}

const initialAudiobookSettings: AudiobookSettings = {
  llmProvider: 'gemini',
  apiKey: '',
  baseUrl: '',
  model: '',
  ttsPrecision: 'q8',
  lookaheadSegments: 4,
  sampleRate: 24000,
  mainCharacterEmotionalSlots: 10,
};

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
