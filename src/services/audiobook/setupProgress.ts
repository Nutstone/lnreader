import type { TTSSetupProgress } from './types';

const MEGABYTE = 1024 * 1024;

/** Human-readable one-liner for each TTS setup stage. */
export const formatSetupProgress = (progress: TTSSetupProgress): string => {
  switch (progress.stage) {
    case 'bundle':
      // MB counts, not a percent: progress is per completed file and
      // one model file dominates the bundle, so a percent would sit
      // frozen for most of the download and read as a hang.
      return `Downloading TTS model… ${Math.round(
        progress.doneBytes / MEGABYTE,
      )} / ${Math.round(progress.totalBytes / MEGABYTE)} MB`;
    case 'model-load':
      return 'Loading TTS model…';
    case 'voices':
      return progress.total > 0
        ? `Preparing voices… ${progress.done}/${progress.total}`
        : 'Preparing voices…';
    case 'synthesis':
      return 'Generating audio…';
  }
};
