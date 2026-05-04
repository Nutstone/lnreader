# Testing the audiobook engine

The current implementation has zero test coverage. Each phase of the
roadmap should add tests; this document describes the testing
philosophy, fixtures, and per-module strategy.

## Philosophy

- **Pure first**: most of the audiobook engine is pure (matchers,
  blenders, parsers, sanitisers). Test pure code with unit tests; mock
  network and filesystem at the seams.
- **Fixture-driven**: real chapter text under
  `__tests__/audiobook/fixtures/` is the source of truth. Don't write
  inline strings for prompts and responses.
- **Snapshot for prompts**: the LLM prompt builders should snapshot the
  rendered prompt — easy regression detection on prompt edits.
- **Recorded calls for LLM**: store sanitised real LLM responses as
  fixtures; replay them rather than hitting the API in tests.
- **Manual QA list per phase**: anything that touches Kokoro audio
  output is verified by ear, on-device. Document the QA list per
  release.

## Project test infrastructure

LNReader already has Jest configured (`jest.config.js`) with two
projects: `db` and `rn`. Audiobook tests go under the `rn` project.

```
__tests__/audiobook/
├── fixtures/
│   ├── chapters/
│   │   ├── tensura-ch1-raw.html
│   │   ├── tensura-ch1-clean.txt
│   │   ├── overlord-ch1.txt
│   │   └── ...
│   ├── glossaries/
│   │   └── tensura.json
│   └── annotations/
│       └── tensura-ch1.json
├── voiceCasting.test.ts
├── voiceBlender.test.ts
├── llmAnnotator.test.ts
├── pipeline.test.ts
├── audioCache.test.ts
├── streamingParser.test.ts
├── sanitiseChapter.test.ts
└── promptBuilder.snapshot.test.ts
```

## Per-module test strategy

### `voiceBlender.ts`

Pure. Highest test value. Cover:

- 50+ keyword combos → expected archetype.
- Tie-breaking: same score across two archetypes → deterministic
  fallback.
- Weight perturbation: same name → same seed → same blend (deterministic).
- Weight normalisation: blend weights sum to exactly 100 even after
  rounding.
- Distinct-voice guarantee: 20 characters, no two pairs within
  `minDistance` (post-Phase 7).
- Override: applying an override leaves other entries untouched.
- Reserved speakers: narrator/system get fixed blends.

Tests run in <100 ms. No mocks needed.

```ts
describe('voiceBlender', () => {
  describe('matchArchetype', () => {
    it.each([
      [['warrior', 'fierce'], 'warrior'],
      [['wise', 'old'], 'mentor'],
      [['cold', 'cunning'], 'villain'],
      [['cheerful', 'playful'], 'trickster'],
      // ... 46 more
    ])('matches %j to %s archetype', (personality, expected) => {
      const c = mockCharacter({ personality });
      expect(matchArchetype(c)).toBe(expected);
    });

    it('breaks ties deterministically', () => { ... });
    it('falls back to gentle when no keywords match', () => { ... });
  });

  describe('perturbWeights', () => {
    it('produces deterministic blends from a seed', () => {
      expect(perturbWeights(base, 42)).toEqual(perturbWeights(base, 42));
    });
    it('normalises weights to exactly 100', () => {
      const blend = perturbWeights(base, randomSeed());
      expect(blend.reduce((s, c) => s + c.weight, 0)).toBe(100);
    });
  });
});
```

### `llmAnnotator.ts`

Mock `fetchTimeout` (`@utils/fetch/fetch`). Cover:

- Each provider hits the right URL with the right headers.
- API key missing → throws `LLM API key not configured`.
- 429 → retries with exp backoff (use `jest.useFakeTimers`).
- 503 → retries.
- 400 → fails immediately (no retry).
- Cache headers (`cache_control`) appear in Anthropic body.
- Gemini structured output parses to `{segments: [...]}`.
- Truncated JSON → recovers via tool/structured output (post-Phase 1).
- Streaming response yields complete segments.

```ts
import { fetchTimeout } from '@utils/fetch/fetch';
jest.mock('@utils/fetch/fetch');

describe('LLMAnnotator', () => {
  it('retries on 429', async () => {
    (fetchTimeout as jest.Mock)
      .mockResolvedValueOnce({ status: 429, json: async () => ({ error: { message: 'rate' } }) })
      .mockResolvedValueOnce({ status: 200, json: async () => mockGoodResponse });

    const annotator = new LLMAnnotator({ provider: 'anthropic', apiKey: 'k' });
    const result = await annotator.annotateChapter(0, 'text', mockGlossary);

    expect(fetchTimeout).toHaveBeenCalledTimes(2);
    expect(result.segments).toHaveLength(5);
  });
});
```

### `pipeline.ts`

Mock `NativeFile` (the file abstraction) and `LLMAnnotator`. Cover:

- Glossary cached → no LLM call on second `processNovel`.
- Voice map cached → no rebuild on second pass.
- Annotation cached per chapter — second pass skips annotated chapters.
- Cache invalidation: `clearCache` removes all artefacts.
- Corrupt cache file → deleted, regenerated on next run.
- Annotation indexed by `chapter.path` hash, not integer index.

```ts
const mockFs = new InMemoryFileSystem();
jest.mock('@specs/NativeFile', () => mockFs.specs);

describe('AudiobookPipeline', () => {
  beforeEach(() => mockFs.clear());

  it('reuses cached glossary', async () => {
    const pipeline = new AudiobookPipeline(mockConfig);
    await pipeline.processNovel(['ch1', 'ch2', 'ch3']);
    const callCountBefore = mockAnnotator.buildGlossary.mock.calls.length;
    await pipeline.processNovel(['ch1', 'ch2', 'ch3']);
    expect(mockAnnotator.buildGlossary.mock.calls.length).toBe(callCountBefore);
  });
});
```

### `sanitiseChapter`

Highest fixture coverage. Each fixture pair `(raw.html, clean.txt)` is a
test case.

```ts
describe('sanitiseChapter', () => {
  const fixtures = readFixtures('__tests__/audiobook/fixtures/chapters');
  it.each(fixtures)('sanitises %s correctly', ({ raw, expected }) => {
    expect(sanitiseChapter(raw)).toBe(expected);
  });
});
```

Fixtures cover:

- Plain HTML (typical web novel).
- Translator notes ([T/N: ...]).
- Footnotes (`<sup>1</sup>` style).
- Author's notes blocks.
- Image alt text preservation.
- Multi-paragraph dialogue.
- Sound effect annotations (`*BANG*`).

### `audioCache`

Mock filesystem. Cover:

- Write segment → manifest updated atomically.
- LRU eviction at size cap.
- Invalidate-by-character: only matching segments deleted.
- Voice version bump invalidates correctly.
- Concurrent reads/writes on the same chapter (manifest is the lock).

### `streamingParser`

Pure. Cover:

- Stream of partial JSON yields complete segments.
- Handles smart quotes.
- Handles nested objects within segments.
- Survives unicode in text fields.
- Handles malformed mid-stream gracefully (yields what was parsed).

### `promptBuilder.snapshot.test.ts`

Snapshot tests for the system prompts.

```ts
describe('prompt snapshots', () => {
  it('glossary builder prompt', () => {
    expect(buildGlossaryPrompt(['ch1', 'ch2', 'ch3'])).toMatchSnapshot();
  });
  it('chapter annotator prompt', () => {
    expect(buildAnnotationPrompt('text', mockGlossary, 0)).toMatchSnapshot();
  });
});
```

When you intentionally edit a prompt: `pnpm test --updateSnapshot`,
review the diff, commit.

## Manual QA per release

Phase-gated. Each phase adds an entry to the manual QA list — never
removes one.

### Phase 1 — Foundation

- [ ] Process a 5-chapter novel; both Anthropic and Gemini paths succeed.
- [ ] Re-process; logs show all caches hit.
- [ ] Stop network mid-annotation; auto-retry resumes when restored.

### Phase 2 — Prompt caching

- [ ] Anthropic: chapter 2 of a novel shows `cache_read_input_tokens > 0`.
- [ ] Gemini: chapter 2 references `cachedContent`.
- [ ] Cost estimate within ±20% of actual.

### Phase 3 — Audio cache

- [ ] Replay a chapter: starts in <200 ms.
- [ ] Override Veldora's voice: only Veldora's segments re-render.
- [ ] Clear cache: storage drops, next play renders fully.

### Phase 4 — Native Kokoro

- [ ] First run: model downloads with progress bar.
- [ ] Audio quality A/B against kokoro-js desktop reference.
- [ ] Render 50 chapters back-to-back: no memory growth.

### Phase 5 — Glossary & voices

- [ ] First-time process: review screen appears.
- [ ] Each voice card sample plays in <800 ms.
- [ ] Custom blend slider: live preview within 1 s.
- [ ] Merge two characters: subsequent playback uses merged voice.

### Phase 6 — Player

- [ ] Lock phone during playback; audio continues.
- [ ] Switch apps; audio continues; mini-player persists.
- [ ] Sleep timer: stops within ±2 s.
- [ ] Speed control: 1.5× sounds natural (no artefacts).
- [ ] App killed; relaunch; "Continue listening" resumes from saved point.

### Phase 7 — Discovery

- [ ] Process a novel where Char-25 is introduced in chapter 25;
  toast appears; voice auto-cast; reviewable.
- [ ] 30+ character novel: no audible duplicate voices.

## Anti-patterns

- **Don't hit live LLM APIs in tests.** Even with a CI key, you'll burn
  quota and tests become flaky.
- **Don't snapshot LLM responses inline.** Store under
  `__tests__/audiobook/fixtures/llm-responses/`.
- **Don't test through the React Native rendering layer for engine
  logic.** Test the engine as plain TypeScript; test the screens
  separately at the component level.
- **Don't write a test that loads the actual ONNX model.** Stub the
  renderer in pipeline tests. The native module gets its own integration
  tests on a real device.

## Useful test helpers

```ts
// __tests__/audiobook/_helpers.ts

export function mockCharacter(overrides: Partial<Character> = {}): Character {
  return {
    name: 'TestChar',
    aliases: [],
    gender: 'neutral',
    personality: [],
    description: '',
    ...overrides,
  };
}

export function mockGlossary(characters: Partial<Character>[] = []): CharacterGlossary {
  return {
    novelId: 'test',
    narratorGender: 'male',
    characters: characters.map(mockCharacter),
    createdAt: '2026-05-04T00:00:00Z',
  };
}

export class InMemoryFileSystem {
  private files = new Map<string, string>();
  // ... implements NativeFile.{exists, mkdir, readFile, writeFile, unlink}
}
```

Drop these helpers under `__tests__/audiobook/_helpers.ts` and import
them across the suite.

## Local benchmark target

`pnpm test --testPathPattern audiobook` should run in under 5 seconds.
If it grows past that, split slow integration-style tests into a
`*.integration.test.ts` suffix and exclude from the default run.

## Coverage target

This is a power-user feature; 100% coverage is unrealistic. Targets:

- Pure modules (voiceBlender, sanitiseChapter, streamingParser): **95%**
- Pipeline orchestrator: **80%**
- LLM adapters (3 providers): **70%** (the network paths are mocked,
  the parsers are tested separately).
- Player service: **60%** (timing-sensitive code excluded; manual QA
  covers the rest).

Aggregate: aim for **75% audiobook coverage** by end of Phase 8.
