import { getPlugin } from '@plugins/pluginManager';
import { getChapter } from '@database/queries/ChapterQueries';
import { BackgroundTaskMetadata } from '@services/ServiceManager';
import { NOVEL_STORAGE } from '@utils/Storages';
import NativeFile from '@specs/NativeFile';
import { AudiobookPipeline } from './pipeline';
import { AudiobookConfig, ChapterInput } from './types';
import { htmlToText } from './htmlToText';
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

    // Gather chapter texts — from local storage when downloaded,
    // else from the network via the source plugin.
    const chapters: ChapterInput[] = [];
    for (let i = 0; i < data.chapterIds.length; i++) {
      const chapterId = data.chapterIds[i];
      setMeta(meta => ({
        ...meta,
        progressText: `Fetching chapter ${i + 1}/${data.chapterIds.length}...`,
        progress: (i / data.chapterIds.length) * 0.1,
      }));

      try {
        let html: string | undefined;
        const chapter = await getChapter(chapterId);
        if (chapter?.isDownloaded) {
          const filePath = `${NOVEL_STORAGE}/${data.pluginId}/${data.novelId}/${chapterId}/index.html`;
          if (NativeFile.exists(filePath)) {
            html = NativeFile.readFile(filePath);
          }
        }
        if (html === undefined) {
          html = (await plugin.parseChapter(data.chapterPaths[i])) || '';
        }
        chapters.push({ id: chapterId, text: htmlToText(html) });
      } catch (error) {
        throw new Error(
          `Failed to fetch chapter ${i + 1}/${
            data.chapterIds.length
          } (id ${chapterId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Run the pipeline
    await pipeline.processNovel(chapters, progress => {
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
