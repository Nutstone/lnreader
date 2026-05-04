/**
 * Background-task entry for audiobook annotation.
 *
 * Used by `AUDIOBOOK_PIPELINE` in `ServiceManager`. Annotates a batch
 * of chapters; never renders audio (rendering happens at playback time
 * inside the WebView host).
 */

import { getPlugin } from '@plugins/pluginManager';
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
      progressText: `Audiobook · ${data.novelName} · starting…`,
    }));

    const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);
    if (!settings || (!settings.apiKey && settings.llmProvider === 'anthropic')) {
      throw new Error(
        'Audiobook is not configured. Add your Claude API key in Audiobook Settings.',
      );
    }

    const config: AudiobookConfig = {
      novelId: String(data.novelId),
      llm: {
        provider: settings.llmProvider,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        enablePromptCaching: settings.enablePromptCaching,
      },
      tts: {
        playbackSpeed: 1.0,
        emotionShaping: settings.emotionShaping,
        lookaheadSegments: settings.lookaheadSegments,
      },
    };

    const pipeline = new AudiobookPipeline(config);
    const plugin = getPlugin(data.pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${data.pluginId}`);
    }

    // Fetch chapter texts.
    const chapters: { id: number; path: string; rawText: string; name?: string }[] = [];
    for (let i = 0; i < data.chapterIds.length; i++) {
      setMeta(meta => ({
        ...meta,
        progressText: `Fetching chapter ${i + 1}/${data.chapterIds.length}…`,
        progress: (i / data.chapterIds.length) * 0.1,
      }));
      const chapterText = await plugin.parseChapter(data.chapterPaths[i]);
      chapters.push({
        id: data.chapterIds[i],
        path: data.chapterPaths[i],
        rawText: chapterText || '',
      });
    }

    await pipeline.processChapters(chapters, progress => {
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
      progressText: `Audiobook · ${data.novelName} · ready.`,
    }));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    setMeta(meta => ({
      ...meta,
      isRunning: false,
      progressText: `Audiobook · ${data.novelName} · ${message}`,
    }));
  }
};
