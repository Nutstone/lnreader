import { useMMKVObject } from 'react-native-mmkv';
import { KokoroDtype } from '@services/audiobook';

export const AUDIOBOOK_SETTINGS = 'AUDIOBOOK_SETTINGS';

export interface AudiobookSettings {
  /** Anthropic API key — never log. */
  apiKey: string;
  /** Override the default model. Empty = use recommended. */
  model: string;
  /** Kokoro model dtype — quality/speed/size trade-off. */
  ttsDtype: KokoroDtype;
  /** Number of segments rendered ahead of playback (1..6). */
  lookaheadSegments: number;
  /** Auto-advance to next chapter when finished. */
  autoAdvanceChapter: boolean;
  /** Apply post-render volume gain on whisper/shouting. */
  emotionShaping: boolean;
}

const initialSettings: AudiobookSettings = {
  apiKey: '',
  model: '',
  ttsDtype: 'q8',
  lookaheadSegments: 3,
  autoAdvanceChapter: true,
  emotionShaping: true,
};

export const useAudiobookSettings = () => {
  const [stored = initialSettings, setSettings] =
    useMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);

  const merged: AudiobookSettings = { ...initialSettings, ...stored };

  const setAudiobookSettings = (values: Partial<AudiobookSettings>) =>
    setSettings({ ...merged, ...values });

  return { ...merged, setAudiobookSettings };
};
