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
// The vendored NakliOS SDK is excluded from this scan: it is a canonical file
// spliced in between markers, and its usage comment names its own CDN URL as
// documentation. Its code fetches nothing (the host bridge is postMessage).
const scanned = html.replace(/\/\*\s*naklios-sdk:begin[\s\S]*?naklios-sdk:end\s*\*\//, '');
const externalReference = /(?:src|href)\s*=\s*["'](?!#)(?:https?:)?\/\//i.exec(scanned);
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
assert(/id="nakliamp-licence"/.test(html), 'The artifact does not carry NakliAmp\'s own licence.');
// The Reel engine is inlined, so its licence notice travels with it.
assert(/id="reel-licence"/.test(html) && /Licence notice for engine\/reel-engine\.mjs/.test(html),
  'The artifact embeds the Reel engine but not its licence notice.');
assert(/id="music-metadata-licences"/.test(html) && /id="butterchurn-licence"/.test(html) && /id="butterchurn-presets-licence"/.test(html),
  'The artifact omits a vendored library licence block.');
// The banner promises no request until a service is turned on; it must not claim none at all.
assert(/no network request\s+until you turn on a service/.test(html), 'The banner no longer states the opt-in network rule.');
assert(!/makes no network requests\s+of any kind/.test(html), 'The banner claims no network requests of any kind, which the opt-in services contradict.');
if (target.includes('full')) {
  assert(/id="libav-lgpl-licence"/.test(html) && /id="libav-lgpl-notice"/.test(html),
    'The full artifact embeds libav but not its LGPL-2.1 text and source notice.');
  // LGPL-2.1 asks for the corresponding source: the notice must name the tag, the
  // component configuration, the build command and where the NakliAmp copy lives.
  const notice = /id="libav-lgpl-notice">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  for (const [fact, pattern] of [
    ['the libav.js repository and tag', /github\.com\/Yahweasel\/libav\.js`, tag `v6\.10\.9\.0`/],
    ['the FFmpeg version', /FFmpeg 9\.0/],
    ['the component configuration', /node mkconfig\.js nakliamp '\["avformat"[\s\S]*"decoder-alac"\]'/],
    ['the build command', /make build-nakliamp/],
    ['the NakliAmp repository', /github\.com\/NakliTechie\/nakliamp/],
  ]) assert(pattern.test(notice), `The libav source notice in the full artifact omits ${fact}.`);
}
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
// A released player must carry no way to drive it from outside.
assert(!/__nakliampHarness/.test(html), 'The artifact ships the gate seam.');
// Scoped to NakliAmp's own names: the vendored Reel engine has its own
// comments about the headless harness it is driven by, and is not patched.
assert(!/nakliamp:harness/.test(html), 'The artifact kept the harness markers.');
assert(!/\?harness=1|get\('harness'\)/.test(html), 'The artifact still reads the harness query flag.');

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
// The README states each artifact's size in MB to one decimal; keep it within 0.1 MB.
const readmeText = await readFile(resolve(root, 'README.md'), 'utf8');
const claimedMb = Number(new RegExp(`\`${target.replace('.', '\\.')}\` \\(([0-9.]+) MB\\)`).exec(readmeText)?.[1]);
assert(Number.isFinite(claimedMb), `README states no size for ${target}.`);
assert(Math.abs(claimedMb - size / 1e6) <= 0.1, `README says ${target} is ${claimedMb} MB; it is ${(size / 1e6).toFixed(2)} MB.`);
assert(size > 512 * 1024, `The artifact is ${size} bytes, too small to contain the engine.`);
assert(size < (target.includes('full') ? 12 : 4) * 1024 * 1024, `The artifact is ${(size / 1024 / 1024).toFixed(1)} MB, past the release budget.`);

console.log(
  `PASS — Single-file release (${target}): ${size} bytes (${(size / 1e6).toFixed(2)} MB); `
  + `${Object.keys(sources).length} modules parse; zero external references; licence and pin carried`,
);
