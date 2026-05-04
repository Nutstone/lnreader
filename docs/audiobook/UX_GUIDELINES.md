# UX Guidelines

What the audiobook needs to feel like for the listener. Pick any item
and check the live app.

## Principles

1. **Voice first.** The reason audiobooks work is voices that sound like
   people. Kokoro is the headline; everything else exists to serve it.
2. **Three-tap maximum** to start listening: library → novel → Listen.
3. **No spinner without a label.** Loading states say what stage they're
   in ("Building cast…", "Annotating chapter 12 of 47…", "Rendering
   segment 4 of 32…").
4. **Cost transparency.** Any action that spends cloud credits shows the
   estimated $ before you tap it.
5. **Reversible by default.** Glossary edits, voice overrides, cache
   wipes show a confirmation; nothing destructive happens silently.

## Screens (as built)

### Settings (`SettingsAudiobookScreen`)

Provider chips → API key with show/hide → model picker → test
connection → prompt caching → voice quality → lookahead → playback
toggles → cache management.

The "Test connection" button makes a tiny LLM call (one-segment
glossary build) and surfaces a specific error: bad key, wrong URL, no
matching model, etc.

### Glossary Editor (`GlossaryEditorScreen`)

Lists narrator + every character. Each row exposes:

- Voice button → opens the voice picker bottom-sheet.
- Edit button → expands an inline form with name, aliases,
  personality, voice hints, pronunciation override, description, gender.
- Remove → confirmation alert; downgrades to narrator voice.

"Re-cast voices" rebuilds the entire voice map from the current glossary
(loses user overrides). "Done" goes back.

### Voice Picker (`VoicePickerSheet`)

Two tabs:

- **Archetype**: gender selector + 9 archetype cards. Picking one
  generates a 3-voice recipe.
- **Custom**: 3 component slots, each with a horizontal voice selector
  + weight chips. Apply normalises weights to 100.

Speed picker at the bottom (0.85× to 1.20×).

Future: a Preview button that renders 4 seconds of sample text. Not
wired in v1.

### Cost Preview (`CostPreviewModal`)

Shown before any batch annotation that will spend credits. Local
providers (Ollama) skip the modal. Shows tokens in/out, cost with and
without prompt caching.

### Novel screen menu

Headphones icon next to the download button:

- Process next 1 / 5 / 10 / unread / all
- Edit cast → glossary editor
- Clear audiobook cache (per-novel)

### Mini-player

Persistent strip above the bottom tab bar whenever the player is
loading/rendering/playing/paused. Shows novel name, current speaker,
position. Tap → opens full player.

### Full player (`AudiobookPlayerScreen`)

- Now-playing speaker + first 4 lines of segment text.
- Progress bar with mm:ss / mm:ss.
- Transport: prev segment, ⏪30, play/pause, ⏩30, next segment.
- Speed chips (0.7×–2.0×).
- Sleep timer chips (off, 5/10/15/30/45/60 min).
- Status (segment index / total, error, render-ahead indicator).

## Empty states

- Settings, no key set: "Multi-voice narration. Pick a provider, add a
  key, hit Listen." (Hero card on the settings screen.)
- Glossary editor before processing: "No glossary yet. Process the
  novel through the audiobook pipeline first."
- Player idle: nothing — the mini-player is hidden.

## Performance budgets

| Action | Budget |
|--------|--------|
| Open audiobook settings | < 250 ms |
| Tap Listen → first audio (cached chapter) | < 200 ms |
| Tap Listen → first audio (annotated, not rendered) | < 5 s on first chapter (cold WebView), < 2 s thereafter |
| Tap Listen → first audio (cold) | < 15 s including LLM |
| Glossary review → cast confirmed | < 500 ms |
| Skip-forward 30 s | < 100 ms |
| App resume from lock screen | < 500 ms |

If you can't hit a budget, surface a labelled spinner. Silent waits
> 3 s are the worst experience in the app.

## Copy

Short, factual, no marketing voice.

| ✅ | ❌ |
|---|---|
| "Building cast — 14 characters." | "Our advanced AI is analysing your novel." |
| "32 min." | "Long." |
| "$0.005 (with caching)." | "Negligible cost." |
| "Render failed for one segment. [Retry]" | "Oh no, something went wrong!" |

## Accessibility

- All controls have `accessibilityLabel`.
- Player chips and transport have hit-slop ≥ 12 px.
- Mini-player is one tap target with a screen-reader description
  combining novel + chapter + status.
- Sleep timer announces remaining time on focus.

## Haptics & animation

- Voice selection / chip taps: `expo-haptics` selection.
- Sleep timer reaches zero: `notificationGenericFeedback("warning")`.
- Mini-player slide-in: 200 ms ease-out.
- Highlight transitions: 150 ms colour fade. No pops.

Respect `useAppSettings.disableHapticFeedback`.
