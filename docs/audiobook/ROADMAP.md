# Roadmap

A phased plan that takes the current 70%-built feature to "ship-quality"
without big-bang rewrites. Each phase is independently shippable and has
explicit acceptance criteria.

The phases are sequential. Don't reorder — Phase 2 depends on Phase 1's
type changes; Phase 4 depends on Phase 3's audio cache; etc.

## Phase 1 — Foundation fixes (1–2 days)

Goal: get the existing implementation onto a foundation that can support
the rest of the work. No new user-facing features. All work in
`src/services/audiobook/` and tests.

### Tasks

- [ ] **Update model defaults** in `llmAnnotator.ts`:
  - `anthropic` → `claude-sonnet-4-6`
  - `gemini` → `gemini-2.5-pro`
  - `ollama` → `llama3.1:70b`
- [ ] **Switch annotation indexing** from chapter integer ID to
  `sha1(chapter.path).slice(0,16)`. Update `pipeline.getAnnotation`,
  `processAudiobook.ts`, `AudiobookPlayer.startChapter`. Add a one-shot
  migration that walks `AUDIOBOOK_STORAGE/<novelId>/annotations/` and
  re-keys.
- [ ] **Add retry & backoff** to `llmAnnotator.callLLM`. 3 retries, exp
  backoff, only on 429/503. Surface "rate limited" to progress callback.
- [ ] **Validate LLM output with structured tools** (Anthropic
  `tool_choice`, Gemini `responseSchema`). Drop the regex parser.
- [ ] **Sanitise chapter text** before LLM call. Strip HTML, footnotes,
  T/N blocks. Implement `sanitizeChapter(rawText, plugin)` in pipeline.
- [ ] **Hoist Kokoro model lifecycle** out of `pipeline.streamChapterAudio`.
  Make `TTSRenderer` a singleton; init once on first chapter; dispose
  on app background after 5 min idle.
- [ ] **Type changes**: introduce `AudiobookSettingsV2`, `AudioCacheEntry`,
  `ChapterAudioManifest`, `PlayerState` (see `ARCHITECTURE.md`).

### Acceptance

- [ ] `pnpm test` passes (existing + new tests for sanitisation, retry,
  structured output parsing).
- [ ] `pnpm type-check` passes.
- [ ] Annotating a chapter twice in a row uses the cache (verified by
  log).
- [ ] Annotating chapter 0 then chapter 1 of a novel does NOT reload the
  Kokoro model between calls (verified by log).
- [ ] LLM call returns valid JSON 100% of the time on a 50-chapter test
  corpus (no regex fallbacks needed).

## Phase 2 — Prompt caching & cost transparency (1 day)

Goal: reduce per-chapter cost by 90% and show the user what it costs
before they spend.

### Tasks

- [ ] Implement Anthropic `cache_control` on system prompt + glossary
  block. Pad to 2048 tokens.
- [ ] Implement Gemini `cachedContents.create` lifecycle (create at
  start of `processNovel`, delete at end).
- [ ] Add cost-estimation function: `estimateCost(chapters, provider, model)`
  with a versioned pricing table at
  `src/services/audiobook/pricing.json`.
- [ ] Pre-flight cost estimate modal on `processNovel` and on the
  novel-screen "Process N chapters" menu.
- [ ] Diagnostics screen behind a 7-tap on the audiobook settings header
  (mirroring Android dev mode unlock pattern). Shows recent calls with
  token counts, cache hit rates, latency, dollar cost.

### Acceptance

- [ ] Annotating chapters 2..N of a novel shows
  `cache_read_input_tokens > 0` (Anthropic) or
  `cachedContentTokenCount > 0` (Gemini).
- [ ] Pre-flight modal shows estimate for "process all chapters" within
  ±20% of actual cost on a real run.
- [ ] Diagnostics screen renders correctly with no crashes when no calls
  have been made.

## Phase 3 — Persistent audio cache (2–3 days)

Goal: a chapter rendered once is rendered forever (until user clears
cache or changes voices).

### Tasks

- [ ] Introduce `audioCache.ts` with the disk layout from
  `ARCHITECTURE.md`:
  ```
  AUDIOBOOK_STORAGE/<novelId>/audio/<chapterPathHash>/
    manifest.json
    seg_0001.opus
    seg_0002.opus
    ...
  ```
- [ ] Add OPUS encoding step in `ttsRenderer.ts`. Use a small native
  encoder (or a pure-JS fallback like `opus-recorder` only if
  RN-compatible).
- [ ] Tag each cache entry with `voiceVersion`. Bump version when a
  character's voice override changes; invalidate matching segments only.
- [ ] Implement LRU cache eviction with size cap (default 1 GB).
- [ ] Settings → cache management screen: per-novel sizes, "Clear",
  "Re-render".
- [ ] Update `AudiobookPlayer.playSegment` to play directly from cached
  OPUS files via `expo-av` — no more base64 round-trip.

### Acceptance

- [ ] Tap Listen on the same chapter twice: second time plays within
  200 ms with no Kokoro activity.
- [ ] Override one character's voice: only that character's segments are
  re-rendered; others are reused.
- [ ] Clear cache via settings: storage drops to 0; next playback
  triggers full render.
- [ ] OPUS file is at most 1/8 the size of equivalent WAV at 24 kHz.

## Phase 4 — Native Kokoro module (4–8 days, parallelisable)

Goal: replace `kokoro-js` (which doesn't work in Hermes) with a native
TurboModule that wraps `onnxruntime-android`.

This is the largest phase and can run in parallel with Phase 5/6. Until
it ships, the WebView fallback (sub-task below) keeps the feature
functional in dev.

### Tasks

- [ ] Create new package `packages/react-native-kokoro-tts/`:
  - `android/`: Kotlin TurboModule, `onnxruntime-android` dep, espeak-ng
    JNI wrapper.
  - `ios/`: stub for now; ship Android-only first.
  - `src/`: TS types and JS bridge.
- [ ] Implement model download flow with SHA-256 verification and resume.
- [ ] Implement style-vector blending in TS (pure function, easily
  testable).
- [ ] Add `WebViewTTSRenderer` as a fallback (Phase 4 ships with the
  fallback path while native module is in flight).
- [ ] Capability detection: prefer native, fall back to WebView,
  fall back to system TTS.
- [ ] Stress test: render a 50-segment chapter on a Pixel 5; should
  complete in under 90 seconds at q8f16.

### Acceptance

- [ ] First-time launch shows "Download voices (86 MB)" with progress.
- [ ] Audio quality matches kokoro-js reference output (manual A/B).
- [ ] No crashes after 100 consecutive chapter renders (memory stable).
- [ ] Cold synthesis < 1.5 s, warm < 0.6× realtime on a Snapdragon
  7-series.

## Phase 5 — Glossary review & voice picker UI (3–4 days)

Goal: ship the human-in-the-loop step. This is the biggest UX
improvement and the strings are already translated.

### Tasks

- [ ] Build `screens/glossaryEditor/GlossaryEditorScreen.tsx` per
  `UX_GUIDELINES.md` §2.
- [ ] Build `components/audiobook/VoicePickerSheet.tsx` per §3, with
  archetype tab and custom blend tab.
- [ ] Build sample-render-on-demand for each voice — uses the renderer
  with a fixed sample text ("This is how I sound. — sample text").
- [ ] Wire glossary review into the first-time pipeline:
  glossary build → review screen → confirm → annotate.
- [ ] Add `Edit cast…` to novel screen audiobook menu.
- [ ] Implement merge-characters flow with annotation patching.

### Acceptance

- [ ] First-time user runs through "tap Listen → review cast → confirm
  → playback" without ever seeing JSON or hitting the back button.
- [ ] Changing a character's voice in the picker updates the audio cache
  appropriately (only that character's segments invalidate).
- [ ] Sample play button on every voice card produces audio within
  800 ms.

## Phase 6 — Player service + mini-player (3–4 days)

Goal: audiobook playback survives screen transitions, app backgrounding,
and screen lock.

### Tasks

- [ ] Extract `AudiobookPlayerService` as an app-scoped singleton.
  Subscribe to its event emitter from any screen.
- [ ] Build `AudiobookMiniPlayer` component; mount it globally in
  `App.tsx` above the bottom tab bar.
- [ ] Build `AudiobookPlayerScreen` (full-screen player).
- [ ] Wire MediaSession with audiobook-distinct skip-30s actions.
  Lock-screen shows speaker name; long-press skip jumps chapters.
- [ ] Sleep timer: 5 / 10 / 15 / 30 / 45 / 60 / "end of chapter".
  Persist across app restart.
- [ ] Playback speed control: 0.7×, 0.85×, 1.0×, 1.15×, 1.25×, 1.5×,
  1.75×, 2.0×.
- [ ] Save & restore last-played pointer per novel.

### Acceptance

- [ ] Start playback in reader → switch to library → mini-player
  visible, audio still playing.
- [ ] Lock screen → audio continues; lock-screen controls work.
- [ ] App killed in background → resume from last-played position with
  one tap.
- [ ] Sleep timer accuracy: ±2 s over a 60-min window.

## Phase 7 — Glossary discovery & quality polish (2–3 days)

Goal: novels with characters introduced after chapter 3 work correctly.

### Tasks

- [ ] Implement `detectNewSpeakers` in pipeline.
- [ ] Buffer threshold (3 unknowns) triggers glossary update prompt.
- [ ] Re-cast voices for new characters with archetype matcher.
- [ ] Notify the user via a non-blocking toast: "Found 2 new characters:
  Kaede, Daichi. [Review]".
- [ ] Improved keyword scoring (`VOICE_CASTING.md` §2).
- [ ] Distinct-voice guarantee (`VOICE_CASTING.md` §4).
- [ ] Reserved-speaker handling (narrator, system, crowd).

### Acceptance

- [ ] On a novel with > 30 characters, no two voices feel identical
  (manual A/B).
- [ ] Character introduced in chapter 25 is auto-discovered and gets a
  matched-archetype voice within one chapter of first appearance.
- [ ] User can review and override new characters at any time.

## Phase 8 — Tests & docs (ongoing per phase)

Each phase ships with its tests; this phase rolls them up.

### Tasks

- [ ] `__tests__/audiobook/voiceCasting.test.ts` — 50+ cases.
- [ ] `__tests__/audiobook/llmAnnotator.test.ts` — fixture-driven; mocks
  fetch.
- [ ] `__tests__/audiobook/pipeline.test.ts` — cache hit/miss, indexing.
- [ ] `__tests__/audiobook/audioCache.test.ts` — eviction, invalidation.
- [ ] `__tests__/audiobook/streamingParser.test.ts` — streaming JSON.
- [ ] Update `TESTING.md` with audiobook fixtures.

### Acceptance

- [ ] CI runs all tests in < 90 s.
- [ ] No flaky tests over 20 consecutive runs.

## Out of scope (don't build now)

- iOS support — defer to Phase 4 success on Android first.
- Multilingual voices — wait for Kokoro v1.1+ ONNX.
- Per-segment lip-sync / video — research project.
- Cross-device cache sync — depends on the broader LNReader sync story.
- Voice cloning — legal and quality minefield.
- Ambient sound effects — audiobook engine should stay focused on
  voices.

## Estimated total effort

| Phase | Effort (eng-days) | Risk |
|-------|-------------------|------|
| 1 — Foundation fixes | 1–2 | Low |
| 2 — Prompt caching & cost | 1 | Low |
| 3 — Persistent audio cache | 2–3 | Med (OPUS encoder choice) |
| 4 — Native Kokoro module | 4–8 | High (TurboModule, JNI) |
| 5 — Glossary & voice UI | 3–4 | Low |
| 6 — Player service | 3–4 | Med (background audio + MediaSession) |
| 7 — Discovery & polish | 2–3 | Low |
| 8 — Tests & docs | rolling | Low |
| **Total** | **16–25 eng-days** | |

## Sequencing notes

Phase 4 (native module) is the long pole. Start it first; it can run in
parallel with Phases 2, 3, 5, 6, 7 because the WebView fallback keeps
the feature working.

The single most user-visible improvement is **Phase 5 (glossary review +
voice picker)**. If shipping a teaser release, ship 1 + 2 + 5 first.

The single most cost-saving improvement is **Phase 2 (prompt caching)**.
A user with a 200-chapter novel saves ~$8 per processing run.

## Definition of done for the whole feature

A user opens LNReader for the first time, adds a novel, and within five
taps is listening to the chapter with three distinct, character-matched
voices. They can lock their phone, walk to the bus, set a sleep timer,
and the audiobook plays through. They never see an unhandled error,
never wonder how much it costs, never re-render a chapter they already
listened to.

That's the bar.
