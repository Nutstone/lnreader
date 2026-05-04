# LLM Integration

The cloud step does two things: (1) extract a character glossary from the
first few chapters, and (2) per-chapter, segment the text into speaker /
emotion / pause-typed chunks. This document tells you which models to
default to, how to cache prompts to slash cost, how to chunk long
chapters, and how to fail gracefully.

## Model defaults — May 2026

The brief is explicit: **best models only, no Haiku 4.5**. The defaults
below assume Anthropic for quality and Gemini for cost; both produce
cast results good enough for a literary task.

| Provider | Default model | Why | Per-chapter cost (~3k tokens system + 4k tokens chapter) |
|----------|---------------|-----|----------------------------------------------------------|
| Anthropic | `claude-sonnet-4-6` | Best quality / cost trade-off for literary cast & emotion. | ~$0.04 (no cache), **~$0.005 cached** |
| Anthropic premium | `claude-opus-4-7` | When users want top-tier nuance for complex novels. | ~$0.20 (no cache), **~$0.025 cached** |
| Google | `gemini-2.5-pro` | Comparable to Sonnet 4.6 for this task; longer free tier. | ~$0.03 (no cache), **~$0.004 cached** |
| Google budget | `gemini-2.5-flash` | OK for action-heavy LNs; struggles with tonal subtlety. | ~$0.01 (no cache), **~$0.001 cached** |
| Local | `llama3.1:70b` (via Ollama) | If the user has the hardware. 8B is too weak for literary cast. | $0 + electricity |

**Banned defaults** (do not auto-select):

- `claude-haiku-4-5` — explicitly forbidden by the project brief and
  noticeably worse at distinguishing speakers in fast multi-character
  dialogue.
- `claude-sonnet-4-20250514` — stale alias for old 4.0 Sonnet.
- `gemini-2.0-flash` and earlier — superseded.
- `llama3.1:8b` — current code's default. Misses speaker attribution
  ~20% of the time on tested chapters; produces empty `personality`
  arrays. Keep available, don't default to it.

Update both:

```ts
// src/services/audiobook/llmAnnotator.ts
const DEFAULT_MODELS: Record<LLMConfig['provider'], string> = {
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  ollama: 'llama3.1:70b',  // user-installed; warn if unavailable
};
```

## Prompt caching — required, not optional

The chapter-annotation system prompt is ~1.5 kB and is sent with every
chapter. For a 200-chapter novel that's 300 kB of duplicate input. Both
Anthropic and Gemini provide caching with a **~90% read discount**:

### Anthropic (`cache_control: { type: 'ephemeral' }`)

```ts
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: ANNOTATION_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },  // 5-min TTL
      },
      {
        type: 'text',
        text: glossarySummary,                  // changes rarely
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: chapterText }],
  }),
});
```

Constraints:

- Sonnet 4.6 minimum cacheable block: **2048 tokens**. Pad the system
  prompt with examples until it crosses the threshold.
- TTL is 5 min (default) or 1 hour. Use 1 hour when annotating a novel
  in one sitting; 5 min for ad-hoc single-chapter playback.
- Cache hits do not count against rate limits — annotate in tight
  batches.

Verify the hit ratio in the response: `response.usage.cache_read_input_tokens`
should be > 0 after the second chapter.

### Gemini (`cachedContents.create`)

Gemini's caching is **explicit** — create a cache, get an ID, reference
it from generation calls:

```ts
const cache = await genai.caches.create({
  model: 'gemini-2.5-pro',
  config: {
    systemInstruction: ANNOTATION_SYSTEM_PROMPT,
    contents: [glossarySummaryAsContent],
    ttl: '3600s',
  },
});

const response = await genai.models.generateContent({
  model: 'gemini-2.5-pro',
  contents: chapterText,
  config: { cachedContent: cache.name },
});
```

Constraints:

- Flash min: 1024 tokens. Pro min: 4096 tokens.
- Cache storage cost: $4.50/MTok-hr (Pro), $1.00/MTok-hr (Flash).
- Implicit caching is also on by default for 2.5 — without explicit
  caching the system gets ~50% savings opportunistically.

For a novel processing run, build the cache once at the start of
`processNovel()` and dispose it at the end with `caches.delete(cache.name)`.
Storing for the duration of a 200-chapter run (~30 min) costs about
$0.07 for the 8 kB system prompt — far less than the savings.

### Ollama

No prompt caching protocol — Ollama re-evaluates the system prompt every
call. This is fine because there's no per-token cost; just slower. Set
`keep_alive: '1h'` so the model stays loaded.

## Streaming

Annotation responses can be 3–8 kB of JSON. Streaming gives **two
advantages**:

1. The user sees progress sooner — first segment can render before the
   LLM finishes the chapter.
2. Lower TTFB lets the player start playing while later segments are
   still arriving.

Anthropic and Gemini both support streaming (`stream: true` on Anthropic,
`generateContentStream` on Gemini). Parse incrementally:

```ts
async function* streamSegments(response: Response): AsyncIterable<AnnotatedSegment> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk);
    while (true) {
      const seg = tryExtractCompleteSegment(buffer);
      if (!seg) break;
      buffer = seg.remainder;
      yield seg.segment;
    }
  }
}
```

`tryExtractCompleteSegment` scans for a balanced `{ ... }` object inside
the `segments: [...]` array. This is a 30-line helper — write it once,
test it on truncated input.

The pipeline becomes:

```
LLM streams segment 0 → renderer starts → playback starts
                ↓
        segment 1 → render queued
                ↓
        segment 2 → ...
```

User sees first audio after ~3 s instead of 8 s on a 6 kB chapter. This
is the single biggest UX win you can get for free.

## Chunking long chapters

Light-novel chapters can be 2k–10k words. With prompt caching the system
prompt is free, but the chapter itself still costs input tokens. For
chapters over ~6k tokens (≈4500 words) split:

```ts
function chunkChapter(text: string, maxTokens = 4000): string[] {
  // split at scene breaks first ("***", "---", blank-line clusters)
  // then at paragraph boundaries
  // never mid-paragraph
}
```

Pass each chunk with the same cached system prompt. Maintain segment
indices across chunks. The annotation merge is trivial: concatenate
segment arrays. The glossary remains shared.

If the source plugin returns chapter HTML with `<hr>` or `<h2>` tags,
treat those as scene breaks for chunking — they're authorial intent.

## Content sanitisation before sending

The current pipeline sends raw chapter text to the LLM. Strip:

- HTML tags (`sanitize-html` is already a project dep)
- Image references (`<img alt="...">` — keep alt as plain text)
- Footnote markers
- Translator notes ("[T/N: …]")
- Author's notes blocks (commonly fenced with `***` or "AUTHOR'S NOTE")
- JSON-LD or schema.org metadata
- Repeated chapter-header / footer boilerplate (detect via N-chapter sample)

Easy 30% token reduction. Implement as a single pass in
`pipeline.ts:sanitizeChapter(rawText, plugin)` — the plugin can
optionally provide a `stripBoilerplate` regex.

Do not strip:

- Sound-effect annotations like `*BANG*` — these are emotion cues
- Onomatopoeia in dialogue — Kokoro handles them
- Quote marks — they're how the LLM detects dialogue

## Glossary discovery — incremental, not one-shot

The current code samples the first 3 chapters and freezes the glossary.
This breaks for any novel where a major character appears later (which
is most of them).

Replacement flow:

1. Build initial glossary from chapters 1–3.
2. During each chapter annotation, detect speakers not in the glossary.
3. Buffer "unknown speakers" — when 3+ unknown speakers accumulate, run
   a glossary update prompt that adds them.
4. Re-cast their voices using the existing archetype matcher.
5. Re-annotate any chapters where they appeared with `speaker: "narrator"`
   only if the user wants to (otherwise their lines remain narrator-voiced).

Implementation:

```ts
// pipeline.ts
async function detectNewSpeakers(annotation: ChapterAnnotation, glossary: CharacterGlossary): string[] {
  const known = new Set([
    'narrator',
    ...glossary.characters.map(c => c.name.toLowerCase()),
    ...glossary.characters.flatMap(c => c.aliases.map(a => a.toLowerCase())),
  ]);
  const unknown = new Set<string>();
  for (const seg of annotation.segments) {
    if (!known.has(seg.speaker.toLowerCase())) unknown.add(seg.speaker);
  }
  return [...unknown];
}
```

When the buffer exceeds a threshold, send a small prompt to the LLM with
the new speakers + their dialogue context, asking it to extend the
glossary. Persist the updated glossary, regenerate the voice map (only
adding new entries — preserve existing voice assignments).

## Retry and rate limit handling

Wrap every LLM call:

```ts
async function callLLMWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 2000, 4000];  // 7s total worst case
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      if (status === 429 || status === 503) {
        if (attempt < delays.length) {
          await sleep(delays[attempt] + Math.random() * 500);
          continue;
        }
      }
      // Non-retryable: 400, 401, 403, 404, etc.
      throw e;
    }
  }
  throw new Error('Unreachable');
}
```

Surface a "rate limited, retrying…" status to the UI on the first 429.
Don't fail silently.

## Validation of LLM output

Parsing LLM JSON is the leakiest part of the system. The current code
does:

```ts
const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
return JSON.parse(jsonStr);
```

That fails when the model returns truncated JSON, fenced JSON inside a
preamble, or smart quotes. Replace with a forgiving parser:

```ts
function extractJSON<T>(text: string, schema: ZodSchema<T>): T {
  // 1. Try the largest balanced { ... } substring
  // 2. Validate against schema
  // 3. On failure, ask the LLM to retry with `tool_choice` / structured output
}
```

Anthropic and Gemini both support **structured output** / **tool use**
which guarantees JSON. Switch to that — schema in code, no parsing.

```ts
// Anthropic structured output (via tool_choice)
{
  tools: [{
    name: 'emit_annotation',
    description: 'Emit the chapter annotation',
    input_schema: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              speaker: { type: 'string' },
              emotion: { type: 'string', enum: [...] },
              isDialogue: { type: 'boolean' },
              pauseBefore: { type: 'string', enum: [...] },
            },
            required: ['text', 'speaker', 'emotion', 'isDialogue', 'pauseBefore'],
          },
        },
      },
      required: ['segments'],
    },
  }],
  tool_choice: { type: 'tool', name: 'emit_annotation' },
}
```

The response is guaranteed to be valid JSON matching the schema. No
regex.

## Cost estimation for the user

Show the user a **before-spend estimate** when they tap "Process all
chapters":

```ts
function estimateCost(chapters: Chapter[], provider: Provider, model: Model): {
  tokensIn: number;
  tokensOut: number;
  withoutCache: number;
  withCache: number;
  freeTierAvailable?: boolean;
} {
  const chapterTokens = chapters.reduce((s, c) => s + estimateTokens(c.text), 0);
  const systemTokens = ANNOTATION_SYSTEM_PROMPT_TOKENS + GLOSSARY_TOKENS;
  // ... compute via the model's published pricing table
}
```

Bake the pricing table into source as a JSON file and date-stamp it.
Show:

> Processing 217 chapters with **Claude Sonnet 4.6**.
> 
> ≈ 1.2 M input tokens, 180 k output tokens.
> **With prompt caching: $1.42** (cached). Without caching: $9.20.
> [Process now] [Choose cheaper model →]

For Gemini's free tier, also show the remaining quota after the run
("uses 18% of your monthly free tier").

## Where the prompts live

`src/services/audiobook/prompts/`:

- `glossaryBuilder.ts` — the system prompt for character extraction.
- `chapterAnnotator.ts` — the system prompt for segmentation.
- `glossaryUpdater.ts` (new) — extends the glossary when new speakers
  appear mid-novel.

Keep prompts as multi-line template literals with explicit JSON schema
inside them. Version them (`PROMPT_VERSION = 3`) and include the version
in the cache key for annotations — bumping the prompt invalidates old
caches.

The current prompts ship without examples (zero-shot). Add 1–2 shot
examples to the system prompt — for emotion classification this raises
quality measurably and is free with prompt caching.

## Observability

In dev builds, log:

- LLM provider, model, request size, response size, latency.
- Cache hit/miss for each call.
- Tokens consumed (cached + uncached).
- Estimated cost in USD.

Pipe to a non-PII debug overlay accessible from settings (`Audiobook
Settings → Diagnostics`). Useful for users reporting "expensive" runs and
for triaging quality regressions.

In prod, log nothing about request content. **Never** log the API key
even masked.
