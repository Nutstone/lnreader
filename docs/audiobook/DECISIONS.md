# Decisions

Honest narrow picks. One TTS engine, one LLM provider. Anything
multi-provider expands the test surface without payoff for a feature
that one or two thousand power users will actually use.

These are the picks the rest of the docs assume. Where another doc
contradicts this file, this file wins.

> Disclaimer on numbers: provider pricing/quotas change. Costs are
> quoted as "what the provider documents at the time of writing";
> verify before billing decisions. Quality claims are personal
> judgement after using these systems for similar tasks — not a
> benchmark.

## What matters in an audiobook voice (UX-first)

Listed in order of how much they affect the listening experience:

1. **Naturalness** — does it sound like a person or a synthesizer?
   Robotic prosody breaks immersion within seconds.
2. **Emotional range** — can the voice convey anger, whisper,
   excitement, sadness audibly?
3. **Character distinctiveness** — multiple voices should sound like
   different people, not the same voice retuned. ≥10 truly distinct
   voices needed for a typical light-novel cast.
4. **Pronunciation** — fantasy names, honorifics, foreign words must
   not derail.
5. **Pacing / rhythm** — consistent cadence over a 30-minute chapter.

Anything that fails (1) or (2) is unsuitable. (3) and (4) are
necessary; (5) is hygiene.

## TTS: pick one

### Options considered

| Option | Naturalness | Emotion | Distinct voices | Cost @ 200-chapter LN (~5M chars) | Offline | Setup |
|--------|------|---------|-----------------|------|---------|-------|
| System TTS via `expo-speech` | poor — robotic | weak — pitch/rate only | weak (4–8 voices, similar timbres) | free | yes | none |
| OpenAI TTS (`gpt-4o-mini-tts`) | good | strong (text steering) | medium (11 voices) | ≈$75 (verify against OpenAI's per-char pricing) | only after cache | API key |
| ElevenLabs | excellent | strong | excellent (100s) | hundreds of dollars at the cheap tier | only after cache | API key + subscription |
| Kokoro via `kokoro-js` directly in Hermes | n/a | n/a | n/a | n/a — does not run (WASM phonemizer + onnxruntime-web; verified open issues) | n/a | n/a |
| **Kokoro hosted in a hidden WebView** | good | weak (speed only) | excellent (28+ voices × weighted blending = effectively unlimited) | **free after one-time 86MB model download** | yes after first render | model download |
| Native Kokoro RN module (TurboModule) | good | weak | excellent | free | yes | days of native work + model download |

### Pick: Kokoro hosted in a hidden WebView

Reasons:

1. **Voice quality is good enough.** Naturalness sits roughly at
   OpenAI `tts-1` level — clearly a synthesizer, but not robotic;
   listenable for hours. Significantly better than `expo-speech`.
2. **Voice distinctiveness wins.** 28+ base voices, blendable in
   weighted averages, give effectively unlimited unique character
   voices. For a novel with 30 named characters this is the single
   biggest UX win — listeners track who's speaking by *voice*, not
   "the dialogue tag said it was Shion".
3. **Free at scale.** Cloud TTS at audiobook character-volume is
   real money: roughly $75 per long novel on OpenAI; 10× that on
   ElevenLabs. Kokoro is a one-time 86 MB download, then free
   forever.
4. **Hermes-safe via WebView.** Chromium WebView has full WASM and
   WebGPU support, so `kokoro-js` runs unchanged in the WebView
   environment. The project already runs a WebView for the chapter
   reader — adding a hidden one for TTS is reuse, not invention.
5. **Phonetics work.** kokoro-js bundles espeak-ng G2P; fantasy and
   foreign-loanword pronunciation is decent. The user can override
   per-character pronunciation in the glossary editor for the long
   tail.
6. **Audio cache makes replays zero-RAM.** The WebView is only loaded
   while a chapter is being rendered for the first time. Cached
   chapters play directly from `expo-av` — no WebView in memory.

### What we give up vs OpenAI TTS

Emotion shaping in OpenAI's `gpt-4o-mini-tts` is genuinely better —
text instructions like "speak in a sad whisper" produce audibly
distinct output. Kokoro only gives us speed modulation. Mitigations:

- Apply post-render volume gain at the cache step: −6 dB on whisper,
  +3 to +5 dB on shouting. Real perceptible difference.
- Aggressive per-character voice perturbation so emotion doesn't carry
  the whole differentiation load.
- Speed modulation per emotion+intensity (existing
  `emotionModulation.ts` table).

The trade is "good enough emotion shaping but **5×** more distinct
voices and **0** ongoing cost". For long-form fiction listening this
is the right side of the trade-off.

### Why not the native Kokoro module in v1

It works, it's the long-term right answer, and it's days of native
Kotlin/JNI/ONNX/espeak-ng work. The WebView path delivers the same
audible result today with a single TS renderer + a small bundled HTML
file. The renderer abstraction means swapping in the native module
later is a one-file change.

### Implication for "voice blending"

Voice blending stays — it's the headline distinctiveness win. The
caster outputs a kokoro-js blend string per character
(`"af_bella:50,af_nova:30,af_jessica:20"`). The renderer passes that
straight through. Blend math is in TS for testability; weight
normalisation is exact.

## LLM: pick one

### Options considered

| Option | Where | Quality (personal use) | Cost | Setup |
|--------|-------|------------------------|------|-------|
| **Anthropic Claude (Sonnet / Haiku)** | cloud | high (Sonnet) / fair (Haiku) | paid; per-MTok rates documented at platform.claude.com | API key |
| Google Gemini | cloud | high | paid + free tier (quotas change) | API key |
| OpenAI GPT-4o / GPT-5 | cloud | high | paid | API key |
| **Ollama local** (Llama 3.x 70B / Qwen 2.5 32B) | user's PC over LAN | fair to high depending on model + hardware | free electricity | install Ollama, run model, expose port |
| OpenRouter | cloud meta | varies | paid | account |

### Pick: Anthropic Claude (default) + optional Ollama (power user)

The user already has Claude. The user said "more leeway on quality
compared to audio". That's enough signal:

1. **Default: Anthropic Claude.** One provider, two model tiers
   (Sonnet for quality, Haiku for cheap). Prompt caching cuts
   per-chapter input cost ~10× from chapter 2 onward. Deterministic
   structured output via `tool_choice` removes parsing fragility.
2. **Optional: Ollama (local).** Same JSON contract. Power users
   with Ollama on the LAN get free annotation. Quality envelope wider
   than for TTS, so a 70B-class local model is acceptable.

Why not Gemini or OpenAI in v1: each new provider doubles the test
surface, the auth flows, the error-code translation work — for
marginal payoff when Claude is the user's existing default.

### Models recommended

- **Sonnet** as the quality default. Best-in-class judgement on
  literary speaker attribution and emotion classification (personal
  use; not benchmarked).
- **Haiku** as the explicit cheap option. Worse on subtle dialogue
  but acceptable; the user said quality leeway is OK.
- **Opus** is selectable but not recommended — overkill on chapter
  segmentation; cost ratio doesn't justify the gain.

## Persistence: reuse what's there

| Layer | Storage | Notes |
|-------|---------|-------|
| Settings | MMKV (`AUDIOBOOK_SETTINGS`) | Auto-included in existing backups via the project's MMKV-allowlist pattern. |
| Last-played pointer per novel | MMKV (`AUDIOBOOK_LAST_<novelId>`) | Tiny; written on segment-end. |
| Per-novel preferences (speed, sleep timer) | MMKV (`AUDIOBOOK_PREFS_<novelId>`) | Tiny. |
| Glossary, voice map, annotations | JSON files under `AUDIOBOOK_STORAGE/<novelId>/` via `@specs/NativeFile` | Already wired (`utils/Storages.ts:AUDIOBOOK_STORAGE`). |
| Rendered audio | WAV files + JSON manifest under `AUDIOBOOK_STORAGE/<novelId>/audio/<chapterKey>/` | WAV is large but `expo-av`-compatible without a transcode step. Future enhancement: OPUS encode. |
| Background pipeline | `AUDIOBOOK_PIPELINE` task in `ServiceManager` | Already wired. |
| MediaSession / lock-screen | `NativeTTSMediaControl` + `ttsMediaEmitter` | Reused; same notification channel as TTS. |
| Backup integration | Audio cache **excluded** from default backup (large, rebuildable). Glossaries are tiny — opt-in inclusion is a future enhancement. | The existing `prepareBackupData` in `services/backup/utils.ts` handles MMKV automatically; audiobook needs no extra wiring for settings. |

Specifically not invented:

- No SQLite tables for audiobook data — hierarchical per-novel JSON
  is simpler, atomic, debuggable.
- No new audio playback module — `expo-av` plays WAV directly.
- No new MMKV wrapper — `getMMKVObject`/`setMMKVObject` already exist
  and are reused.
- No glossary-schema migration — fresh feature, no installed-user data.

## Phonetics

Two layers:

1. **kokoro-js' built-in espeak-ng G2P** handles the common case for
   fantasy and Japanese-loanword names ("Rimuru", "Onee-sama", etc.).
2. **Per-character pronunciation override** in the glossary editor.
   Each `Character` has an optional `pronunciation` field; when set,
   the renderer substitutes it for the character's name in segments
   where that character is the speaker (or referenced). Default is
   `name` itself. The user only fills it in when the spoken result is
   wrong.

No phonetic dictionary is bundled.

## What we are not building in v1

- No multilingual support. Novels are English. Kokoro v1.0 is
  English-only; that's fine.
- No glossary schema migrations.
- No multi-LLM routing (no "smart" provider switching).
- No native Kokoro TurboModule (future enhancement; renderer
  abstraction makes it a one-file swap).
- No Cloud TTS providers. The cost math doesn't work at audiobook
  character volumes.
