# Roadmap

What's done in v1 and what's left.

## ✅ Done in v1

- Engine refactor (path-hash keys, sanitiser, retry, structured output, prompt caching, streaming-parser building blocks)
- Voice caster with archetype scoring, distinct-voice guarantee, reserved speakers, voice hints, pronunciation overrides
- Anthropic + Ollama LLM annotator with retries, structured output, prompt caching, glossary discovery, cost estimation
- Kokoro hosted in a hidden RN WebView; bundled HTML asset; renderer abstraction for future swap-in
- Audio cache (manifest + WAV files; voice-version invalidation; LRU trim)
- App-scoped player service (sleep timer, speed control, MediaSession, last-played pointer)
- Mini-player + full-screen player UI
- Glossary editor screen + voice picker bottom-sheet
- Cost preview modal
- Redesigned settings screen (provider chips, key with show/hide, model picker, test connection, cache management)
- Novel-screen audiobook menu (process N, edit cast, clear cache)
- Reader integration (subscribes to player state; segment highlighting; auto-advance)
- Tests for pure modules (65 cases)
- Docs

## 🟡 Future

| Phase | Effort | Notes |
|-------|--------|-------|
| Voice preview-on-tap | 1 d | Render a 4-second sample on demand from the WebView host. |
| Diagnostics screen | 0.5 d | 7-tap unlock on settings header → recent calls, token counts, costs. |
| OPUS audio encoding | 1–2 d | Replace WAV cache with OPUS for ~10× size reduction. |
| Native Kokoro TurboModule | 4–8 d | Replace WebView host with native Kotlin/JNI module + onnxruntime-android. Faster cold start, lower RAM. The renderer abstraction makes this a one-file swap. |
| Streaming LLM annotation | 1 d | Wire Anthropic stream + the existing `StreamingSegmentParser` to start playing the first segment ~1 s sooner. |
| Backup integration (opt-in) | 0.5 d | Add `AUDIOBOOK_STORAGE/<id>/glossary.json` + `voice-map.json` to the backup pipeline; audio stays excluded by default. |
| Cross-novel default voices | 0.5 d | MMKV `AUDIOBOOK_DEFAULT_VOICES`; user's preferred narrator persists across novels. |

## ❌ Out of scope (deliberately)

- Multilingual support. Novels are English-only in this build; Kokoro
  v1.0 is English-only and adding per-language voice catalogs +
  keyword maps doubles the test surface for marginal gain.
- Multi-LLM routing.
- ElevenLabs / OpenAI / Edge TTS. Cost math doesn't work at audiobook
  character volumes.
- Voice cloning.
- Schema migrations. Feature is fresh.

## Sequencing

If only one phase ships next, **OPUS encoding** delivers the biggest
ongoing-disk win for users who listen to many novels. The native
TurboModule is the long pole that delivers the biggest cold-start
improvement; pursue it after at least one production cycle on the
WebView path.

## Definition of done for the whole feature

A user adds a novel, taps Listen, and within seven taps is hearing
three distinct character-matched voices. They lock the phone, walk to
the bus, set a sleep timer, and the audiobook plays through. They
never see an unhandled error, never wonder how much it costs, never
re-render a chapter they already listened to.

That's the bar.
