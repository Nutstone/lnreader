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

Two roots, on purpose:

- **`AUDIOBOOK_STORAGE`** (= `ROOT_STORAGE/Audiobook`, backed up by the
  existing local/Drive/self-host backup pipeline) — settings live in
  MMKV; per-novel artefacts (`glossary.json`, `voice-map.json`,
  `annotations/<chapterKey>.json`) live as hierarchical JSON files.
  Tiny, atomic, debuggable, and represent real money paid to Claude.
- **`AUDIOBOOK_AUDIO_CACHE`** (= `ExternalCachesDirectoryPath/Audiobook`,
  skipped by backups) — rendered WAVs + their manifest. Free to
  rebuild from annotations + Kokoro; can be cleared by the OS or the
  user without losing any paid work.

`expo-av` plays WAV without transcode. OPUS is a future size
optimisation. No SQLite tables, no audio playback module, no schema
migrations.

### Clear-cache semantics

- Settings → "Clear rendered audio": wipes `AUDIOBOOK_AUDIO_CACHE`
  for every novel. Frees disk; keeps annotations and glossaries.
- Novel screen → headphones menu → "Clear audiobook cache": wipes
  both roots for that novel. Forces a full rebuild on next play.

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
