#!/usr/bin/env node
/**
 * End-to-end check for the audiobook LLM annotator.
 *
 * Runs the real LLMAnnotator (the same TypeScript that ships in the
 * app) over real HTTP. Two modes:
 *
 *   Mock mode (default, no key needed): a local server impersonates
 *   the Anthropic Messages API and the Gemini generateContent API,
 *   validates every request the app sends (path, auth headers,
 *   version header, body schema), and returns realistic fenced-JSON
 *   responses. Verifies prompt building, chunking, HTTP, response
 *   parsing, sanitization, and error handling — everything except
 *   the provider's authentication and the model's actual judgement.
 *
 *   Real mode: set ANTHROPIC_API_KEY and/or GEMINI_API_KEY to also
 *   run a real glossary + annotation round-trip against the live API
 *   with a small fixture chapter (one short chapter ≈ a few cents).
 *
 * Usage:
 *   node scripts/audiobook-llm-e2e.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/audiobook-llm-e2e.mjs
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures++;
  }
};

// ── Transpile the annotator sources ─────────────────────────────

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-annotator-'));
const tsconfigPath = path.join(buildDir, 'tsconfig.e2e.json');
fs.writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      target: 'es2020',
      module: 'commonjs',
      moduleResolution: 'node',
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: buildDir,
      rootDir: path.join(repoRoot, 'src'),
      baseUrl: repoRoot,
      paths: { '@utils/*': ['src/utils/*'] },
      types: [],
    },
    files: [path.join(repoRoot, 'src/services/audiobook/llmAnnotator.ts')],
  }),
);
execSync(`npx tsc -p ${tsconfigPath}`, { cwd: repoRoot, stdio: 'inherit' });

// tsc keeps the '@utils/fetch/fetch' specifier in the emitted code;
// satisfy it at runtime with the real compiled implementation.
const shimDir = path.join(buildDir, 'node_modules', '@utils', 'fetch');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(
  path.join(shimDir, 'fetch.js'),
  `module.exports = require(${JSON.stringify(
    path.join(buildDir, 'utils', 'fetch', 'fetch.js'),
  )});\n`,
);

const { LLMAnnotator } = require(path.join(
  buildDir,
  'services',
  'audiobook',
  'llmAnnotator.js',
));

// ── Fixture chapter ─────────────────────────────────────────────

const CHAPTER = `The rain had not let up since dawn. Mira pulled her cloak
tighter and watched the gate from the shadow of the granary.

"You're late," she said, not turning around.

Torren stepped out of the alley, boots heavy in the mud. "The bridge
was watched. I came the long way." He held out a sealed letter.
"It's from the capital. They know about the shipment."

Mira broke the seal and read in silence. Somewhere behind the walls
a bell began to ring. "Then we move tonight," she whispered.`;

const GLOSSARY_JSON = {
  characters: [
    {
      name: 'Mira',
      aliases: [],
      gender: 'female',
      personality: ['terse', 'decisive'],
      description: 'A smuggler watching the gate.',
      importance: 9,
    },
    {
      name: 'Torren',
      aliases: [],
      gender: 'male',
      personality: ['loyal'],
      description: 'Her courier.',
      importance: 7,
    },
  ],
  narratorGender: 'male',
};

// Includes deliberately invalid fields to prove sanitization: an
// unknown emotion, an unknown pause, and a segment with no speaker.
const ANNOTATION_JSON = {
  segments: [
    {
      text: 'The rain had not let up since dawn.',
      speaker: 'narrator',
      emotion: 'neutral',
      isDialogue: false,
      pauseBefore: 'long',
    },
    {
      text: "You're late,",
      speaker: 'Mira',
      emotion: 'excited', // not a valid Emotion → must become neutral
      isDialogue: true,
      pauseBefore: 'huge', // not a valid pause → must become medium
    },
    {
      text: 'said Mira, not turning around.',
      // no speaker → must become narrator
      emotion: 'neutral',
      isDialogue: false,
    },
  ],
};

const fence = obj => '```json\n' + JSON.stringify(obj) + '\n```';

// ── Mock provider server ────────────────────────────────────────

const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    const record = { url: req.url, method: req.method, headers: req.headers };
    try {
      record.body = JSON.parse(body);
    } catch {
      record.body = body;
    }
    requests.push(record);

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };

    const apiKey =
      req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '';
    if (apiKey === 'bad-key') {
      return send(401, {
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
    }
    if (apiKey === 'garbage-key') {
      return send(200, {
        content: [{ type: 'text', text: 'Sorry, I cannot do that.' }],
        stop_reason: 'end_turn',
      });
    }

    const isGlossary = JSON.stringify(record.body).includes(
      'character glossary',
    );
    const payloadText = fence(isGlossary ? GLOSSARY_JSON : ANNOTATION_JSON);

    if (req.url === '/v1/messages') {
      return send(200, {
        content: [{ type: 'text', text: payloadText }],
        stop_reason: 'end_turn',
      });
    }
    if (req.url.includes(':generateContent')) {
      return send(200, {
        candidates: [{ content: { parts: [{ text: payloadText }] } }],
      });
    }
    send(404, { error: { message: `unexpected path ${req.url}` } });
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const mockOrigin = `http://127.0.0.1:${server.address().port}`;

// The app hardcodes the Anthropic URL; rewrite that one host to the
// mock so the annotator's exact request bytes hit our validator.
const realFetch = globalThis.fetch;
const anthropicRewrite = url =>
  String(url).replace('https://api.anthropic.com', mockOrigin);
globalThis.fetch = (input, init) => realFetch(anthropicRewrite(input), init);

// ── Mock-mode checks ────────────────────────────────────────────

console.log('\n── Anthropic path (mock) ──');
{
  const annotator = new LLMAnnotator({
    provider: 'anthropic',
    apiKey: 'test-key',
  });
  const glossary = await annotator.buildGlossary('novel-1', [CHAPTER]);
  const req0 = requests[0];
  check(req0.url === '/v1/messages', 'POSTs /v1/messages');
  check(req0.headers['x-api-key'] === 'test-key', 'sends x-api-key');
  check(
    req0.headers['anthropic-version'] === '2023-06-01',
    'sends anthropic-version',
  );
  check(req0.body.model === 'claude-sonnet-5', 'uses default model');
  check(
    typeof req0.body.system === 'string' && req0.body.system.length > 100,
    'system prompt in body.system',
  );
  check(
    Array.isArray(req0.body.messages) &&
      req0.body.messages[0].role === 'user' &&
      req0.body.messages[0].content.includes('Mira'),
    'chapter text in user message',
  );
  check(
    glossary.characters.length === 2 &&
      glossary.characters[0].name === 'Mira' &&
      glossary.characters[0].gender === 'female',
    'glossary parsed from fenced JSON',
  );

  const before = requests.length;
  const annotation = await annotator.annotateChapter(7, CHAPTER, glossary);
  check(requests.length === before + 1, 'short chapter → single request');
  check(annotation.segments.length === 3, 'segments parsed');
  check(
    annotation.segments[1].emotion === 'neutral' &&
      annotation.segments[1].pauseBefore === 'medium',
    'invalid emotion/pause sanitized',
  );
  check(
    annotation.segments[2].speaker === 'narrator',
    'missing speaker → narrator',
  );

  // Chunking: a long chapter must be annotated in several requests.
  const longChapter = Array.from(
    { length: 30 },
    (unused, i) =>
      `Paragraph ${i}. ${'Lorem ipsum dolor sit amet. '.repeat(25)}`,
  ).join('\n\n');
  const beforeLong = requests.length;
  await annotator.annotateChapter(8, longChapter, glossary);
  const chunkRequests = requests.length - beforeLong;
  check(
    chunkRequests >= 2,
    `long chapter chunked into ${chunkRequests} requests`,
  );
}

console.log('\n── Gemini path (mock) ──');
{
  const annotator = new LLMAnnotator({
    provider: 'gemini',
    apiKey: 'test-key',
    baseUrl: `${mockOrigin}/v1beta`,
  });
  const before = requests.length;
  const glossary = await annotator.buildGlossary('novel-1', [CHAPTER]);
  const req0 = requests[before];
  check(
    req0.url === '/v1beta/models/gemini-2.5-flash:generateContent',
    'POSTs generateContent with default model',
  );
  check(req0.headers['x-goog-api-key'] === 'test-key', 'sends x-goog-api-key');
  check(
    typeof req0.body.system_instruction?.parts?.[0]?.text === 'string',
    'system prompt in system_instruction',
  );
  check(glossary.characters.length === 2, 'glossary parsed');
}

console.log('\n── Failure paths (mock) ──');
{
  const bad = new LLMAnnotator({ provider: 'anthropic', apiKey: 'bad-key' });
  const err1 = await bad.buildGlossary('n', [CHAPTER]).then(
    () => null,
    e => e.message,
  );
  check(
    typeof err1 === 'string' &&
      err1.includes('HTTP 401') &&
      err1.includes('invalid x-api-key'),
    `401 surfaces cleanly: "${err1}"`,
  );

  const garbage = new LLMAnnotator({
    provider: 'anthropic',
    apiKey: 'garbage-key',
  });
  const err2 = await garbage.buildGlossary('n', [CHAPTER]).then(
    () => null,
    e => e.message,
  );
  check(
    typeof err2 === 'string' && err2.includes('malformed JSON'),
    `non-JSON reply surfaces cleanly: "${err2}"`,
  );

  const keyless = new LLMAnnotator({ provider: 'anthropic', apiKey: '' });
  const err3 = await keyless.buildGlossary('n', [CHAPTER]).then(
    () => null,
    e => e.message,
  );
  check(
    typeof err3 === 'string' && err3.includes('API key is not configured'),
    'missing key rejected before any request',
  );
}

// ── Real mode (optional) ────────────────────────────────────────

globalThis.fetch = realFetch;
server.close();

const realRuns = [
  ['anthropic', process.env.ANTHROPIC_API_KEY],
  ['gemini', process.env.GEMINI_API_KEY],
].filter(([, key]) => key);

for (const [provider, apiKey] of realRuns) {
  console.log(`\n── ${provider} path (REAL API) ──`);
  const annotator = new LLMAnnotator({ provider, apiKey });
  try {
    const glossary = await annotator.buildGlossary('real-test', [CHAPTER]);
    console.log(
      `glossary: ${glossary.characters
        .map(c => `${c.name} (${c.gender})`)
        .join(', ')} | narrator: ${glossary.narratorGender}`,
    );
    check(glossary.characters.length >= 2, 'real glossary found the cast');
    const annotation = await annotator.annotateChapter(1, CHAPTER, glossary);
    const speakers = [...new Set(annotation.segments.map(s => s.speaker))];
    console.log(
      `annotation: ${
        annotation.segments.length
      } segments, speakers: ${speakers.join(', ')}`,
    );
    check(
      annotation.segments.length >= 3 &&
        speakers.some(s => s.toLowerCase() !== 'narrator'),
      'real annotation attributes dialogue',
    );
  } catch (error) {
    check(false, `${provider} real call failed: ${error.message}`);
  }
}
if (realRuns.length === 0) {
  console.log(
    '\n(no ANTHROPIC_API_KEY / GEMINI_API_KEY set — skipped real-API runs)',
  );
}

fs.rmSync(buildDir, { recursive: true, force: true });
console.log(failures ? `\nRESULT: FAIL (${failures})` : '\nRESULT: PASS');
process.exit(failures ? 1 : 0);
