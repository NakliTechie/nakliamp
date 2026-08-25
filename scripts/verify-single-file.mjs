// Single-file release gate (static half).
// The behavioural half runs in Chromium via test/single-file.html; this checks
// the properties that are decidable by reading the artifact.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] === '--full' ? 'dist/nakliamp-full.html' : 'dist/nakliamp.html';
const path = resolve(root, target);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let html;
try {
  html = await readFile(path, 'utf8');
} catch {
  throw new Error('dist/nakliamp.html is missing. Run `node scripts/build-single-file.mjs` first.');
}

// Nothing may be fetched. A single-file release that reaches the network is
// not one, and it would break the no-analytics claim the README makes.
const externalReference = /(?:src|href)\s*=\s*["'](?!#)(?:https?:)?\/\//i.exec(html);
assert(!externalReference, `The artifact references an external resource: ${externalReference?.[0]}`);
assert(!/@import\s+url\(\s*["']?https?:/i.test(html), 'The artifact imports a remote stylesheet.');
assert(!/fonts\.(googleapis|gstatic)\.com/i.test(html), 'The artifact links a remote font.');

// The only URLs it may name are documentation, inside comments and licence text.
const fetchCall = /\bfetch\s*\(\s*["'`]https?:/i.exec(html);
assert(!fetchCall, 'The artifact contains a call that fetches a remote URL.');

assert(/<meta http-equiv="Content-Security-Policy"/.test(html), 'The artifact lost its Content-Security-Policy.');
assert(/connect-src 'self'/.test(html), 'The artifact CSP no longer restricts network destinations.');

// MPL-2.0 obliges the licence to travel with the code, and this file travels alone.
assert(/id="mediabunny-licence"/.test(html), 'The artifact does not carry the Mediabunny licence.');
assert(/Mozilla Public License/.test(html), 'The embedded licence text is missing.');
assert(
  /github\.com\/Vanilagy\/mediabunny\/tree\/v1\.51\.0/.test(html),
  'The artifact omits the Mediabunny corresponding-source location.',
);
const pinned = /Reel commit: `([0-9a-f]{40})`/.exec(
  await readFile(new URL('../VENDOR.md', import.meta.url), 'utf8'),
)?.[1];
assert(pinned, 'VENDOR.md does not name a pinned Reel commit.');
assert(html.includes(pinned), 'The artifact omits the pinned Reel commit.');

// The engine and its demuxer must actually be inside the file, not referenced.
assert(/createNakliAmpEngine/.test(html), 'The artifact does not contain the NakliAmp core.');
assert(/createReelEngine/.test(html), 'The artifact does not contain the Reel engine.');

// Parse the inlined script and every module it carries. A build that
// concatenates text can emit something that reads correctly and does not run:
// this gate exists because a string replacement interpreted `$'` inside
// `$('#id')` and silently corrupted the output, which every other check passed.
const inlineScript = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
assert(inlineScript, 'The artifact has no inline module script.');

const registry = /const __nakliampSources = (\{[\s\S]*?\});\n/.exec(inlineScript[1]);
assert(registry, 'The artifact has no inlined module registry.');
const sources = JSON.parse(registry[1]);
assert(Object.keys(sources).length >= 3, 'The module registry is suspiciously small.');

const scratch = await mkdtemp(join(tmpdir(), 'nakliamp-single-'));
try {
  const targets = [['the inlined script', inlineScript[1]], ...Object.entries(sources)];
  for (const [name, source] of targets) {
    assert(source.length > 0, `Inlined module ${name} is empty.`);
    const file = join(scratch, `${name.replace(/[^\w.-]/g, '_')}.mjs`);
    await writeFile(file, source);
    try {
      await run(process.execPath, ['--check', file]);
    } catch (error) {
      throw new Error(`${name} does not parse: ${String(error.stderr ?? error.message).split('\n').at(-4) ?? ''}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const { size } = await stat(path);
assert(size > 512 * 1024, `The artifact is ${size} bytes, too small to contain the engine.`);
assert(size < (target.includes('full') ? 12 : 4) * 1024 * 1024, `The artifact is ${(size / 1024 / 1024).toFixed(1)} MB, past the release budget.`);

console.log(
  `PASS — Single-file release (${target}): ${(size / 1024 / 1024).toFixed(2)} MB; `
  + `${Object.keys(sources).length} modules parse; zero external references; licence and pin carried`,
);
