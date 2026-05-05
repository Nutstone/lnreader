# Audiobook (multi-voice TTS)

A simple reader extension. Tap "Listen" on a chapter; Claude annotates
the chapter into per-speaker segments; Kokoro (in a hidden WebView)
renders each segment to a WAV; `expo-av` plays them in order.

## Pieces

- **Annotation** — Anthropic Claude, structured output via
  `tool_choice`. One LLM call per chapter; result is cached on disk.
- **Casting** — each named character gets a `BlendedVoice` (1–3 Kokoro
  voices weighted) chosen by archetype + gender. Reserved speakers
  (`narrator`, `system`, `crowd`) use fixed recipes.
- **Rendering** — `kokoro-js` runs inside a 1×1 hidden WebView. The
  page is loaded from `android/app/src/main/assets/audiobook/`. Voice
  blending is implemented by patching `_validate_voice` and
  `generate_from_ids` in the host page (see `kokoro-tts.html`).
- **Storage** — co-located with downloaded chapters under
  `NOVEL_STORAGE`, plus a separate cache root for rendered audio:
  ```
  NOVEL_STORAGE/<pluginId>/<novelId>/                 (backed up)
    audiobook.glossary.json
    audiobook.voice-map.json
    <chapterId>/
      index.html                ← downloaded chapter HTML
      audiobook.json            ← per-chapter annotation

  AUDIOBOOK_AUDIO_CACHE/<novelId>/<chapterId>/        (not backed up)
    manifest.json
    seg_NNNN.wav
  ```
  Annotations + glossary represent paid LLM work, are tiny, and ride
  the existing `ROOT_STORAGE` backup zip for free. Rendered WAVs are
  large and free to rebuild from the annotations + Kokoro, so they
  live in the OS cache directory which the backup zips skip.

- **Status flag** — each chapter row gains an
  `isAvailableAsAudiobook` boolean column alongside `isDownloaded`.
  The chapter list reads it directly to render the headphones
  indicator. Set after each successful annotation
  (`setChapterAudiobookAvailable`); cleared by the per-novel reset
  (`clearAudiobookAvailableForNovel`).
- **Player** — `AudiobookPlayer` singleton owns the `expo-av` sound and
  emits `PlayerState` to subscribers (the reader integration is the
  only consumer).

## Settings

Configured at Settings → Audiobook:

- API key (Anthropic).
- TTS quality (`q4` … `fp32`, default `q8`).
- Lookahead segments (1–6, default 3).
- Auto-advance to next chapter.
- Emotion shaping (volume gain on whisper / shouting).

## kokoro-js bundle

`android/app/src/main/assets/audiobook/kokoro-js.bundle.js` is build
output, gitignored, and regenerated automatically:

- `pnpm bundle:audiobook` — direct invocation
- `pnpm dev:android` / `pnpm build:release:android` — chained in
- Gradle `preBuild` task — covers `./gradlew` invocations
- CI step in `.github/workflows/build.yml`

Driver: `scripts/audiobook-bundle-kokoro.mjs` (esbuild → ESM, 2.1 MiB).
Re-runs are cheap; output is deterministic enough for CI caching.
