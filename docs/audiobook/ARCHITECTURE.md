# Architecture

The pipeline is one function call wide and three caches deep.

```
┌─────────────────────────────────────────────────────────────────────┐
│                            CLOUD                                    │
│                                                                     │
│   Sanitise chapter → Glossary build (3-chapter sample)              │
│                    → Annotate chapter (with prompt caching)         │
│                    → Discover new speakers; extend glossary         │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ON-DEVICE                                   │
│                                                                     │
│   Voice Caster → Kokoro WebView → Audio Cache → Player              │
│   (build &       (renders one     (one WAV       (global,           │
│    perturb       segment at a     per segment;   MediaSession,      │
│    archetypes)   time;            stable cache   mini-player,       │
│                  configurable     keys)          sleep timer)       │
│                  lookahead)                                         │
└─────────────────────────────────────────────────────────────────────┘
```

## On-disk layout

```
AUDIOBOOK_STORAGE/<novelId>/
├── glossary.json
├── voice-map.json
├── annotations/
│   └── <chapterKey>.json
└── audio/
    └── <chapterKey>/
        ├── manifest.json
        └── seg_0001.wav
```

`<chapterKey>` is `hashChapterPath(chapter.path)` — a stable 16-char hex
hash of the plugin-provided URL. Plugins can re-order the chapter list
without breaking the cache.

## Lifecycle of a chapter

1. User taps "Listen" on a chapter.
2. `audiobookPlayer.playChapter(config, novel, chapter, chapterText)`.
3. Player calls `pipeline.annotateOne(chapter)`. If glossary is missing,
   pipeline builds it from a 3-chapter sample. If chapter is already
   annotated, the cache returns immediately.
4. Player initialises the renderer (mounts the hidden WebView; Kokoro
   loads ~5 s the first time, instantly thereafter while WebView is
   alive).
5. Pipeline streams segments. Reusable cached segments (matching
   text + voice version + emotion) are yielded directly. Others are
   rendered via the WebView, written to WAV, and added to the manifest.
6. The first segment is buffered before playback starts; subsequent
   segments render in parallel up to `lookaheadSegments`.
7. `expo-av` plays each WAV. On segment-end the next is loaded.
8. State updates (segment index, position, current speaker) are
   broadcast to all subscribers.

## Module boundaries

```
┌────────────────────────────────────────────────────────────────────┐
│  AudiobookPlayer (singleton, app-scoped)                           │
│   ├── owns expo-av sound + position polling                        │
│   ├── owns the renderer instance (KokoroWebViewRenderer)           │
│   ├── owns last-played pointer + per-novel prefs                   │
│   └── emits PlayerState                                            │
│                                                                    │
│  AudiobookPipeline (per-novel)                                     │
│   ├── annotator: cloud calls                                       │
│   ├── caster: glossary → voice map (pure)                          │
│   ├── audioCache: manifest + WAV files                             │
│   └── streamChapterAudio: yields AudioSegments in playback order   │
│                                                                    │
│  KokoroWebViewRenderer (singleton via setKokoroHost)               │
│   ├── postMessage to the WebView                                   │
│   ├── correlates synth requests by id                              │
│   └── writes returned base64 PCM to WAV files                      │
│                                                                    │
│  KokoroTTSHost (React component)                                   │
│   └── hidden WebView; mounts kokoro-tts.html                       │
└────────────────────────────────────────────────────────────────────┘
```

The host component is rendered globally by `AudiobookHostMount`
whenever the player is non-idle. When the player becomes idle the host
is unmounted, freeing ~250 MB of WebView RAM.

## Concurrency

- One Kokoro instance per app (the WebView). Synth requests serialised
  via `pending` map keyed by request id. The WebView itself can run
  multiple at once but in practice we render one at a time.
- Annotation requests are serial per pipeline (one chapter at a time).
  Each request is idempotent — retried failures don't leak partial
  state.
- Player playback is sequential. Lookahead spawns up to N render
  promises; the player consumes them in order.

## State

Settings persist via MMKV (`AUDIOBOOK_SETTINGS`). Per-novel preferences
(speed, sleep timer setting) persist via MMKV (`AUDIOBOOK_PREFS_<id>`).
Last-played pointer per novel persists via MMKV
(`AUDIOBOOK_LAST_<id>`). Engine artefacts (glossary, voice map,
annotations, audio) persist as files under `AUDIOBOOK_STORAGE`.

The reader subscribes to player state and:

- Highlights the segment in the WebView via `audiobook.highlightSegment`.
- Triggers `navigateChapter('NEXT')` on chapter end if auto-advance is
  on.
- Updates the lock-screen via `updateTTSPlaybackState` /
  `updateTTSNotification`.

## Error model

| Tier | Examples | UI surface |
|------|----------|------------|
| User-fixable | Bad/missing API key, wrong base URL | Inline status banner in settings; toast in player |
| Recoverable transient | LLM 429/503, network blip | Auto-retry up to 3× with exp backoff. Final failure → player error state with `retryable: true` |
| Hard | Out of disk, ONNX session failed, plugin returned no chapter text | Player error state with `retryable: false`; toast |

Background tasks never throw — they wrap in try/catch and report via
`setMeta`. Player exposes errors via the subscribed state's `error`
field; the mini-player and reader are responsible for showing them.

## Type changes worth knowing

```ts
type LLMProvider = 'anthropic' | 'ollama';   // narrowed from 3-provider
type AnthropicModel = 'claude-sonnet-4-6' | 'claude-opus-4-7' | 'claude-haiku-4-5';
type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful'
  | 'surprised' | 'whisper' | 'shouting' | 'amused' | 'tender' | 'cold' | 'distressed';
type EmotionIntensity = 1 | 2 | 3;

interface BlendedVoice {
  label: string;
  components: { voiceId: string; weight: number }[]; // sum == 100
  speed: number;
  voiceVersion: number; // bumps on user override
}
```

## Why not different choices

| Decision | Rejected alt | Why |
|----------|--------------|-----|
| Per-novel JSON files | SQLite tables | Hierarchical per-novel; atomic writes; trivial to back up by tar |
| Hidden WebView Kokoro | Native TurboModule | TurboModule is days of native work; WebView ships today |
| WAV files in cache | OPUS encoding | `expo-av` plays WAV without transcode; OPUS is a future size optimisation |
| One LLM provider | Multi-provider | Each new provider doubles test surface; Claude is the user's existing default |
| English only | Multilingual | Kokoro v1.0 is English-only; novels with non-English chapters fall back to Kokoro speaking the text in English-locale prosody |
