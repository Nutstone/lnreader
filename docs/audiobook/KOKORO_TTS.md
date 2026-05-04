# Kokoro TTS — On-device synthesis on React Native

This is the most fragile part of the system. The current code on master
imports `kokoro-js` and calls `KokoroTTS.from_pretrained(...)` from the JS
thread. **That will not work in Hermes**. This document explains why,
what to do instead, and how to migrate the existing code without
breaking the rest of the pipeline.

## TL;DR

- `kokoro-js` runs Transformers.js + onnxruntime-web + WASM phonemizer.
  None of those load in Hermes.
- The intended path is a **TurboModule** (`react-native-kokoro-tts`) that
  loads the Kokoro ONNX file with `onnxruntime-android` and runs an
  espeak-ng phoneme step natively.
- The voice-blend format `"af_bella:50,af_nova:30,af_jessica:20"` is
  correct — but the blend itself is computed client-side over the
  per-voice 256-dim style vectors. Implement the blend in TS once;
  pass the resulting style vector to native.
- Until the native module ships, gate the audiobook feature behind a
  WebView fallback (slower, RAM-heavy, but works as a prototype).

## Why kokoro-js does not work in Hermes

Three independent blockers, any one of which is fatal:

1. **`onnxruntime-web` (the default Transformers.js backend) is WASM/
   WebGPU.** Hermes has no `WebAssembly` global. The repo already
   includes `onnxruntime-react-native` but `kokoro-js` cannot be coerced
   into using it without rewriting Transformers.js's model-loader.
2. **`phonemizer.js` is an espeak-ng WASM build.** Same blocker. Even
   on a stock Chromium WebView, the GPL-tainted espeak-ng dep raises a
   redistribution concern (see `hexgrad/kokoro#247`).
3. **Hermes is missing or shimmed for**: `TextEncoder`/`TextDecoder` for
   non-ASCII, fetch streams (used by Transformers.js model download),
   `WebAssembly`, full `atob`/`btoa`. The polyfill surface is too large
   to maintain.

You will see this manifest as a hang on first
`KokoroTTS.from_pretrained(...)` call, or a `TypeError: Cannot read
property 'install' of null, js engine: hermes` from the ORT bindings.

## Three integration paths, ranked

### A. Native TurboModule (recommended, production)

`packages/react-native-kokoro-tts/` (new), exposing:

```ts
interface KokoroNative {
  load(modelPath: string, dtype: 'q4' | 'q8' | 'q8f16' | 'fp16'): Promise<void>;
  synthesize(opts: {
    text: string;
    styleVector: Float32Array;  // 256 dims, pre-blended in JS
    speed: number;              // 0.5 .. 2.0
    sampleRate: 22050 | 24000;
  }): Promise<{ pcm: Float32Array; durationMs: number }>;
  unload(): Promise<void>;
}
```

Implementation:

- **Android**: `onnxruntime-android` (Maven `com.microsoft.onnxruntime:onnxruntime-android:1.21.0`) loads the ONNX model from the app's documents dir.
- **Phonemes**: bundle a tiny native espeak-ng JNI wrapper, or use the existing G2P logic from `kokoro-onnx` python (port to Kotlin). Avoid pulling in the full ~10 MB espeak data.
- **Audio**: emit raw `Float32Array` PCM. The JS side encodes to OPUS (use `react-native-audio-toolkit` or a small native encoder) before writing to the audio cache.
- **Threading**: run inference on a background thread; never on the JS or main thread.

Cold-start budget: ~800 ms model load on a mid-range phone. Warm
synthesis: ~0.6× realtime on a 2023 Snapdragon 7-series.

Reference implementations to study:

- `software-mansion/react-native-executorch-kokoro` (uses ExecuTorch, not
  ONNX, but the wrapper shape is identical)
- `isaiahbjork/expo-kokoro-onnx` (closest match: native ORT + custom TS pipeline)

### B. WebView-hosted kokoro-js (fallback / dev path)

The existing reader already runs a Chromium WebView. Spin up a hidden
WebView that loads `kokoro-js` from a bundled HTML file. Communicate via
`postMessage`. The current `webview` is `react-native-webview@13.15.0`
which has WASM and WebGPU on Android 12+.

Trade-offs:

- ✅ Works today, no native code.
- ✅ Voice blending and tokenizer "just work" — they're the kokoro-js path.
- ❌ ~250 MB RAM for the WebView process while loaded.
- ❌ Audio buffer round-trip: `Float32Array` → base64 → `postMessage` → JSI → file. Adds ~100 ms per segment.
- ❌ Cold-start ~5 s on first chapter.

Use this path **only** to unblock UI work while the native module is in
flight. Mark it with a clear opt-out behind a "Beta synth (WebView)" flag.

### C. System TTS fallback (low-quality, always-on)

Kokoro is the headline feature, but the pipeline should degrade
gracefully. If Kokoro isn't installed (model not downloaded yet, native
module disabled, device has no GPU/NPU), fall back to:

```ts
import * as Speech from 'expo-speech';

await Speech.speak(segment.text, {
  voice: getSystemVoiceForCharacter(segment.speaker),
  rate: speedFromEmotion(segment.emotion) * playbackSpeed,
  pitch: pitchFromArchetype(voiceMap[segment.speaker]),
});
```

Re-use the system voice picker the reader already has
(`screens/settings/SettingsReaderScreen/Modals/VoicePickerModal.tsx`).

This is also what should run when the user explicitly disables on-device
TTS to save battery.

## Voice catalog (Kokoro-82M v1.0 ONNX)

The `nationality+gender` letter prefix is meaningful — it determines the
language model the voice was trained on. **All v1.0 voices are
English-trained.** A "JP" character with `af_*` voice will say Japanese
words with English phonemes. Multilingual voices need v1.1+ which has
not shipped at the time of writing.

### American Female
`af_alloy`, `af_aoede`, `af_bella`, `af_heart`, `af_jessica`,
`af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`

### American Male
`am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`,
`am_onyx`, `am_puck`, `am_santa`

### British Female
`bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily`

### British Male
`bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis`

When v1.1 ships (it's expected to add `jf_*`, `jm_*`, `zf_*`, `zm_*` for
Japanese and Chinese), the voice catalog grows. Keep the catalog in a
JSON file (`src/services/audiobook/voiceCatalog.json`) so adding voices
is a data change, not a code change.

## Voice blending — exact algorithm

Kokoro voices are loaded as 256-dim style vectors. A blended voice is the
weighted average of those vectors:

```ts
// pure TS, runs on JS thread
function blendStyleVectors(
  styleVectors: Record<string, Float32Array>,  // voiceId → 256 floats
  components: Array<{ voiceId: string; weight: number }>,
): Float32Array {
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const blended = new Float32Array(256);
  for (const { voiceId, weight } of components) {
    const v = styleVectors[voiceId];
    const w = weight / totalWeight;
    for (let i = 0; i < 256; i++) blended[i] += v[i] * w;
  }
  return blended;
}
```

Then pass `blended` to the native `synthesize()` call. The native side
does **not** need to know about blending — it just gets a style vector.

The string format `"af_bella:50,af_nova:30,af_jessica:20"` is a
serialisation convenience for caching and UI. Keep it for the cache key
(`voice-map.json`) and for the override UI, but do the actual blend in
TS where it can be tested without a phone.

## Sample-rate decision

Kokoro outputs at 24 kHz mono float32. Don't downsample below 22050 Hz —
you lose the warmth that makes the voices sound "good" rather than
"acceptable". The original concept proposes 24000 as default; keep it.
Offer 22050 as a "low-bandwidth/storage" option only. Anything below
22050 makes the audio cache sound metallic.

## Quantisation choice

| dtype | Size | Quality drop | Speed | When |
|-------|------|--------------|-------|------|
| `q4` | 305 MB (or `q4f16` 154 MB) | Audible artefacts in fast speech | Fastest | Bottom-tier devices, last-resort |
| `q8` | 92 MB | Imperceptible | ~1× realtime mid-range | **Default** |
| `q8f16` | 86 MB | Imperceptible | ~1.05× realtime | **Default if file size matters** |
| `fp16` | 163 MB | None | ~0.8× realtime mid-range | Flagship + plugged-in |
| `fp32` | 326 MB | None | ~0.5× realtime | Don't ship |

The auto-quality logic should pick from `Device.totalMemory`:
`< 4 GB` → q4f16; `4–8 GB` → q8f16; `≥ 8 GB` → q8 unless user overrides
to fp16. Surface the choice as a slider with descriptive labels, not raw
dtype names.

## Model download flow

The Kokoro model is too big to bundle in the APK. Flow:

1. User enables audiobook for the first time → settings screen shows a
   "Download voices" CTA with size and "this happens once".
2. Background download to `AUDIOBOOK_STORAGE/model/kokoro-v1.0-q8f16.onnx`
   with a resumable HTTP client (re-use `react-native-file-access`).
3. SHA-256 verify against a known hash committed to source.
4. Surface progress in the same notification slot as other background
   tasks.
5. If download fails, fall back to system TTS for playback and let the
   user retry the download from settings.

Hash file lives at `src/services/audiobook/modelManifest.json`:

```json
{
  "v1.0-q8f16": {
    "url": "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    "sha256": "<pin to a known-good revision>",
    "sizeBytes": 90234567
  }
}
```

Pin to a specific HF revision, never `main`, so a model update doesn't
silently invalidate every cached audio file in the wild.

## Migration plan from current code

`src/services/audiobook/ttsRenderer.ts` calls `KokoroTTS.from_pretrained`
directly. To migrate without breaking the rest of the pipeline:

1. Extract the renderer into an interface:
   ```ts
   interface ITTSRenderer {
     initialize(): Promise<void>;
     dispose(): Promise<void>;
     renderSegment(text: string, voice: BlendedVoice, emotion: Emotion): Promise<AudioSegment>;
   }
   ```
2. Implement `WebViewTTSRenderer` (path B) and `NativeTTSRenderer` (path A).
   Pick at construction time based on a setting + capability check.
3. The pipeline only depends on `ITTSRenderer`, so the migration is a
   one-line swap.
4. Keep both implementations until the native module has shipped a release
   and proven stable for ~one month — then delete the WebView path.

## Things that will absolutely break and how

- **Stale ONNX file after app update**: include a `modelVersion` in the
  manifest; on app launch, if the version differs from the manifest in
  source, prompt to redownload.
- **OOM on background tab switch**: when the engine is loaded but the
  user backgrounds the app for >2 minutes without playback, dispose the
  ONNX session and reload on next play. The audio cache means warm
  resume is fast.
- **Speed × emotion accumulation**: the renderer multiplies
  `voice.speed * EMOTION_SPEED_MODIFIERS[emotion]`. Adding the user's
  playback-speed slider on top would compound: 1.05 × 1.15 × 1.5 = 1.81
  which is unnatural. Apply the user's playback-speed slider at
  `expo-av` level only, not at the renderer.
- **Whisper is louder than narration in Kokoro**: there's no volume
  control in the model. Either mix at playback (drop gain by 6 dB on
  whisper segments) or stop pretending whisper changes anything.
