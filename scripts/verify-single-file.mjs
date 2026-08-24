// Single-file release gate (static half).
// The behavioural half runs in Chromium via test/single-file.html; this checks
// the properties that are decidable by reading the artifact.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'dist/nakliamp.html');

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
assert(/28e871525b766d1ae84790e150eb447cc396badc/.test(html), 'The artifact omits the pinned Reel commit.');

// The engine and its demuxer must actually be inside the file, not referenced.
assert(/createNakliAmpEngine/.test(html), 'The artifact does not contain the NakliAmp core.');
assert(/createReelEngine/.test(html), 'The artifact does not contain the Reel engine.');

const { size } = await stat(path);
assert(size > 512 * 1024, `The artifact is ${size} bytes, too small to contain the engine.`);
assert(size < 8 * 1024 * 1024, `The artifact is ${(size / 1024 / 1024).toFixed(1)} MB, past the release budget.`);

console.log(`PASS — Single-file release: ${(size / 1024 / 1024).toFixed(2)} MB; zero external references; licence and pin carried`);
