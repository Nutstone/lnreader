import { useMMKVObject } from 'react-native-mmkv';

export const AUDIOBOOK_SETTINGS = 'AUDIOBOOK_SETTINGS';

export interface AudiobookSettings {
  llmProvider: 'anthropic' | 'gemini' | 'ollama';
  apiKey: string;
  baseUrl: string;
  model: string;
  ttsQuality: 'q4' | 'q8' | 'fp16';
  lookaheadSegments: number;
  sampleRate: number;
}

const initialAudiobookSettings: AudiobookSettings = {
  llmProvider: 'gemini',
  apiKey: '',
  baseUrl: '',
  model: '',
  ttsQuality: 'q8',
  lookaheadSegments: 2,
  sampleRate: 24000,
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
