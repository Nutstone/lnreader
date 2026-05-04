# Testing

Tests live under `src/services/audiobook/__tests__/` so the
`rn` Jest project picks them up alongside hooks and services.

```
src/services/audiobook/__tests__/
├── chapterPath.test.ts
├── chapterSanitiser.test.ts
├── emotionModulation.test.ts
├── pricing.test.ts
├── streamingParser.test.ts
└── voiceCaster.test.ts
```

Run:

```sh
pnpm jest --testPathPattern src/services/audiobook
```

Result: 65 tests passing.

## Coverage map

| Module | Test type | Notes |
|--------|-----------|-------|
| `voiceCaster.matchArchetype` | parameterised | 10 keyword combos. |
| `voiceCaster.normaliseWeights` | unit | always sums to 100. |
| `voiceCaster.perturbWeights` | unit | deterministic seed; sum=100 over many seeds. |
| `voiceCaster.blendString` | unit | id:weight format. |
| `voiceCaster.buildRecipeForArchetype` | unit | always 3 components. |
| `VoiceCaster integration` | unit | reserved speakers + override + extend. |
| `chapterPath.hashChapterPath` | unit | hex; deterministic; differs across paths. |
| `chapterSanitiser.sanitiseChapter` | unit | HTML, footnotes, T/N, scene breaks. |
| `chapterSanitiser.chunkAtSceneBreaks` | unit | scene-break splitting. |
| `streamingParser.extractLargestJSON` | unit | balanced JSON in arbitrary text. |
| `streamingParser.parseLLMJSON` | unit | fenced and unfenced. |
| `streamingParser.StreamingSegmentParser` | unit | partial chunks. |
| `emotionModulation.getEmotionModulation` | unit | reserved-speaker capping. |
| `emotionModulation.pauseTypeToMs` | unit | multiplier. |
| `pricing` | unit | recommended models; lookup. |

## What's NOT tested in v1 (and how to test later)

| Area | Approach |
|------|----------|
| `LLMAnnotator` provider calls | Mock `fetchTimeout` from `@utils/fetch/fetch`. Cover 200/400/429/503 paths and the structured-output unwrapping. |
| `AudiobookPipeline` cache behaviour | Mock `@specs/NativeFile` with an in-memory FS. Cover annotation cache hits, glossary discovery threshold, audio cache invalidation. |
| `AudioCache` LRU eviction | Same in-memory FS; assert oldest chapters dropped first when over budget. |
| `KokoroWebViewRenderer` IPC | Substitute the host bridge with an in-process mock; assert request/response correlation by id; assert WAV file is written. |
| `AudiobookPlayer` state machine | Mock `expo-av`'s `Audio.Sound` and the renderer; cover play → pause → resume → stop → next-segment transitions. |
| UI screens | RN Testing Library; cover voice picker tab switching, glossary edit submission, mini-player play/pause. |

## Manual QA per release

Phase 1 — engine:

- [ ] Process a 5-chapter novel; both Anthropic and Ollama paths succeed.
- [ ] Re-process; logs show all caches hit (no second LLM call).
- [ ] Stop network mid-annotation; auto-retry resumes when restored.

Phase 2 — voices:

- [ ] First-time process: glossary editor opens automatically.
- [ ] Each archetype produces an audibly different sample.
- [ ] Override one character's voice → only that character's segments
  re-render on next play.

Phase 3 — playback:

- [ ] Lock phone during playback → audio continues.
- [ ] Switch apps → mini-player visible from new screen.
- [ ] Sleep timer accuracy: ±2 s over a 30-min window.
- [ ] Speed 1.5× sounds natural (no chipmunk).
- [ ] App killed; relaunch; "Continue listening" resumes from saved
  point.

Phase 4 — discovery:

- [ ] Process a novel where a major character first appears in chapter
  20; toast appears within 3 chapters of first sighting; voice
  auto-cast; reviewable in glossary editor.

## Anti-patterns

- Don't hit live LLM APIs in tests. Even with a CI key, you'll burn
  quota and tests become flaky.
- Don't try to load the actual Kokoro ONNX model in unit tests. The
  WebView host can be mocked at the bridge level.
- Don't test through the React Native rendering layer for engine
  logic. The engine is pure TypeScript.

## Local benchmark target

`pnpm jest --testPathPattern src/services/audiobook` should run in under
3 seconds locally. Currently ~2 seconds.
