# Implementation Status

Snapshot of what's on `claude/review-improve-concept-TNzGt` after the
v1 build. Read `DECISIONS.md` first if anything below feels surprising.

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Shipped, tested |
| 🟡 | Shipped with a known limitation |
| ❌ | Not implemented |
| 📦 | New module added in this branch |

## Engine

| Capability | Status | Notes |
|------------|--------|-------|
| LLM annotator (Anthropic + Ollama) | ✅ 📦 | Structured output via `tool_choice` (Anthropic) and `format: 'json'` (Ollama). Retries 429/503 with exp backoff. Prompt caching on Anthropic. |
| Glossary builder | ✅ 📦 | Includes voice hints (audio descriptors). |
| Glossary discovery (mid-novel new speakers) | ✅ 📦 | Buffers ≥3 unknown speakers, calls `extendGlossary`. |
| Voice caster | ✅ 📦 | Archetype scoring matrix; weight perturbation; distinct-voice guarantee; reserved speakers (narrator/system/crowd). |
| Voice blending (Kokoro `id:weight,…`) | ✅ 📦 | 3-component recipes per (archetype × gender). |
| Chapter sanitiser | ✅ 📦 | Strips HTML, footnotes, T/N markers, AN blocks, plugin boilerplate. |
| Streaming JSON parser | ✅ 📦 | Used for forgiving LLM JSON extraction. |
| Cost estimation | ✅ 📦 | Per-batch cost preview before processing. |
| Emotion modulation table | ✅ 📦 | 12 emotions × 3 intensities → speed/pitch/volume. |
| Audio cache | ✅ 📦 | Manifest + WAV files; LRU eviction; voice-version invalidation. |
| Background pipeline (`AUDIOBOOK_PIPELINE`) | ✅ | Reuses ServiceManager. |

## TTS

| Capability | Status | Notes |
|------------|--------|-------|
| Kokoro hosted in hidden WebView | ✅ 📦 | Bundled HTML asset at `android/.../audiobook/kokoro-tts.html`; loads `kokoro-js`. |
| RN ↔ WebView IPC | ✅ 📦 | postMessage with `{type, id, payload}` envelope. |
| Renderer abstraction | ✅ 📦 | `ITTSRenderer` interface; `KokoroWebViewRenderer` is the default. |
| Native module (TurboModule) | ❌ | Future work; renderer abstraction makes it a one-file swap. |
| Phonetic override per character | ✅ 📦 | `Character.pronunciation`; renderer substitutes at render time. |

## Player

| Capability | Status | Notes |
|------------|--------|-------|
| App-scoped singleton service | ✅ 📦 | `audiobookPlayer` exported from `services/audiobook`. |
| State subscription | ✅ 📦 | `subscribe(listener)` returns unsubscribe. |
| Streaming render w/ lookahead | ✅ 📦 | Configurable; default 3 segments. |
| Pause / resume / stop | ✅ 📦 | |
| Skip ±30s within segment | ✅ 📦 | |
| Next/previous segment | ✅ 📦 | |
| Seek to segment index | ✅ 📦 | |
| Speed control (0.5–2.0×) | ✅ 📦 | Persisted per novel. |
| Sleep timer | ✅ 📦 | 5/10/15/30/45/60 min; "off". |
| MediaSession + lock-screen | ✅ | Reuses TTS infra. |
| Last-played pointer per novel | ✅ 📦 | MMKV `AUDIOBOOK_LAST_<id>`. |
| Auto-advance to next chapter | ✅ 📦 | Settings + per-chapter override. |

## UI

| Screen / component | Status | Notes |
|--------------------|--------|-------|
| Settings (`SettingsAudiobookScreen`) | ✅ (rewritten) 📦 | Provider chips, key + show/hide, model picker, test connection, quality, lookahead, cache. |
| Glossary editor (`GlossaryEditorScreen`) | ✅ 📦 | Edit name/aliases/personality/voiceHints/pronunciation/gender; remove; recast. |
| Voice picker (`VoicePickerSheet`) | ✅ 📦 | Archetype + custom-blend tabs. |
| Cost preview modal (`CostPreviewModal`) | ✅ 📦 | Shown before any batch annotation. |
| Mini-player (`AudiobookMiniPlayer`) | ✅ 📦 | Persistent at bottom while playing. |
| Full player (`AudiobookPlayerScreen`) | ✅ 📦 | Transport, speed, sleep timer, status. |
| Novel-screen audiobook menu | ✅ 📦 | Process N / unread / all + edit cast + clear cache. |
| Reader integration | ✅ 📦 | Subscribes to player; segment highlighting; auto-advance. |
| Voice preview-on-tap (sample audio) | ❌ | Future; needs sample-rendering with the host. |

## Persistence

| Item | Where | Reuses |
|------|-------|--------|
| Settings | MMKV `AUDIOBOOK_SETTINGS` | useMMKVObject |
| Last-played pointer | MMKV `AUDIOBOOK_LAST_<novelId>` | getMMKVObject |
| Per-novel prefs (speed) | MMKV `AUDIOBOOK_PREFS_<novelId>` | getMMKVObject |
| Glossary, voice map, annotation | JSON via `@specs/NativeFile` | NativeFile |
| Audio (WAV per segment) | files via `@specs/NativeFile` + `expo-file-system/legacy` for base64 writes | shared |
| Backup integration | NOT included by default | the existing pattern; opt-in is a future enhancement |

## Tests

| Module | Coverage |
|--------|----------|
| `voiceCaster` | matchArchetype × 10 cases; perturbation; normalisation; integration |
| `chapterPath` | hash determinism |
| `chapterSanitiser` | HTML strip; T/N; footnotes; scene breaks |
| `streamingParser` | extractor; balanced-JSON; streaming parser |
| `emotionModulation` | reserved-speaker capping |
| `pricing` | recommended models; lookup |
| `llmAnnotator` | Anthropic + Ollama request shapes; `cache_control` toggling; 429 retry; 401 fail-fast; missing-key error; tool_use unwrap; text-block fallback (9 cases) |
| `pipeline` | cache reuse on second run; path-hash keying survives plugin reorder; glossary discovery extends voice map; cost estimate (free for Ollama, non-zero for Anthropic) (6 cases) |
| Renderer in WebView | Validated by `scripts/audiobook-smoke.mjs` running the same monkey-patch in Node |
| Real device playback | Manual QA only |

`pnpm jest --testPathPattern src/services/audiobook` → 80 tests passing.
Full suite (`pnpm jest`) → 279 tests across 20 suites passing, no
regressions.

## Runtime smoke

`node scripts/audiobook-smoke.mjs` loads the same `kokoro-js` package
the WebView host loads, applies the monkey-patch we ship, and produces
WAV files for 5 character archetypes plus a blend-vs-pure comparison.
The blend↔pure mean-abs-diff per sample is ≈0.057 — clearly distinct.

This script is the source of truth for "does Kokoro work + does our
blending change the output". Run it after every kokoro-js bump.

## Bugs caught and fixed during runtime testing

(May 2026 — `kokoro-js` v1.2.1)

- **`q8f16` is not a valid dtype.** kokoro-js v1.2.1 only accepts
  `fp32` / `fp16` / `q8` / `q4` / `q4f16`. Default changed to `q8`
  (~92 MB). The voice-quality picker in settings exposes the real
  options.
- **The `id:weight,id:weight` blend string is rejected by the public
  API.** kokoro-js's `_validate_voice` checks the static catalog and
  rejects unknown ids. Voice blending requires going through the
  lower-level `generate_from_ids` with a pre-blended style tensor.
  The WebView host monkey-patches both methods.
- **`Tensor` and `RawAudio` cannot be re-imported from
  `@huggingface/transformers`** in the same process — it triggers a
  phonemizer Emscripten init crash. The fix is to sniff the
  constructors from the live `tts` instance (already-tokenised
  `input_ids` carries the Tensor class on its prototype; a regular
  `generate()` result carries RawAudio on its prototype).

## What's NOT in v1 (and should not be added without re-discussion)

- Multi-language voice casting and per-language keyword maps.
- Multi-LLM routing.
- Native Kokoro TurboModule.
- Voice preview-on-tap with live sample render.
- ElevenLabs / OpenAI / Edge TTS.
- Glossary/audio backup integration with the Drive/SelfHost backup
  pipeline (audio is excluded by design; future opt-in).
- Schema migrations — feature is fresh; no installed-user data.
