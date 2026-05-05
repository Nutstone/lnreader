# Decisions

## TTS: Kokoro hosted in a hidden WebView

`kokoro-js` doesn't run in Hermes (WASM phonemizer + onnxruntime-web).
The reader already runs a WebView, so a second hidden 1×1 WebView for
Kokoro is reuse, not invention. 28 base voices × weighted blending
gives effectively unlimited unique character voices, which is the
single biggest UX win for multi-character novels.

What we give up vs. cloud TTS:

- Emotion shaping is weaker than `gpt-4o-mini-tts`. Mitigated by speed
  modulation per emotion and post-render volume gain on whisper /
  shouting.
- 86 MB one-time model download.

What a future native Kokoro module gets us: a smaller RAM footprint
and no WebView lifecycle gotchas. The renderer abstraction means it's
a one-file swap.

### Voice blending

`kokoro-js` v1.2.1 doesn't expose voice blending. The host page in
`kokoro-tts.html` patches `_validate_voice` and `generate_from_ids` to
accept a blend string (`"af_bella:50,af_nova:30,..."`), loads each
voice's `voices/<id>.bin` style vector, weighted-averages them, and
feeds the blended style straight into the model.

This is fragile — kokoro-js internals can shift between versions.
After upgrading kokoro-js, run `node scripts/audiobook-bundle-kokoro.mjs`
and re-test single-voice and blend synthesis.

## LLM: Anthropic Claude only

One provider keeps the test surface and error-code translation work
small. Structured output via `tool_choice` removes JSON-parsing
fragility. Multi-provider routing isn't worth the complexity for a
reader-side feature.

## Persistence

Audiobook artefacts ride the existing per-chapter / per-novel storage
patterns instead of inventing new roots.

- **Per-chapter annotation** — `NOVEL_STORAGE/<pluginId>/<novelId>/<chapterId>/audiobook.json`,
  next to the chapter's `index.html` if it's downloaded. Keyed by
  chapter id, same as downloads.
- **Per-novel cast** — `NOVEL_STORAGE/<pluginId>/<novelId>/audiobook.glossary.json`
  and `audiobook.voice-map.json`. One pair per novel; tiny.
- **Rendered audio** — `AUDIOBOOK_AUDIO_CACHE/<novelId>/<chapterId>/`
  in `ExternalCachesDirectoryPath`. Large, free to rebuild, evictable
  by the OS, skipped by backups.
- **Settings** — MMKV (`AUDIOBOOK_SETTINGS`).
- **Per-chapter status** — `chapter.isAvailableAsAudiobook` column,
  same shape as `chapter.isDownloaded`. Drives the chapter-list
  indicator. Set after each successful annotation; bulk-cleared on
  per-novel reset.

`expo-av` plays WAV without transcode. OPUS is a future size
optimisation.

### Backup behaviour

The existing local / Drive / self-host backup pipeline zips all of
`ROOT_STORAGE` into `download.zip`, so co-locating annotations under
`NOVEL_STORAGE` makes them backed up for free. Audio lives outside
`ROOT_STORAGE`, so it's also excluded for free. No backup-pipeline
changes needed.

### Clear-cache semantics

- Settings → "Clear rendered audio": wipes `AUDIOBOOK_AUDIO_CACHE`
  for every novel. Frees disk; keeps annotations and glossaries.
- Novel screen → headphones menu → "Clear audiobook cache": removes
  the audiobook files for that novel (glossary, voice-map, every
  chapter's `audiobook.json`, all rendered audio) and clears the DB
  flag. Leaves `index.html` downloads alone. Forces a full rebuild on
  next play.

## Phonetics

`kokoro-js` ships espeak-ng G2P, which handles fantasy and Japanese
loanword names well enough. Per-character pronunciation overrides are
optional and applied at render time via word-boundary substitution.

## Out of scope

- Multilingual (Kokoro v1.0 is English).
- Glossary editor / voice picker UI (rebuild glossary on demand instead).
- Cost preview (per-chapter Claude spend is small; users see real
  usage in the Anthropic console).
- Sleep timer, ±30s skip, per-novel speed prefs, last-played pointer.
- Background batch processing (annotation happens on-demand at play
  time).
