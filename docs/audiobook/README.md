# LN Audiobook Director — Implementation Guide

This directory documents LNReader's multi-voice audiobook engine: a feature
that turns a light-novel chapter into a fully-cast audio drama using a cloud
LLM (for character casting and emotion annotation) and on-device Kokoro TTS
(for voice synthesis).

The original concept is preserved at the bottom of this README. The rest of
this folder is the **revised, implementation-ready specification** that
replaces it.

## How to use these docs

These files are written for future Claude / human sessions that pick the
project up cold. Each file is self-contained — read the one that matches
what you're working on.

| File | When to read it |
|------|-----------------|
| [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) | **Start here.** What's already shipped, what's stubbed, what's missing. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Pipeline data flow, caching layers, module boundaries, persistence. |
| [`UX_GUIDELINES.md`](./UX_GUIDELINES.md) | Screens, flows, copy, empty states, the "high UX bar" the feature must clear. |
| [`LLM_INTEGRATION.md`](./LLM_INTEGRATION.md) | Model choices, prompt caching, streaming, retries, sanitisation, chunking. |
| [`KOKORO_TTS.md`](./KOKORO_TTS.md) | Kokoro on React Native: integration paths, voice catalog, multilingual. |
| [`VOICE_CASTING.md`](./VOICE_CASTING.md) | Archetype recipes, glossary review, per-character override flow. |
| [`ROADMAP.md`](./ROADMAP.md) | Phased implementation plan with concrete acceptance criteria per phase. |
| [`TESTING.md`](./TESTING.md) | What to test, fixtures, mocking strategies, manual QA. |

## TL;DR for a new contributor

1. The audiobook engine **already works end-to-end on master** for a single
   provider/model setup. The pipeline (glossary → annotate → blend → render
   → play) is wired, the reader has a "Listen" toggle, the settings screen
   exists.
2. **What it isn't yet**: high-UX. There is no glossary review, no voice
   preview, no per-character override UI, no cost estimate, no audio cache,
   no mini-player, no model selector with sane defaults, no test coverage,
   no multilingual support.
3. Roughly **70% of the original concept is built**. The remaining 30% is
   what makes the difference between "demo" and "ship".
4. Read `IMPLEMENTATION_STATUS.md` then `ROADMAP.md` to see where to start.

## Cardinal rules

These rules are non-negotiable. They come from the original brief and from
how LNReader treats power-user features:

1. **Annotation runs in the cloud, TTS runs on-device.** Never send chapter
   audio anywhere. Never require a server for playback.
2. **Offline after annotation.** Once a chapter is annotated and rendered,
   playback works on a plane.
3. **Best models only.** Default to Sonnet 4.6 / Opus 4.7 / Gemini 2.5 Pro.
   Never default to Haiku 4.5 — for a literary task it produces obviously
   inferior casting and emotion.
4. **Caching is sacred.** A chapter is annotated once. A character is voiced
   once. A segment is rendered once. Re-running anything by accident is a
   bug.
5. **API keys never leave the device.** Stored in MMKV (encrypted by the
   platform), never logged, never embedded in error reports.
6. **The reader is the source of truth.** The audiobook is a layer over the
   chapter, not a replacement for it. Highlighting, pause, scroll position —
   everything stays in sync.

## Original concept (preserved for reference)

The original feature pitch lives in the PR description for branch
`claude/review-improve-concept-TNzGt`. It is *not* the spec — it is the
starting point. Where this doc set disagrees with the original concept, this
doc set wins. Specific overrides:

- The original concept defaults to `gemini-2.0-flash` and Claude
  `sonnet-4-20250514`. **Both are stale.** Use Gemini 2.5 Pro / Sonnet 4.6
  (see `LLM_INTEGRATION.md`).
- The original concept does not specify prompt caching, streaming, or
  chunking. **All three are required** for the feature to scale to 1000-page
  novels.
- The original concept describes 9 archetype recipes with auto-perturbation.
  That ships. The improvement is the **glossary review step**: users approve
  the cast before $10 of API credit is spent.
- The original concept describes a "Listen" button. Build a **persistent
  mini-player** instead — listening across chapters, screen transitions and
  app backgrounding is the whole point of an audiobook.

If anything in this docs set is unclear, prefer reading the source over
guessing: the live implementation is in `src/services/audiobook/` and
`src/screens/settings/SettingsAudiobookScreen.tsx`.
