import NativeFile from '@specs/NativeFile';

const consts = NativeFile.getConstants();

export const ROOT_STORAGE = consts.ExternalDirectoryPath;
export const PLUGIN_STORAGE = ROOT_STORAGE + '/Plugins';
export const NOVEL_STORAGE = ROOT_STORAGE + '/Novels';

/**
 * Persistent audiobook data: LLM-derived JSON (glossary, voice map,
 * annotations). Lives in the app's external files dir so it survives
 * OS storage pressure and is included in Auto Backup.
 */
export const AUDIOBOOK_STORAGE = ROOT_STORAGE + '/Audiobook';

/**
 * Re-derivable audiobook artefacts: TTS model, tokenizer, voice
 * clips, rendered audio. Lives in the OS-managed cache dir so it
 * is auto-excluded from Auto Backup (Auto Backup is capped at
 * 25 MB per app — these blobs would silently break backups) and
 * can be reclaimed under storage pressure.
 */
export const AUDIOBOOK_CACHE_STORAGE =
  consts.ExternalCachesDirectoryPath + '/Audiobook';
