#!/usr/bin/env node
/**
 * Bundle kokoro-js + transformers + phonemizer into a single ESM file
 * for the WebView host. Browsers can't resolve bare module specifiers
 * (`@huggingface/transformers`); kokoro-js's distributed bundle uses
 * them, so it can't be loaded directly via `import`. esbuild inlines
 * everything.
 *
 * Output: android/app/src/main/assets/audiobook/kokoro-js.bundle.js
 *
 * Run after every kokoro-js bump:
 *   node scripts/audiobook-bundle-kokoro.mjs
 */

import * as esbuild from 'esbuild';
import { statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// kokoro-js's Node fallback paths reach for fs/path. In the browser
// we don't need those — fetch handles voice files. Stub them out.
const stubNodeOnly = {
  name: 'stub-node-only',
  setup(build) {
    build.onResolve(
      {
        filter: /^(fs|fs\/promises|path|stream|stream\/promises|url|os|crypto|child_process)$/,
      },
      args => ({ path: args.path, namespace: 'stub' }),
    );
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents:
        'export default {};' +
        'export const __dirname = "";' +
        'export const join = (...a) => a.join("/");' +
        'export const resolve = (...a) => a.join("/");' +
        'export const readFile = async () => new Uint8Array();',
      loader: 'js',
    }));
  },
};

const entry = path.resolve(
  ROOT,
  'node_modules/kokoro-js/dist/kokoro.js',
);

const out = path.resolve(
  ROOT,
  'android/app/src/main/assets/audiobook/kokoro-js.bundle.js',
);

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: out,
  minify: true,
  platform: 'browser',
  target: ['es2022'],
  plugins: [stubNodeOnly],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.platform': '"browser"',
    'process.versions.node': 'undefined',
  },
  logLevel: 'warning',
});

const bytes = statSync(out).size;
console.log(`bundled to ${out}`);
console.log(`size: ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
if (result.warnings.length > 0) {
  console.warn('warnings:', result.warnings.length);
}
