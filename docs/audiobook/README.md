# LN Audiobook Director — Implementation

Multi-voice audiobook engine for light novels. Cloud LLM analyses each
chapter and assigns voices to characters; on-device Kokoro (hosted in a
hidden WebView) renders the audio; rendered chapters are cached so
replays work offline.

This folder is the implementation guide. The original concept is
preserved in the PR description for reference; where this folder
disagrees with the original concept, this folder wins.

## Where to start

**Read [`DECISIONS.md`](./DECISIONS.md) first.** It locks the two key
picks (one TTS engine, one LLM provider) and explains why other paths
were rejected.

| File | When to read it |
|------|-----------------|
| [`DECISIONS.md`](./DECISIONS.md) | The two narrow picks: Kokoro WebView + Anthropic Claude. Honest UX-driven analysis. |
| [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) | What ships in this branch. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Pipeline data flow, caches, module boundaries. |
| [`UX_GUIDELINES.md`](./UX_GUIDELINES.md) | Screens, flows, copy, performance budgets. |
| [`LLM_INTEGRATION.md`](./LLM_INTEGRATION.md) | Provider-side details: prompt caching, retry, structured output, sanitisation. |
| [`VOICE_CASTING.md`](./VOICE_CASTING.md) | Archetype scoring, voice blending, pronunciation overrides. |
| [`ROADMAP.md`](./ROADMAP.md) | What's done, what's next. |
| [`TESTING.md`](./TESTING.md) | Per-module strategy, fixtures, manual QA. |

## TL;DR

- **One TTS** — Kokoro v1.0 via `kokoro-js`, hosted in a hidden RN
  WebView. Free, offline after first render, 28 base voices ×
  weighted blending = effectively unlimited unique character voices.
  Phonetics handled by espeak-ng inside kokoro-js.
- **One LLM** — Anthropic Claude (default Sonnet 4.6), with optional
  Ollama for offline/free annotation. Structured output via
  `tool_choice` + prompt caching for ~10× cost reduction.
- **Persistence** — MMKV for settings + per-novel pointers; per-novel
  JSON files under `AUDIOBOOK_STORAGE/<novelId>/` for glossary, voice
  map, annotations; WAV files in `audio/<chapterKey>/` for cached audio.
- **English only.** Multilingual is out of scope for v1; Kokoro v1.0
  is English-only.
- **No multi-provider routing.** No native Kokoro module. No cloud
  TTS. Each is an explicit choice documented in `DECISIONS.md`.

## Cardinal rules

1. **Annotation runs in the cloud (or local Ollama). TTS runs on-device.**
2. **Offline after annotation + first render.** Cached chapters work
   on a plane.
3. **Best-quality default.** Sonnet 4.6 is the recommended model;
   never auto-pick Haiku.
4. **Caching is sacred.** A chapter is annotated once; a segment is
   rendered once per voice version.
5. **API keys never leave the device.** MMKV; never logged.
6. **The reader stays in sync.** Highlight follows the spoken segment;
   auto-advance respects user setting.
