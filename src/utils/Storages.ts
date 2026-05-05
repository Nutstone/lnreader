import NativeFile from '@specs/NativeFile';

const constants = NativeFile.getConstants();

export const ROOT_STORAGE = constants.ExternalDirectoryPath;
export const PLUGIN_STORAGE = ROOT_STORAGE + '/Plugins';
export const NOVEL_STORAGE = ROOT_STORAGE + '/Novels';

/**
 * Glossary, voice map, and per-chapter annotations. Small, expensive
 * to rebuild (LLM cost), so persisted under ROOT_STORAGE so the
 * existing backup zips include them.
 */
export const AUDIOBOOK_STORAGE = ROOT_STORAGE + '/Audiobook';

/**
 * Rendered audio (manifests + WAVs). Large and free to rebuild from
 * annotations + Kokoro, so stored in the OS cache directory which the
 * backup zips skip.
 */
export const AUDIOBOOK_AUDIO_CACHE =
  constants.ExternalCachesDirectoryPath + '/Audiobook';
