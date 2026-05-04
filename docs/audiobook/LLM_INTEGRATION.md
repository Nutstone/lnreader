# LLM Integration

Two providers. Anthropic Claude (default) plus optional Ollama. The
contract is the same shape — `LLMAnnotator` exposes `buildGlossary`,
`extendGlossary`, `annotateChapter` regardless of provider.

## Defaults

```ts
// pricing.ts
recommendedModelFor('anthropic') === 'claude-sonnet-4-6';
recommendedModelFor('ollama') === 'llama3.1:70b';
```

Reasons:

- **Sonnet 4.6**: best literary judgement on Anthropic; reasonable cost
  with prompt caching.
- **Llama 3.1 70B**: smallest local model that produces acceptable
  speaker attribution. Smaller models miss too many speakers.

Never auto-pick Haiku. The user can pick it explicitly.

## Prompt caching (Anthropic)

The system prompt for chapter annotation is ~1.5 KB and identical for
every chapter in a novel. Without caching that's wasted tokens. With
caching:

```ts
// llmAnnotator.ts
const systemBlocks = useCache
  ? [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
  : [{ type: 'text', text: req.systemPrompt }];
```

Constraints:

- Min cacheable block on Sonnet 4.6: 2048 tokens. The annotation system
  prompt is over 2k after the few-shot examples.
- TTL is 5 minutes by default. For batch processing of multiple
  chapters in one run, cache hits are guaranteed.
- Cache hit ratio is reported in `response.usage.cache_read_input_tokens`
  — the diagnostics surface uses this.

Disable via `enablePromptCaching: false` in settings (mostly for
debugging — leave it on).

## Structured output

Both providers emit JSON via a tool/schema rather than free-form text:

- Anthropic: `tools` + `tool_choice: { type: 'tool', name }`. The
  response's `tool_use` block has guaranteed-valid arguments matching
  the schema.
- Ollama: `format: 'json'` + system prompt that embeds the schema.
  Output is parsed via `parseLLMJSON` (forgiving — strips fences,
  extracts the largest balanced JSON object).

This kills the regex-extraction fragility the original concept had.

## Retry & rate limit handling

```ts
const RETRY_DELAYS_MS = [1000, 2000, 4000];

async function withRetry(fn) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof RetryableError && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt] + Math.random() * 500);
        continue;
      }
      throw e;
    }
  }
}
```

`RetryableError` is thrown internally on 429/503. Other errors fail
immediately. The `onRetry` callback surfaces "rate limited, retrying"
to the UI.

## Streaming

Not enabled in v1 — annotation responses are typically 3–8 KB and the
full request takes 1.5–3 seconds. The latency win from streaming is
real (~1 s of user-visible time saved) but the implementation surface
is wider. The `streamingParser.ts` module exists for when streaming is
turned on; right now it's used only for the forgiving JSON parser.

## Sanitisation

Chapters are passed through `sanitiseChapter()` before any LLM call.
Strips:

- HTML tags (via `sanitize-html`).
- `<sup>N</sup>` footnotes (pre-strip, before HTML cleanup).
- `[N]` inline footnote markers.
- Translator notes (`[T/N: ...]`, `(T/N: ...)`).
- Author's note blocks.
- Common boilerplate (next-chapter links, "translated by", patreon
  links).

Easy ~30% input-token reduction on plugin-provided HTML. Plugins can
provide their own boilerplate regexes via the `pluginBoilerplate`
option.

## Glossary discovery

The original concept built the glossary once from the first 3 chapters
and called it done. That breaks for any novel that introduces a major
character mid-story.

`pipeline.processChapters` watches each chapter's annotation for
unknown speakers. When 3+ unknowns accumulate, it calls
`annotator.extendGlossary(existing, newSpeakers, recentExcerpts)`. The
new characters are appended to `glossary.json` and the voice map is
extended (existing entries preserved).

If the LLM call fails, the unknown speakers fall back to the narrator
voice — best-effort, never blocking.

## Cost estimation

`pipeline.estimateCost(chapters)` returns a `CostEstimate`:

```ts
{
  provider, model,
  totalTokensIn, totalTokensOut,
  costUSDWithoutCache, costUSDWithCache,
  isFree, // true for Ollama
  notes
}
```

Estimation:

- Token count is an approximation (`pricing.estimateTokens`: 4 chars per
  token). ±20% accuracy is fine for a UX preview.
- Cached tokens = chapter count × system prompt tokens (the savings
  scale linearly with chapter count).
- Pricing comes from a static `pricing.ts` table. Verify against
  current provider pricing before trusting for billing.

## Where prompts live

```
src/services/audiobook/prompts/
├── chapterAnnotator.ts
└── glossaryBuilder.ts
```

Both export the system prompt + a builder for the user message + the
JSON schema for the structured-output tool. To change a prompt, edit
the constant; existing cached annotations don't auto-invalidate (annotation
cache key is based on chapter path, not prompt version). On significant
prompt changes, bump a `PROMPT_VERSION` and include it in the cache
key.

## Observability

`LLMAnnotator` accepts an `events: { onRetry, onUsage }` constructor
arg. The pipeline doesn't wire diagnostics yet — future enhancement is
a Diagnostics screen behind a 7-tap unlock on the settings header.
