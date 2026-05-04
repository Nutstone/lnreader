# Architecture

The current implementation is a single-pass pipeline with three caches and
one player. The improved architecture preserves the pipeline shape but
adds an audio cache, a global player service, and explicit lifecycle
boundaries between stages.

## Pipeline overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLOUD (one-time per novel/chapter)              │
│                                                                         │
│   Sanitise   ──►  Glossary build (3-chapter sample)                     │
│   chapter        ──►  Annotation (per chapter, with prompt caching)     │
│   text                ──►  Incremental glossary update if new speakers  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            ON-DEVICE                                    │
│                                                                         │
│   Voice Map  ──►  Kokoro Renderer  ──►  Audio Cache  ──►  Player        │
│   (build &        (singleton,           (one OPUS         (global,      │
│    perturb        loaded once;          file per          MediaSession, │
│    archetypes)    streams segments      segment;          mini-player,  │
│                   with lookahead)       compressed        sleep timer)  │
│                                         ~10× smaller                    │
│                                         than WAV)                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Caches (in disk order, fastest to slowest to rebuild)

```
AUDIOBOOK_STORAGE/<novelId>/
├── glossary.json             # tiny; ~1 KB; one cloud call to rebuild
├── voice-map.json            # tiny; deterministic from glossary; instant
├── annotations/
│   └── <chapterPathHash>.json    # ~5 KB per chapter; one cloud call to rebuild
├── audio/
│   └── <chapterPathHash>/
│       ├── manifest.json     # segment list + cumulative ms offsets
│       └── seg_NNNN.opus     # 5-30s OPUS-compressed segment
└── meta.json                 # version, novel title cache, last-played pointer
```

Why hash chapter `path` instead of integer index:

```ts
// BAD — current code
await this.getAnnotation(chapterId);  // chapterId === array index in plugin response

// GOOD — proposed
const key = sha1(chapter.path).slice(0, 16);  // stable across plugin re-orderings
```

`chapter.path` is the plugin-stable URL/identifier; LNReader stores it on
every chapter row already. This makes the cache survive plugin updates
that re-sort chapter lists.

## Module boundaries

The implementation today blurs `pipeline.ts` (orchestrator) and
`AudiobookPlayer.ts` (player). Disentangle them:

```
┌────────────────────────────────────────────────────────────────────┐
│  AudiobookEngine (singleton, owns Kokoro model)                    │
│   ├── annotator       → cloud calls, returns ChapterAnnotation     │
│   ├── voiceBlender    → pure: glossary → VoiceMap                  │
│   ├── ttsRenderer     → owns the ONNX session, streams segments    │
│   └── audioCache      → writes/reads OPUS files, manifest          │
│                                                                    │
│  AudiobookPipeline (per-novel, orchestrates engine for one novel)  │
│   ├── ensureGlossary()                                             │
│   ├── ensureVoiceMap()                                             │
│   ├── ensureAnnotation(chapter)                                    │
│   └── ensureAudio(chapter)  → renders & caches audio for chapter   │
│                                                                    │
│  AudiobookPlayerService (singleton, app-scoped)                    │
│   ├── loadChapter(novel, chapter)                                  │
│   ├── play / pause / seek / skipSegment                            │
│   ├── sleep timer, speed, volume                                   │
│   ├── MediaSession + notification (Android)                        │
│   └── emits state for UI subscribers                               │
└────────────────────────────────────────────────────────────────────┘
```

The player service is **app-scoped, not screen-scoped**. It survives
navigation away from the reader. The reader subscribes to its events;
when the reader unmounts the player keeps playing. A floating mini-player
component renders wherever the player is active. This is the standard
pattern in audiobook apps (Audible, Libby, Pocket Casts).

## Lifecycle of a chapter

1. **User taps "Listen" on chapter** (chapter list or reader appbar).
2. Player service receives `loadChapter(novel, chapter)`.
3. If chapter is fully cached as audio → start playback within ~150 ms.
4. If only annotation cached → load Kokoro (cold ~1 s, warm <50 ms),
   stream-render with 3-segment lookahead, write each rendered segment to
   the audio cache as OPUS, yield to playback in parallel.
5. If neither cached → annotate chapter (~3-8 s), then step 4.
6. If glossary missing → run glossary build first (~10 s).
7. On error: surface a non-blocking inline error in the player UI; allow
   "Retry" without losing the playback queue.

## Concurrency model

- **One Kokoro instance per app**, owned by the engine. Re-using the ONNX
  session across chapters saves ~800 ms of cold-start every chapter and
  ~15 MB of allocation churn.
- **One annotation request at a time** (queue them). Anthropic's rate
  limits (50 RPM on Tier 1) make parallel chapter annotation actively
  worse — back-pressure with a serial queue and prompt caching.
- **Render lookahead = 3 segments** by default. On low-RAM devices fall
  back to 1; on flagships up to 6. Surface as a setting but pre-pick from
  device RAM.
- **Player playback is single-threaded** but **render is on a worker**
  (background JS thread or native module). The render-vs-play race is
  the streaming generator pattern that's already in `AudiobookPlayer.ts`
  — keep it, just hoist it to the engine.

## State management

Use the existing **MMKV** + **persisted hooks** pattern, not Redux.

| State | Storage | Owner |
|-------|---------|-------|
| Settings (provider, key, quality) | MMKV: `AUDIOBOOK_SETTINGS` | `useAudiobookSettings` |
| Per-novel glossary | Disk: `glossary.json` | `pipeline` |
| Per-novel voice map | Disk: `voice-map.json` | `pipeline` |
| Per-chapter annotation | Disk: `annotations/<hash>.json` | `pipeline` |
| Per-chapter audio | Disk: `audio/<hash>/*.opus` | `audioCache` |
| Live player state (playing, segment, position) | RAM: event emitter | `AudiobookPlayerService` |
| Last-played pointer per novel | MMKV: `AUDIOBOOK_LAST_<novelId>` | `AudiobookPlayerService` |

The player state is **never persisted to disk during playback**. Save the
pointer (chapter ID + segment index + ms offset) on segment-end and on
app-background. Resume reads the pointer on launch.

## Background and foreground

LNReader already uses `react-native-background-actions` for the
download/backup/migrate pipelines. Re-use it for `AUDIOBOOK_PIPELINE`
(annotation/render) — these are fire-and-forget background jobs.

**Playback** is different. Audiobook playback must keep going when the
screen is locked, the user switches apps, or the reader unmounts. On
Android this requires:

- A foreground service with media notification.
- An `audio` `expo-av` `Audio.setAudioModeAsync` config:
  `staysActiveInBackground: true`, `playsInSilentModeIOS: true`,
  `interruptionModeAndroid: 'doNotMix'`.
- MediaSession metadata that updates per segment (so the lock-screen shows
  the speaker name and chapter title).

The existing `cc04287` commit (TTS MediaSession) wired most of this for
TTS. Audiobook re-uses the same emitter/notification module
(`utils/ttsNotification.ts`) but should pass distinct notification
channels so users can disable one without the other.

## Error model

Three error tiers — surface each at a different UI level:

| Tier | Examples | UI |
|------|----------|-----|
| User-fixable | Bad API key, wrong base URL, model not whitelisted | Inline banner in settings; toast in player |
| Recoverable transient | LLM rate limit, network blip, Kokoro segment failed | Auto-retry up to 3× with exp backoff; on final failure surface "Tap to retry" in player |
| Hard | Storage full, ONNX model corrupt, plugin returned no chapter text | Modal blocking error with "Open Settings" / "Clear cache" actions |

Never `throw` from background tasks — they crash the BackgroundService
process. Wrap in try/catch and report through `setMeta` (the existing
pattern in `processAudiobook.ts`).

## Type changes worth doing now

```ts
// types.ts — proposed additions

export interface AudioCacheEntry {
  novelId: string;
  chapterPath: string;          // stable plugin URL
  segmentIndex: number;
  filePath: string;             // OPUS file in AUDIOBOOK_STORAGE
  durationMs: number;
  speaker: string;
  emotion: Emotion;
  voiceLabel: string;           // for re-render detection if voice changes
  voiceVersion: number;         // bump when override changes
  createdAt: string;
}

export interface ChapterAudioManifest {
  chapterPath: string;
  totalDurationMs: number;
  segments: Array<{
    index: number;
    file: string;
    durationMs: number;
    pauseBeforeMs: number;
    speaker: string;
    text: string;
    voiceVersion: number;
  }>;
  createdAt: string;
}

export interface PlayerState {
  status: 'idle' | 'loading' | 'rendering' | 'playing' | 'paused' | 'error';
  novelId?: string;
  chapterId?: number;
  chapterPath?: string;
  totalSegments: number;
  segmentIndex: number;
  positionMs: number;          // within current segment
  totalPositionMs: number;     // across whole chapter
  totalDurationMs: number;
  speed: number;               // 0.5 .. 2.0
  sleepTimerMs?: number;
  error?: { code: string; message: string; retryable: boolean };
}

export interface AudiobookSettingsV2 {
  llm: {
    provider: 'anthropic' | 'gemini' | 'ollama';
    apiKey: string;
    baseUrl?: string;
    model?: string;            // empty = use provider default
    enablePromptCaching: boolean;  // default true
  };
  tts: {
    dtype: 'q4' | 'q8' | 'fp16';
    autoQuality: boolean;      // pick from device RAM
    lookaheadSegments: number;
    sampleRate: 22050 | 24000;
  };
  cache: {
    keepRenderedAudio: boolean;       // default true
    maxCacheSizeMB: number;           // default 1024
    autoEvictOldest: boolean;         // default true
  };
  playback: {
    defaultSpeed: number;             // 0.8 .. 1.5
    pauseMultiplier: number;          // 0.5 .. 2.0; multiplies the LLM-suggested pause
    skipNarration: boolean;           // dialogue-only mode
  };
}
```

The current `AudiobookSettings` type is flat. Migrate users through the
existing `useChapterReaderSettings` migration pattern — read v1, write v2,
keep v1 fallback for one release.

## Where to draw the line

This document describes what should ship. It does **not** prescribe an
implementation order — that's `ROADMAP.md`. It does **not** prescribe UX
copy or screen layout — that's `UX_GUIDELINES.md`. If you find yourself
arguing about which model to use, or which prompt template to write, you
want `LLM_INTEGRATION.md`.
