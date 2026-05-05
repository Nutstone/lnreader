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
- **Caching** — per-novel directory under `AUDIOBOOK_STORAGE`:
  ```
  <novelId>/
    glossary.json
    voice-map.json
    annotations/<chapterKey>.json
    audio/<chapterKey>/{manifest.json, seg_NNNN.wav}
  ```
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

## Regenerating the kokoro-js bundle

The bundled JS in `android/app/src/main/assets/audiobook/kokoro-js.bundle.js`
is produced by:

```sh
node scripts/audiobook-bundle-kokoro.mjs
```

Re-run after upgrading `kokoro-js`.
