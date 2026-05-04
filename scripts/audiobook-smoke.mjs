#!/usr/bin/env node
/**
 * Audiobook smoke test — runs in Node, validates that:
 *   1. kokoro-js loads + synthesises with a single voice;
 *   2. our voice-blending technique produces audibly different output;
 *   3. five archetype-style blends from `voiceCaster` produce audio.
 *
 * Run from the project root:
 *   node scripts/audiobook-smoke.mjs
 *
 * Outputs sample WAVs under /tmp/audiobook-smoke/.
 */

import { KokoroTTS } from 'kokoro-js';
import { readFile } from 'fs/promises';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const VOICES_DIR = path.join(
  REPO,
  'node_modules/.pnpm/kokoro-js@1.2.1/node_modules/kokoro-js/voices',
);
const OUT = '/tmp/audiobook-smoke';
mkdirSync(OUT, { recursive: true });

// Match what the WebView host does: load voice .bin, slice to position,
// weighted-average across components.
const styleCache = new Map();
async function loadStyleVector(voiceId) {
  if (styleCache.has(voiceId)) return styleCache.get(voiceId);
  const buf = await readFile(path.join(VOICES_DIR, `${voiceId}.bin`));
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  styleCache.set(voiceId, arr);
  return arr;
}

function blendStyles(slices, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  const out = new Float32Array(256);
  for (let v = 0; v < slices.length; v++) {
    const w = weights[v] / total;
    const s = slices[v];
    for (let i = 0; i < 256; i++) out[i] += s[i] * w;
  }
  return out;
}

function patchKokoroForBlending(tts) {
  const sample = tts.tokenizer('a', { truncation: true });
  const TensorCtor = sample.input_ids.constructor;
  let RawAudioCtor = null;

  const origValidate = tts._validate_voice.bind(tts);
  tts._validate_voice = function (voice) {
    if (typeof voice === 'string' && voice.includes(':')) {
      const firstId = voice.split(',')[0].split(':')[0].trim();
      return origValidate(firstId);
    }
    return origValidate(voice);
  };

  const origGenerateFromIds = tts.generate_from_ids.bind(tts);
  tts.generate_from_ids = async function (input_ids, opts = {}) {
    const { voice = 'af_heart', speed = 1 } = opts;
    if (typeof voice !== 'string' || !voice.includes(':')) {
      const result = await origGenerateFromIds(input_ids, opts);
      if (!RawAudioCtor) RawAudioCtor = result.constructor;
      return result;
    }
    if (!RawAudioCtor) {
      const dummy = await origGenerateFromIds(input_ids, { voice: 'af_heart', speed });
      RawAudioCtor = dummy.constructor;
    }
    const components = voice.split(',').map(s => {
      const [id, w] = s.split(':');
      return { id: id.trim(), weight: Number(w) };
    });
    const len = input_ids.dims.at(-1);
    const offset = 256 * Math.min(Math.max(len - 2, 0), 509);
    const slices = await Promise.all(
      components.map(c => loadStyleVector(c.id).then(arr => arr.slice(offset, offset + 256))),
    );
    const blended = blendStyles(slices, components.map(c => c.weight));
    const styleTensor = new TensorCtor('float32', blended, [1, 256]);
    const speedTensor = new TensorCtor('float32', [speed], [1]);
    const { waveform } = await tts.model({
      input_ids,
      style: styleTensor,
      speed: speedTensor,
    });
    return new RawAudioCtor(waveform.data, 24000);
  };
}

function floatsToWav(samples, sr) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, 44 + i * 2);
  }
  return buf;
}

console.log('[smoke] loading model …');
const tts = await KokoroTTS.from_pretrained(
  'onnx-community/Kokoro-82M-v1.0-ONNX',
  { dtype: 'q8', device: 'cpu' },
);
console.log('[smoke] loaded');

// Warmup: confirms kokoro's phonemizer initialises.
await tts.generate('Warmup.', { voice: 'af_bella' });
patchKokoroForBlending(tts);
console.log('[smoke] patched for blending');

const text = 'Hello there, traveller. Have you seen the dragon today?';
const blended = await tts.generate(text, {
  voice: 'af_bella:50,af_nova:30,af_jessica:20',
  speed: 1.0,
});
const pure = await tts.generate(text, { voice: 'af_bella', speed: 1.0 });

const minLen = Math.min(blended.audio.length, pure.audio.length);
let diff = 0;
for (let i = 0; i < minLen; i++) diff += Math.abs(blended.audio[i] - pure.audio[i]);
const meanDiff = diff / minLen;
console.log(`[smoke] mean abs diff blend↔pure: ${meanDiff.toFixed(5)}`);
if (meanDiff < 0.001) {
  console.error('[smoke] FAIL: blend produced same audio as pure af_bella');
  process.exit(1);
}

writeFileSync(path.join(OUT, 'sample-blend.wav'), floatsToWav(blended.audio, 24000));
writeFileSync(path.join(OUT, 'sample-pure-bella.wav'), floatsToWav(pure.audio, 24000));

const recipes = [
  { name: 'rimuru-gentle', blend: 'af_heart:50,af_sky:30,bf_lily:20', speed: 0.97 },
  { name: 'shion-warrior', blend: 'af_bella:50,am_eric:30,af_nova:20', speed: 1.05 },
  { name: 'veldora-mentor', blend: 'bm_fable:50,bm_george:30,am_michael:20', speed: 0.92 },
  { name: 'demon-villain', blend: 'am_onyx:50,bm_lewis:30,am_fenrir:20', speed: 0.97 },
  { name: 'kid-child', blend: 'af_sky:50,af_aoede:30,am_echo:20', speed: 1.08 },
];
for (const r of recipes) {
  const a = await tts.generate('Behold! The dragon awakens.', {
    voice: r.blend,
    speed: r.speed,
  });
  writeFileSync(path.join(OUT, `sample-${r.name}.wav`), floatsToWav(a.audio, 24000));
  console.log(`  ✓ ${r.name}`);
}
console.log(`[smoke] DONE — WAVs in ${OUT}`);
