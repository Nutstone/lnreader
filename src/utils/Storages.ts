import NativeFile from '@specs/NativeFile';

const constants = NativeFile.getConstants();

export const ROOT_STORAGE = constants.ExternalDirectoryPath;
export const PLUGIN_STORAGE = ROOT_STORAGE + '/Plugins';
export const NOVEL_STORAGE = ROOT_STORAGE + '/Novels';

/**
 * Rendered audio (manifests + WAVs). Large and free to rebuild from
 * annotations + Kokoro, so stored in the OS cache directory which the
 * backup zips skip.
 */
export const AUDIOBOOK_AUDIO_CACHE =
  constants.ExternalCachesDirectoryPath + '/Audiobook';

// ── Audiobook path helpers ──────────────────────────────────────

/**
 * Per-novel directory under NOVEL_STORAGE. Holds the chapter
 * sub-directories (downloads + audiobook annotations) and per-novel
 * audiobook artefacts (`audiobook.glossary.json`,
 * `audiobook.voice-map.json`).
 */
export function novelDir(pluginId: string, novelId: number | string): string {
  return `${NOVEL_STORAGE}/${pluginId}/${novelId}`;
}

/**
 * Per-chapter directory under NOVEL_STORAGE. Holds the downloaded
 * `index.html` (if downloaded) and `audiobook.json` (if annotated).
 */
export function chapterDir(
  pluginId: string,
  novelId: number | string,
  chapterId: number,
): string {
  return `${novelDir(pluginId, novelId)}/${chapterId}`;
}

export function audiobookAnnotationPath(
  pluginId: string,
  novelId: number | string,
  chapterId: number,
): string {
  return `${chapterDir(pluginId, novelId, chapterId)}/audiobook.json`;
}

export function audiobookGlossaryPath(
  pluginId: string,
  novelId: number | string,
): string {
  return `${novelDir(pluginId, novelId)}/audiobook.glossary.json`;
}

export function audiobookVoiceMapPath(
  pluginId: string,
  novelId: number | string,
): string {
  return `${novelDir(pluginId, novelId)}/audiobook.voice-map.json`;
}

/**
 * Per-chapter rendered-audio directory (cache root).
 */
export function audiobookAudioDir(
  novelId: number | string,
  chapterId: number,
): string {
  return `${AUDIOBOOK_AUDIO_CACHE}/${novelId}/${chapterId}`;
}
