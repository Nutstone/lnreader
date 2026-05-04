#!/usr/bin/env node
/**
 * Host smoke test: load android/.../kokoro-tts.html in real Chromium
 * (same engine as RN's WebView), drive it via postMessage, validate
 * that:
 *   1. The bundled HTML parses.
 *   2. Our esbuild kokoro-js bundle imports cleanly (no bare-specifier
 *      errors, no Node-module-not-found errors).
 *   3. KokoroTTS.from_pretrained() reaches "ready".
 *   4. Single-voice synthesis returns a WAV.
 *   5. Voice-blend synthesis returns a *different* WAV.
 *
 * Requires:
 *   - playwright-core
 *   - a Chromium binary (the script defaults to Playwright's bundled
 *     Chromium under /opt/pw-browsers, but you can override CHROME_PATH).
 *
 * Usage:
 *   node scripts/audiobook-host-smoke.mjs
 */

import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HEADLESS_PATH =
  process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

const HTML_FILE = path.join(
  ROOT,
  'android/app/src/main/assets/audiobook/kokoro-tts.html',
);

const OUT = '/tmp/audiobook-host-smoke';
mkdirSync(OUT, { recursive: true });

const READY_TIMEOUT_MS = 120_000;
const SYNTH_TIMEOUT_MS = 120_000;

const browser = await chromium.launch({
  executablePath: HEADLESS_PATH,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--ignore-certificate-errors',
  ],
  ignoreHTTPSErrors: true,
});

const ctx = await browser.newContext();
const page = await ctx.newPage();

const messages = [];
const events = [];
page.on('console', m => events.push(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', e => events.push(`pageerror: ${e.message}`));

await page.exposeFunction('__capturePostMessage', json => {
  const m = JSON.parse(json);
  messages.push(m);
  if (m.type !== 'progress') console.log('[host]', m.type, m.id ?? '');
});

await page.addInitScript(() => {
  window.ReactNativeWebView = {
    postMessage: json => window.__capturePostMessage(json),
  };
});

await page.goto('file://' + HTML_FILE, { waitUntil: 'load', timeout: 30000 });
console.log('[host] loaded');

await page.evaluate(() => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ type: 'init', modelDtype: 'q8' }),
    }),
  );
});
console.log('[host] init dispatched, waiting for ready …');

const t0 = Date.now();
let ready = false;
while (Date.now() - t0 < READY_TIMEOUT_MS) {
  if (messages.some(m => m.type === 'ready')) {
    ready = true;
    break;
  }
  await new Promise(r => setTimeout(r, 500));
}
if (!ready) {
  console.error('[host] FAIL: not ready');
  console.error(events.slice(-10).join('\n'));
  await browser.close();
  process.exit(1);
}
console.log(`[host] ready=${ready} after ${(Date.now() - t0) / 1000}s`);

async function synth(req) {
  return page.evaluate(
    async r =>
      new Promise(resolve => {
        const handler = ev => {
          const data = typeof ev.data === 'string' ? ev.data : ev.data?.toString();
          try {
            const m = JSON.parse(data);
            if (m.id === r.id && (m.type === 'audio' || m.type === 'error')) {
              window.removeEventListener('message', handler);
              resolve(m);
            }
          } catch {
            /* ignore */
          }
        };
        window.addEventListener('message', handler);
        window.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'synthesize', ...r }),
          }),
        );
      }),
    req,
  );
}

console.log('[host] synth pure af_bella …');
const pureT0 = Date.now();
const pure = await Promise.race([
  synth({ id: 'pure', text: 'Hello world.', voice: 'af_bella', speed: 1.0 }),
  new Promise((_, rej) =>
    setTimeout(() => rej(new Error('synth timeout')), SYNTH_TIMEOUT_MS),
  ),
]);
console.log(`[host] pure done in ${(Date.now() - pureT0) / 1000}s, ${pure.durationMs}ms audio`);
if (pure.type === 'error') {
  console.error('[host] FAIL:', pure.message);
  await browser.close();
  process.exit(1);
}

console.log('[host] synth blend af_bella:50,af_nova:30,af_jessica:20 …');
const blendT0 = Date.now();
const blend = await Promise.race([
  synth({
    id: 'blend',
    text: 'Hello world.',
    voice: 'af_bella:50,af_nova:30,af_jessica:20',
    speed: 1.0,
  }),
  new Promise((_, rej) =>
    setTimeout(() => rej(new Error('synth timeout')), SYNTH_TIMEOUT_MS),
  ),
]);
console.log(`[host] blend done in ${(Date.now() - blendT0) / 1000}s, ${blend.durationMs}ms audio`);
if (blend.type === 'error') {
  console.error('[host] FAIL:', blend.message);
  await browser.close();
  process.exit(1);
}

if (pure.pcmBase64 === blend.pcmBase64) {
  console.error('[host] FAIL: blend produced identical bytes to pure');
  await browser.close();
  process.exit(1);
}

writeFileSync(path.join(OUT, 'pure.wav'), Buffer.from(pure.pcmBase64, 'base64'));
writeFileSync(path.join(OUT, 'blend.wav'), Buffer.from(blend.pcmBase64, 'base64'));
console.log(`[host] PASS — wrote ${OUT}/pure.wav + ${OUT}/blend.wav`);
await browser.close();
