import { getPlugin } from '@plugins/pluginManager';
import { getChapter } from '@database/queries/ChapterQueries';
import { BackgroundTaskMetadata } from '@services/ServiceManager';
import { AudiobookPipeline } from './pipeline';
import { AudiobookConfig } from './types';
import { getMMKVObject } from '@utils/mmkv/mmkv';
import {
  AudiobookSettings,
  AUDIOBOOK_SETTINGS,
} from '@hooks/persisted/useAudiobookSettings';

export const processAudiobook = async (
  data: {
    novelId: number;
    novelName: string;
    pluginId: string;
    chapterIds: number[];
    chapterPaths: string[];
  },
  setMeta: (
    transformer: (meta: BackgroundTaskMetadata) => BackgroundTaskMetadata,
  ) => void,
) => {
  try {
    setMeta(meta => ({
      ...meta,
      isRunning: true,
      progressText: `Processing ${data.novelName}...`,
    }));

    const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);

    const config: AudiobookConfig = {
      llm: {
        provider: settings?.llmProvider ?? 'gemini',
        apiKey: settings?.apiKey || undefined,
        baseUrl: settings?.baseUrl || undefined,
        model: settings?.model || undefined,
      },
      tts: {
        precision: settings?.ttsPrecision ?? 'q8',
        lookaheadSegments: settings?.lookaheadSegments ?? 4,
        sampleRate: settings?.sampleRate ?? 24000,
        mainCharacterEmotionalSlots:
          settings?.mainCharacterEmotionalSlots ?? 10,
      },
      novelId: String(data.novelId),
    };

    const pipeline = new AudiobookPipeline(config);
    const plugin = getPlugin(data.pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${data.pluginId}`);
    }

    // Fetch chapter texts
    const chapterTexts: string[] = [];
    for (let i = 0; i < data.chapterIds.length; i++) {
      setMeta(meta => ({
        ...meta,
        progressText: `Fetching chapter ${i + 1}/${data.chapterIds.length}...`,
        progress: (i / data.chapterIds.length) * 0.1,
      }));

      const chapterText = await plugin.parseChapter(data.chapterPaths[i]);
      chapterTexts.push(chapterText || '');
    }

    // Run the pipeline
    await pipeline.processNovel(chapterTexts, progress => {
      setMeta(meta => ({
        ...meta,
        progressText: progress.message,
        progress: 0.1 + progress.progress * 0.9,
      }));
    });

    setMeta(meta => ({
      ...meta,
      progress: 1,
      isRunning: false,
      progressText: `Finished processing ${data.novelName}`,
    }));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    setMeta(meta => ({
      ...meta,
      isRunning: false,
      progressText: `Error processing ${data.novelName}: ${message}`,
    }));
  }
};
