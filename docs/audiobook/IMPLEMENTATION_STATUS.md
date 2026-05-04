# Implementation Status

A factual snapshot of what is on `master` as of the merge of
`claude/review-audioplaybook-0SSBr` (commit `8df105c`). Read this before
starting any new work — much of what feels missing in the original concept
has actually shipped.

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Shipped on master, working |
| 🟡 | Shipped but with a known gap (see notes) |
| ❌ | Not implemented |
| 🔁 | Implemented but needs replacement (regressed defaults / stale model / poor UX) |

## Core engine (`src/services/audiobook/`)

| Capability | Status | File | Notes |
|------------|--------|------|-------|
| Pipeline orchestrator | ✅ | `pipeline.ts` | Caches glossary, voice map, per-chapter annotations to `AUDIOBOOK_STORAGE/<novelId>/`. |
| Voice blender, 9 archetypes | ✅ | `voiceBlender.ts` | Hash-seeded weight perturbation; weights normalise to 100. |
| LLM annotator | 🟡 | `llmAnnotator.ts` | Anthropic / Gemini / Ollama all wired. **Stale default models**, no prompt caching, no streaming, no retry, no chunking. |
| Glossary builder prompt | 🟡 | `prompts/glossaryBuilder.ts` | Works, but only sees first 3 chapters — characters introduced in chapter 30 fall back to narrator. |
| Chapter annotator prompt | ✅ | `prompts/chapterAnnotator.ts` | Returns segments with speaker/emotion/pause-before. |
| Kokoro TTS renderer | 🟡 | `ttsRenderer.ts` | Uses `kokoro-js`. Streams with N-segment lookahead. Initialises and disposes per chapter — model reloaded each chapter, slow start. **Hermes/RN compatibility uncertain** (see `KOKORO_TTS.md`). |
| Audio segment WAV output | 🟡 | `ttsRenderer.ts` | WAV is uncompressed and base64-encoded — heavy on memory and disk. Should switch to OPUS/AAC for cache. |
| Background pipeline task | ✅ | `processAudiobook.ts`, `services/ServiceManager.ts` | `AUDIOBOOK_PIPELINE` task type with progress callback. |
| Storage layout | ✅ | `utils/Storages.ts` | `AUDIOBOOK_STORAGE = ROOT_STORAGE + '/Audiobook'`. |
| Audiobook player | 🟡 | `AudiobookPlayer.ts` | Generator-based with buffering and event-driven segment wait. **Tied to reader screen lifecycle** — no global service, no notification controls beyond TTS notification reuse. |

## Reader integration

| Capability | Status | File | Notes |
|------------|--------|------|-------|
| Audiobook toggle in TTS bottom sheet | ✅ | `screens/reader/components/ReaderBottomSheet/TTSTab.tsx` | Mutually exclusive with TTS. |
| Auto-page-advance setting | ✅ | `useSettings.ts` (`audiobook.autoPageAdvance`) | |
| `window.audiobook` JS bridge | ✅ | `android/app/src/main/assets/js/core.js` | start/pause/resume/stop + `highlightSegment` via TreeWalker. |
| Highlight current segment in webview | ✅ | `WebViewReader.tsx` + `core.js` | First-60-chars match via TreeWalker (fragile for repeated phrases). |
| MediaSession bindings | 🟡 | `WebViewReader.tsx` | Uses existing TTS MediaSession; works, but skip-prev/next jumps **whole chapter**, not segment. |
| Auto-start on chapter change | ✅ | `WebViewReader.tsx` (`autoStartAudiobookRef`) | |

## Settings UI

| Capability | Status | File | Notes |
|------------|--------|------|-------|
| Settings screen | 🔁 | `screens/settings/SettingsAudiobookScreen.tsx` | Bare TextInputs. No "Test connection" button, no per-provider help text, no model dropdown with current defaults, no quality preset descriptions, no cost estimate, no cache management. **Replace.** |
| `useAudiobookSettings` hook | ✅ | `hooks/persisted/useAudiobookSettings.ts` | MMKV-backed. |
| Navigation entry from More tab | ✅ | `navigators/MoreStack.tsx` | |
| Translations | 🟡 | `strings/languages/en/strings.json` | Settings strings shipped. **`glossaryEditor.*` and `novelScreen.audiobook.*` strings exist with no UI behind them.** |

## Stubbed but unimplemented (string keys exist, screens don't)

These were defined in `strings/languages/en/strings.json` and
`strings/types/index.ts` but have no implementation. Implementing them is
how you fulfil the high-UX bar.

| Stub | Purpose | Where it should live |
|------|---------|----------------------|
| `novelScreen.audiobook.next/next5/next10/unread/customAmount` | "Process audiobook for…" overflow menu on novel screen | `screens/novel/components/NovelAppbar.tsx` (mirror the `novelScreen.download.*` menu next to it) |
| `glossaryEditor.*` | Per-novel glossary review screen with character add/edit/delete | New screen `screens/glossaryEditor/GlossaryEditorScreen.tsx` |

## What the original concept describes but isn't built yet

| Concept feature | Status | Why it matters |
|-----------------|--------|----------------|
| Cloud LLM annotation | ✅ | |
| 9 archetype voice blending | ✅ | |
| Streaming playback during render | ✅ | |
| Voice override per character | 🟡 | API exists (`pipeline.overrideVoice`); no UI calls it. |
| Customisable archetype recipes | ❌ | Hard-coded in `voiceBlender.ts`. |
| Per-character glossary editor | ❌ | Strings exist; screen doesn't. |
| "Listen" button per chapter | ❌ | Toggle in TTS sheet only — there's no obvious entry point from the chapter list. |
| Cache management UI | ❌ | Engine caches; user can't see or clear without uninstalling. |
| Cost estimate | ❌ | User has no idea how many tokens a 600-page novel will consume. |
| Voice preview | ❌ | Voices selected sight-unseen; users can't audition before committing. |
| Glossary review pre-flight | ❌ | LLM picks characters and personalities once — no human approval before processing all chapters. |
| Sleep timer | ❌ | Fundamental audiobook feature. |
| Mini-player across screens | ❌ | Player dies when reader unmounts. |
| Persistent rendered audio | ❌ | Each replay re-renders. WAV files written to temp dir then deleted. |
| Multilingual (JP/CN/KR) | ❌ | Kokoro v1.0 ships English voices; v1.1+ adds others but tokenizers/lang flags unhandled. |
| Tests | ❌ | Zero test coverage. |

## Critical bugs and regressions to fix early

These are not "nice to have" — they are correctness bugs spotted during the
review. Address them in Phase 1 of the roadmap.

1. **Stale Anthropic model default**: `claude-sonnet-4-20250514` →
   `claude-sonnet-4-6` (latest in the 4.6 family). See `LLM_INTEGRATION.md`.
2. **Stale Gemini model default**: `gemini-2.0-flash` → `gemini-2.5-pro`.
3. **No prompt caching** on the chapter-annotation system prompt — every
   chapter sends ~1.5k tokens of identical instructions. Anthropic's
   `cache_control` saves ~90% of those tokens at zero quality cost.
4. **Glossary built from first 3 chapters only**: characters introduced
   later become "narrator" until the user runs an override flow that
   doesn't exist. Add an incremental discovery pass during annotation.
5. **TTS Renderer reloads the model every chapter**: `initialize()` /
   `dispose()` in `pipeline.streamChapterAudio` — the 86 MB ONNX file is
   re-mmapped each time. Move ownership to a singleton service.
6. **Highlight match is fragile**: first-60-chars `indexOf` will mis-highlight
   when a phrase repeats. Use the segment index from the annotation as a
   stable anchor, or wrap each segment in a span at render time.
7. **WAV-to-base64 in JS**: `arrayBufferToBase64` chunks at 8 KB but still
   runs on the JS thread for every segment. For a 30-second segment that's
   ~1.4 MB of base64 string churn. Move to native via `NativeFile.writeFile`
   with binary mode, or render directly to a file path.
8. **No retry / backoff** on the LLM call: a single 429 nukes the entire
   `processNovel` run.
9. **Annotation indexed by integer chapter ID**: if the source plugin adds
   a chapter at the start, every cached annotation is now misaligned. Key
   by `chapter.path` (the stable plugin URL) instead.
10. **No content sanitisation** before LLM call: HTML, footnote markup,
    image alt text and JSON-LD all get sent. Easy 30% token saving.

## Files to know

```
src/services/audiobook/
├── AudiobookPlayer.ts        # Player state machine; reader-scoped
├── index.ts                  # Public exports
├── llmAnnotator.ts           # Cloud LLM client (Anthropic/Gemini/Ollama)
├── pipeline.ts               # Orchestrator + per-novel cache
├── processAudiobook.ts       # Background task entry point
├── prompts/
│   ├── chapterAnnotator.ts   # System prompt for segmentation
│   └── glossaryBuilder.ts    # System prompt for character extraction
├── ttsRenderer.ts            # Kokoro ONNX wrapper, streams segments
├── types.ts                  # All public types
└── voiceBlender.ts           # Archetype recipes + per-char perturbation

src/hooks/persisted/useAudiobookSettings.ts   # MMKV settings hook
src/screens/settings/SettingsAudiobookScreen.tsx
src/screens/reader/components/ReaderBottomSheet/TTSTab.tsx
src/screens/reader/components/WebViewReader.tsx   # ~600 LoC; audiobook hooks at lines 100–700
src/services/ServiceManager.ts                    # AUDIOBOOK_PIPELINE task
android/app/src/main/assets/js/core.js            # window.audiobook bridge
strings/languages/en/strings.json                 # i18n
strings/types/index.ts                            # i18n types
```
