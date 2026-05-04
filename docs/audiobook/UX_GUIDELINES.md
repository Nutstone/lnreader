# UX Guidelines

The brief calls for "high UX requirements". This document is the bar.
A reviewer should be able to pick any item below, point at the running
app, and say "yes, that's there" or "no, fix it".

## Principles

1. **The audiobook is for listening, not configuring.** Every screen
   pushes the user toward "Play". Configuration screens have a "Play
   sample" affordance.
2. **Cost transparency, before commitment.** Every action that costs
   money (cloud LLM calls) shows a $ estimate before you tap it.
3. **Reversible by default.** Every voice assignment, glossary edit, and
   cache wipe has an "Undo" toast.
4. **Three-tap maximum** from "open the app" to "audiobook playing":
   library → novel → Listen.
5. **Empty states teach.** The first time a user opens the audiobook
   settings screen, it is not a list of inputs — it is a four-line
   onboarding card: "Audiobook turns chapters into multi-voice narration.
   Pick a provider → enter a key → Listen".
6. **No spinner without a label.** Every loading state names the stage
   ("Building cast…", "Annotating chapter 12 of 47…", "Rendering Shion's
   voice…").

## Screens

### 1. Audiobook Settings (`AudiobookSettings`)

Replaces the current bare-input screen.

**Layout, top to bottom:**

```
┌─────────────────────────────────────────────────┐
│ ← Audiobook                                     │
├─────────────────────────────────────────────────┤
│ ✦  Multi-voice narration powered by AI          │
│    [Test sample]   [How it works]               │
├─────────────────────────────────────────────────┤
│ Provider                                        │
│ [ Claude ]  [ Gemini ]  [ Local (Ollama) ]      │
│                                                 │
│ Recommended: Gemini (free 1M tokens/mo)         │
├─────────────────────────────────────────────────┤
│ API key                                         │
│ ●●●●●●●●●●●●●●●●  [Show]    [Test connection]   │
│ Status: ✓ Connected · Sonnet 4.6 available      │
├─────────────────────────────────────────────────┤
│ Model                                           │
│ ◉ Claude Sonnet 4.6     "Best quality"          │
│ ○ Claude Opus 4.7       "Top-tier ($$$$)"       │
│ ○ Custom…                                       │
├─────────────────────────────────────────────────┤
│ On-device voices                                │
│ Kokoro v1.0 · 86 MB · ✓ Downloaded              │
│  [Manage downloads]                             │
│                                                 │
│ Quality                                         │
│  ●━━━━━━━━━━━○                                  │
│  Auto (recommended for your phone: q8)          │
├─────────────────────────────────────────────────┤
│ Cache                                           │
│ Audiobook cache · 412 MB                        │
│  [Manage cache] [Clear all]                     │
├─────────────────────────────────────────────────┤
│ Diagnostics                                     │
│  [View recent calls]   [Run benchmark]          │
└─────────────────────────────────────────────────┘
```

**Provider chips**: pre-select Gemini for new users (free tier). Show a
green ✓ next to the active provider once a key is entered and tested.

**Test connection button**: makes a 1-token request and reports back
within 2 seconds. If it succeeds, surface the model availability list
("This key can use Sonnet 4.6, Opus 4.7"). If it fails, the error is
*specific* — "Wrong key format", "Out of credit", "No models accessible
on this account".

**Test sample button**: plays a 5-second pre-rendered sample from a
canonical voice ("Veldora's voice — wise dragon mentor"). Lets the user
hear the system before paying anything. Bundle 3-4 samples in the APK,
~50 KB each.

**How it works link**: opens an in-app sheet with the architecture
diagram in plain English. Three paragraphs, no jargon.

**Model selector**: never just `claude-3-5-sonnet-20241022`. Show
human-readable name + tier description + monthly token estimate at
typical usage.

### 2. Glossary Review (`GlossaryEditor`)

The single most important UX addition. Triggered automatically the first
time a user processes a novel — and accessible later from
`Novel Screen → ⋮ → Audiobook glossary`.

```
┌─────────────────────────────────────────────────┐
│ ← Cast for "Reincarnated as a Slime"            │
├─────────────────────────────────────────────────┤
│ We found 14 characters. Tap any to change       │
│ their voice. Once you're happy, hit Confirm.    │
│                                                 │
│ Narrator                                        │
│  🎙  Calm male voice (am_michael blend)         │
│  [▶ Sample]   [Change]                          │
├─────────────────────────────────────────────────┤
│ Main characters                                 │
│  Rimuru     ◉ Gentle · neutral · 1.0×           │
│            [▶ Sample] [Change voice]            │
│  Shion      ◉ Warrior · female · 1.05×          │
│            [▶ Sample] [Change voice]            │
│  Veldora    ◉ Mentor · male · 0.9×              │
│            [▶ Sample] [Change voice]            │
├─────────────────────────────────────────────────┤
│ Supporting (8)                                  │
│  ⌄ Tap to expand                                │
├─────────────────────────────────────────────────┤
│ [Skip review]               [Confirm and start] │
└─────────────────────────────────────────────────┘
```

Sample buttons render a single 4-second blended-voice sample on demand.
The tag (`Gentle · female · 1.05×`) is the matched archetype — it
explains why the system picked the voice, which is critical for trust.

"Change voice" opens the **Voice Picker**.

### 3. Voice Picker (`VoicePickerSheet`)

A bottom sheet, not a modal. Two tabs:

**Archetype tab** — shows 9 archetype cards with sample audio:

```
┌─────────────────────────────────────────────────┐
│ Voice for Shion                                 │
├─────────────────────────────────────────────────┤
│ [Gender] (●Male) (○Female) (○Neutral)           │
├─────────────────────────────────────────────────┤
│ 🛡  Warrior                ▶ Sample             │
│     Strong, fast, energetic                     │
│ 🎓  Mentor                 ▶ Sample             │
│     Wise, slow, deliberate                      │
│ 🩷  Gentle                 ▶ Sample             │
│ 🃏  Trickster              ▶ Sample             │
│ ...                                             │
├─────────────────────────────────────────────────┤
│ Speed         ●━━━━━━━━━━━━━○      1.05×        │
└─────────────────────────────────────────────────┘
```

**Custom tab** — for power users; expose the blend as 3 sliders:

```
┌─────────────────────────────────────────────────┐
│ Custom blend                                    │
├─────────────────────────────────────────────────┤
│ Voice 1   af_bella ▾   ●━━━━━━━━━━━○  50        │
│ Voice 2   af_nova  ▾   ●━━━━━━━━━━━○  30        │
│ Voice 3   af_jessica ▾ ●━━━━━━━━━━━○  20        │
│            (weights normalised to 100)          │
├─────────────────────────────────────────────────┤
│ Speed         ●━━━━━━━━━━━━━○      1.05×        │
│  [▶ Preview]                                    │
│  [Apply]   [Reset to archetype]                 │
└─────────────────────────────────────────────────┘
```

Preview re-renders a 4-second sample on every change. Throttle to one
render per 800 ms; show a small spinner inside the play button.

### 4. Novel screen — Audiobook menu

Hook into the existing `NovelAppbar.tsx` overflow menu next to the
download menu. Strings already exist in
`strings/languages/en/strings.json` under `novelScreen.audiobook.*`.

```
   ⋮ Menu
   ┌───────────────────────────────┐
   │ Download chapters         ▸   │
   │ Audiobook                 ▾   │
   │   Next chapter                │
   │   Next 5 chapters             │
   │   Next 10 chapters            │
   │   Unread chapters             │
   │   Custom amount…              │
   │   ─────                       │
   │   Edit cast…                  │
   │   Clear audio cache           │
   │ Migrate                   ▸   │
   └───────────────────────────────┘
```

"Process N chapters" enqueues the AUDIOBOOK_PIPELINE task with a cost
preview modal first.

### 5. Reader — Listen control

The current TTS bottom sheet has an "Enable Audiobook" switch. That's
not enough. Add a primary "Listen" floating action button that opens a
mini-player, leaving the toggle as the disable.

When a chapter has cached audio:
```
   ┌─────────────────────────────────┐
   │  ▶ Listen     ·     32 min      │
   └─────────────────────────────────┘
```

When it doesn't:
```
   ┌─────────────────────────────────┐
   │  ▶ Listen (will use ~$0.005)    │
   └─────────────────────────────────┘
```

Tapping it: starts the player; mini-player attaches.

### 6. Mini-player (`AudiobookMiniPlayer`)

Persistent across screens whenever the player service has a chapter
loaded. Sits above the bottom tab bar.

```
┌─────────────────────────────────────────────────┐
│ ╭───╮  Reincarnated as a Slime · Ch 12          │
│ │ ⏵ │  Shion: "Sage-sama!" · 14:32 / 32:08      │
│ ╰───╯  ━━━━━━━━●─────────────────────  [×]      │
└─────────────────────────────────────────────────┘
```

Tap → expanded player.

Long-press → quick controls (-30 s, +30 s, sleep timer, speed).

Swipe right → dismiss (also stops player).

### 7. Expanded player (`AudiobookPlayerScreen`)

Full-screen player. Modeled after Pocket Casts / Audible.

```
┌─────────────────────────────────────────────────┐
│ ╳                                               │
│                                                 │
│           [Cover art with subtle               │
│            character avatar in corner]          │
│                                                 │
│     Reincarnated as a Slime                     │
│     Chapter 12 — Encounter at the Lake          │
│                                                 │
│     "Sage-sama!"  — Shion (warrior)             │
│                                                 │
│     14:32 ━━━━━━━●──────────────────  32:08     │
│                                                 │
│       ⏮     ⏪30     ⏵⏸     ⏩30     ⏭             │
│                                                 │
│     1.0×    🌙 Off    🔊                        │
│                                                 │
│     ─────────────────────────────────           │
│     ⌄ Segment list (scrollable)                 │
└─────────────────────────────────────────────────┘
```

Segment list shows speaker + first line + duration; tap to jump.
Currently-playing segment is highlighted and the list autoscrolls.

### 8. Background notification & lock screen

Re-use the TTS MediaSession (already shipped). Notification shows:

- Novel cover (tinted)
- Title: novel name
- Subtitle: "Chapter X — Speaker name"
- Action buttons: skip-30, play/pause, skip-30, stop
- Progress bar

Skip buttons jump by **30 seconds** in audiobook mode (not by chapter).
Long-press on skip-forward jumps to next chapter; on skip-back jumps to
previous chapter.

## Critical interactions

### First-time setup

1. User taps "Listen" on a chapter for a novel that's never been processed.
2. Modal: **"Set up audiobook"** — explains what'll happen ("We'll read
   the first 3 chapters, find the characters, then start narrating. ~10
   seconds.").
3. Cost estimate: "Free with Gemini's free tier" or "Approximately
   $0.04 with Claude".
4. **[Set up & listen]** **[Maybe later]**.
5. On confirm: progress dialog with stages — Connecting → Building cast
   → Casting voices → Annotating chapter → Rendering. Each stage shows
   what was found ("Found 14 characters: Rimuru, Veldora, Shion…").
6. After cast is built, **glossary review screen** opens automatically.
7. After confirm, playback starts.

### Returning user

1. Tap Listen → playback within 200 ms (audio cached) or with the
   "Rendering chapter…" overlay (annotation cached, audio not).
2. No prompts. No modals.

### Cost spike protection

If a single batch is estimated to cost > $1, force a confirm:

> "Processing all 217 unread chapters will use about $4.20 of your Claude
> credits. Continue?"
>
> [Cancel] [Use cheaper model] [Proceed]

The "use cheaper model" button switches to Gemini Flash for this batch
only.

### Errors during playback

Inline status bar inside the player:

- Network error → "No connection. Playing cached chapters only." [Retry]
- LLM rate limited → "Rate limited, retrying in 8 s…"
- Render failed for one segment → skip it, mark with a small ⚠ in the
  segment list, "Tap to retry just this segment"
- Out of API credit → "Claude credit empty. [Add credit] or [Switch to
  Gemini]"

### Cache pressure

If the audio cache exceeds the user's configured limit, evict
least-recently-played chapters first. Surface a non-blocking toast:
"Cleared 380 MB of old chapters to make space".

## Copy

Voice. The app talks like a librarian, not a marketer. Audiobook is **a
feature**, not a "magical AI experience". Examples:

| ✅ |  ❌ |
|---|---|
| "We'll read the first 3 chapters to find characters." | "Our advanced AI will analyse your novel for the optimal narration experience." |
| "Veldora's voice — wise male, slow." | "Cast Veldora as a sage archetype with calibrated narration speed." |
| "Free with Gemini's free tier." | "Save big on tokens with our intelligent caching!" |
| "Rendering chapter 4 of 12…" | "AI Magic in Progress…" |

Numbers, not adjectives. "32 min", not "long". "$0.005", not "negligible".

## Accessibility

- All controls have `accessibilityLabel`.
- Highlighting in the reader uses both background colour AND a leading
  ▸ marker (colour-blind safe).
- Voice picker samples have a transcript caption ("'Hello, traveller.'
  — sample text").
- Sleep timer announces remaining time on TalkBack focus.
- The mini-player is a single touch target with a screen-reader
  description "Audiobook playing: Reincarnated as a Slime, chapter 12,
  paused. Double-tap to expand."

## Performance budgets

These numbers come from competing apps and should be met or beaten:

| Action | Budget |
|--------|--------|
| Open audiobook settings | < 250 ms |
| Tap "Listen" → first audio (cached) | < 200 ms |
| Tap "Listen" → first audio (uncached, annotation cached) | < 3 s |
| Tap "Listen" → first audio (cold) | < 12 s |
| Glossary review → cast confirmed | < 500 ms |
| Voice sample preview | < 800 ms |
| Skip-forward 30s | < 100 ms |
| App resume → playback resumes from lock screen | < 500 ms |

If you can't hit these, surface a clear progress indicator. Silent
spinners for >3 seconds are the worst experience in the app.

## Dark mode and theming

The audiobook UI inherits from the existing `useTheme()` system. Don't
hard-code colours. Specific notes:

- The mini-player uses `theme.elevation.level3` over the tab bar —
  enough contrast to read in dark mode but not a "pop-out" in light.
- Voice archetype emojis (🛡 🎓 🩷) work on all platforms; verify on
  Android emoji 14+.
- The glossary review character row uses `theme.surfaceVariant` for the
  background and `theme.primary` as a left edge highlight on
  the currently selected voice.

## Haptics

Subtle, not constant. Use `expo-haptics`:

| Event | Haptic |
|-------|--------|
| Voice archetype tap | `selection` |
| Cost-estimate confirm | `notificationGenericFeedback("success")` |
| Sleep timer reaches zero | `impact("medium")` |
| Cache cleared | `selection` |

Respect `useAppSettings.disableHapticFeedback`.

## Animations

- **Avoid** any animation longer than 250 ms.
- Mini-player slides in from the bottom on load (`200ms ease-out`).
- Segment list autoscroll uses `scrollIntoView({block: 'center',
  behaviour: 'smooth'})`.
- Highlight transitions use a 150 ms colour fade — never a "pop".

## Things that look like UX but are bugs

- The current settings screen calls `onBlur` to commit — typing a key
  fast and tapping a chip can lose the last few characters. Use
  `onChangeText` + debounce, not `onBlur`.
- The TTS bottom sheet auto-disables Audiobook when TTS is enabled.
  Pick one canonical interaction: a single segmented control "Off / TTS
  / Audiobook" rather than two mutually-exclusive switches.
- The current "Auto Page Advance" copy doesn't say what it advances to.
  Change to "Continue to next chapter when finished".

## Localisation

All copy strings go through `getString()`. The key prefix `audiobook.*`,
`audiobookSettings.*`, `glossaryEditor.*`, `novelScreen.audiobook.*` are
already in `strings/languages/en/strings.json`. Add new keys under those
namespaces; never inline strings.

For new strings, add to:
- `strings/languages/en/strings.json` (canonical)
- `strings/types/index.ts` (TypeScript types)

Other languages will be picked up by Crowdin (see `crowdin.yml`).
