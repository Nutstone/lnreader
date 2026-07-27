#!/usr/bin/env node
/**
 * Model-level end-to-end check for the Pocket TTS engine.
 *
 * Runs the real PocketTTSEngine (the same TypeScript that ships in the
 * app) against the real exported ONNX bundle under onnxruntime-node,
 * synthesizes a sentence with a predefined voice, and writes a WAV.
 *
 * Exactness note: the autoregressive loop is NOT bit-reproducible
 * across ONNX Runtime builds — the int8 dynamic-quant matmul kernels
 * differ between the Python and Node binaries, and tiny per-step drift
 * compounds autoregressively into a different (equally valid) speech
 * trajectory. The full loop is therefore checked structurally, while
 * the stateful mimi decoder is checked for near-exact parity against
 * latents captured from the Python runtime (POCKET_TTS_LATENTS +
 * POCKET_TTS_DECODED).
 *
 * This cannot run under jest: onnxruntime validates typed arrays with
 * instanceof, which fails across jest's VM realms.
 *
 * Usage:
 *   1. Download the bundle (≈150 MB, int8) and a voice:
 *        huggingface.co/KevinAHM/pocket-tts-onnx  → onnx/english_2026-04/
 *        huggingface.co/kyutai/pocket-tts-without-voice-cloning
 *          → languages/english_2026-04/embeddings/alba.safetensors
 *   2. npm/pnpm install onnxruntime-node somewhere.
 *   3. POCKET_TTS_BUNDLE_DIR=... POCKET_TTS_VOICE=... \
 *      ORT_NODE_PATH=.../node_modules/onnxruntime-node \
 *      [POCKET_TTS_REFERENCE=reference_temp0.npy] \
 *      node scripts/audiobook-tts-e2e.mjs
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const BUNDLE_DIR = process.env.POCKET_TTS_BUNDLE_DIR;
const VOICE_PATH = process.env.POCKET_TTS_VOICE;
const LATENTS_PATH = process.env.POCKET_TTS_LATENTS;
const DECODED_PATH = process.env.POCKET_TTS_DECODED;
const ORT_NODE_PATH = process.env.ORT_NODE_PATH || 'onnxruntime-node';
const TEST_TEXT =
  process.env.POCKET_TTS_TEXT || 'We march at dawn. Steel yourselves!';
const OUT_WAV =
  process.env.POCKET_TTS_OUT || path.join(os.tmpdir(), 'pocket-tts-e2e.wav');

if (!BUNDLE_DIR || !VOICE_PATH) {
  console.error(
    'Set POCKET_TTS_BUNDLE_DIR and POCKET_TTS_VOICE. See header for usage.',
  );
  process.exit(2);
}

// ── Transpile the engine sources (no RN imports in pocketTTS/) ──

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-tts-engine-'));
const tsconfig = {
  compilerOptions: {
    target: 'es2020',
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    skipLibCheck: true,
    outDir: buildDir,
    types: [],
  },
  include: ['src/services/audiobook/pocketTTS/*.ts'],
};
const tsconfigPath = path.join(buildDir, 'tsconfig.e2e.json');
fs.writeFileSync(
  tsconfigPath,
  JSON.stringify({
    ...tsconfig,
    include: tsconfig.include.map(p => path.join(repoRoot, p)),
  }),
);
execSync(`npx tsc -p ${tsconfigPath}`, { cwd: repoRoot, stdio: 'inherit' });

const engineDir = findFile(buildDir, 'engine.js');
if (!engineDir) {
  console.error('tsc output not found under', buildDir);
  process.exit(2);
}
const { PocketTTSEngine } = require(path.join(engineDir, 'engine.js'));
const { parseNpy } = require(path.join(engineDir, 'binaryFormats.js'));

function findFile(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) {
      return root;
    }
    if (entry.isDirectory()) {
      const found = findFile(path.join(root, entry.name), name);
      if (found) {
        return found;
      }
    }
  }
  return null;
}
const ort = require(ORT_NODE_PATH);

// ── Run ─────────────────────────────────────────────────────────

const metadata = JSON.parse(
  fs.readFileSync(path.join(BUNDLE_DIR, 'bundle.json'), 'utf8'),
);
const pick = stem => {
  const int8 = path.join(BUNDLE_DIR, `${stem}_int8.onnx`);
  return fs.existsSync(int8) ? int8 : path.join(BUNDLE_DIR, `${stem}.onnx`);
};

const started = Date.now();
const engine = await PocketTTSEngine.load(
  ort,
  metadata,
  {
    flowLmMain: pick('flow_lm_main'),
    flowLmFlow: pick('flow_lm_flow'),
    mimiDecoder: pick('mimi_decoder'),
    mimiEncoder: fs.existsSync(path.join(BUNDLE_DIR, 'mimi_encoder.onnx'))
      ? path.join(BUNDLE_DIR, 'mimi_encoder.onnx')
      : undefined,
    textConditioner: path.join(BUNDLE_DIR, 'text_conditioner.onnx'),
  },
  async filePath => new Uint8Array(fs.readFileSync(filePath)),
  path.join(BUNDLE_DIR, metadata.tokenizer_file),
  metadata.bos_before_voice_file
    ? path.join(BUNDLE_DIR, metadata.bos_before_voice_file)
    : undefined,
  { temperature: 0 },
);
console.log(`Engine loaded in ${((Date.now() - started) / 1000).toFixed(2)}s`);

const voiceState = await engine.voiceStateFromSafetensors(
  new Uint8Array(fs.readFileSync(VOICE_PATH)),
);
const t0 = Date.now();
const audio = await engine.synthesize(TEST_TEXT, voiceState);
const seconds = audio.length / engine.sampleRate;
console.log(
  `Synthesized ${seconds.toFixed(2)}s of audio in ${(
    (Date.now() - t0) /
    1000
  ).toFixed(2)}s ` +
    `(RTFx ${(seconds / ((Date.now() - t0) / 1000)).toFixed(2)})`,
);

let sumSquares = 0;
let finite = true;
for (let i = 0; i < audio.length; i++) {
  if (!Number.isFinite(audio[i])) finite = false;
  sumSquares += audio[i] * audio[i];
}
const rms = Math.sqrt(sumSquares / audio.length);
console.log(`samples=${audio.length} rms=${rms.toFixed(4)} finite=${finite}`);

writeWav(OUT_WAV, audio, engine.sampleRate);
console.log(`WAV written: ${OUT_WAV}`);

let failed =
  !finite || audio.length < engine.sampleRate || rms < 0.01 || rms >= 1;

// Decoder parity: run Python-captured latents through the TS mimi
// decode path. Single forward passes don't accumulate autoregressive
// drift, so this must match the Python-decoded audio near-exactly.
if (
  LATENTS_PATH &&
  DECODED_PATH &&
  fs.existsSync(LATENTS_PATH) &&
  fs.existsSync(DECODED_PATH)
) {
  const latentsNpy = parseNpy(new Uint8Array(fs.readFileSync(LATENTS_PATH)));
  const latentDim = metadata.latent_dim;
  const frameCount = latentsNpy.data.length / latentDim;
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(latentsNpy.data.slice(i * latentDim, (i + 1) * latentDim));
  }
  const decoded = await engine.decodeLatents(frames);
  const reference = parseNpy(
    new Uint8Array(fs.readFileSync(DECODED_PATH)),
  ).data;

  const overlap = Math.min(decoded.length, reference.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let maxAbsDiff = 0;
  for (let i = 0; i < overlap; i++) {
    dot += decoded[i] * reference[i];
    normA += decoded[i] * decoded[i];
    normB += reference[i] * reference[i];
    const diff = Math.abs(decoded[i] - reference[i]);
    if (diff > maxAbsDiff) maxAbsDiff = diff;
  }
  const correlation = dot / Math.sqrt(normA * normB);
  console.log(
    `decoder parity: lengthDelta=${Math.abs(
      decoded.length - reference.length,
    )} ` +
      `correlation=${correlation.toFixed(
        6,
      )} maxAbsDiff=${maxAbsDiff.toExponential(2)}`,
  );
  // The int8-quantized decoder kernels differ across ORT builds, so a
  // small residual is expected even on single forward passes; a state
  // wiring bug collapses correlation to noise (< 0.5) rather than
  // shaving fractions of a percent.
  if (decoded.length !== reference.length || correlation < 0.99) failed = true;
}

await engine.release();
fs.rmSync(buildDir, { recursive: true, force: true });
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);

function writeWav(filePath, samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(
      Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff),
      44 + i * 2,
    );
  }
  fs.writeFileSync(filePath, buffer);
}
