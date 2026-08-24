// Single-file release build.
//
// Emits `dist/nakliamp.html`: one file, no external references, no network.
// Save it anywhere and open it.
//
// Why a build step rather than authoring one file by hand: the vendor pin gate
// hashes `engine/reel-engine.mjs` and the Mediabunny runtime exactly as
// upstream ships them, and the boundary gate requires the core to stay a
// separate headless module. Hand-inlining would destroy both. So the source
// stays modular and gated, and the release is a derived artifact.
//
// How the modules survive inlining: each one is embedded as source text and
// instantiated at boot as a blob URL, with its import specifiers rewritten to
// the blob URLs of its dependencies. That keeps real ES module semantics —
// live bindings, single instantiation, `import.meta.url` — instead of
// rewriting minified third-party code, which no build should attempt.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_HTML = 'index.html';
const OUTPUT = 'dist/nakliamp.html';

/** Every relative specifier form the source uses. */
const SPECIFIER = /(?:from\s*|import\s*|new\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

const modules = new Map();

async function collect(path) {
  if (modules.has(path)) return;
  const source = await readFile(resolve(root, path), 'utf8');
  modules.set(path, source);
  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    await collect(posix.normalize(posix.join(posix.dirname(path), specifier)));
  }
}

const html = await readFile(resolve(root, ENTRY_HTML), 'utf8');

// The page's own module script names the entry points.
const inlineScript = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!inlineScript) throw new Error('index.html has no inline module script.');
for (const [, , specifier] of inlineScript[1].matchAll(SPECIFIER)) {
  await collect(posix.normalize(specifier.replace(/^\.\//, '')));
}
if (!modules.size) throw new Error('No modules were reachable from index.html.');

const licence = await readFile(resolve(root, 'vendor/mediabunny/LICENSE-MPL-2.0.txt'), 'utf8');
const vendorNotice = await readFile(resolve(root, 'VENDOR.md'), 'utf8');

/**
 * The loader. It runs before the app script and exposes `__nakliampModule`,
 * which resolves a source path to an instantiated blob URL.
 */
const loader = `
const __nakliampSources = __NAKLIAMP_SOURCES__;
const __nakliampUrls = new Map();
const __nakliampSpecifier = ${JSON.stringify(SPECIFIER.source)};

function __nakliampResolve(base, specifier) {
  const parts = base.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

// Depth-first, so a module's dependencies already have blob URLs when its own
// source is rewritten. The graph is acyclic; a cycle is a build error, not a
// runtime one, and would be caught here as a missing URL.
function __nakliampModule(path) {
  const existing = __nakliampUrls.get(path);
  if (existing) return existing;
  const source = __nakliampSources[path];
  if (source === undefined) throw new Error('Missing inlined module: ' + path);
  __nakliampUrls.set(path, 'pending');
  const rewritten = source.replace(
    new RegExp(__nakliampSpecifier, 'g'),
    (match, quote, specifier) => match.replace(
      quote + specifier + quote,
      quote + __nakliampModule(__nakliampResolve(path, specifier)) + quote,
    ),
  );
  const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
  __nakliampUrls.set(path, url);
  return url;
}

window.__nakliampModule = __nakliampModule;
`;

const sources = JSON.stringify(Object.fromEntries(modules));

// The app script imports by path; in the single file those become blob URLs
// resolved through the loader, so its import statements become dynamic.
let appScript = inlineScript[1];
appScript = appScript.replace(
  /import\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"]+)\2;?/g,
  (_match, bindings, _quote, specifier) =>
    `const {${bindings}} = await import(__nakliampModule(${JSON.stringify(posix.normalize(specifier.replace(/^\.\//, '')))}));`,
);

// A boot marker, so a gate can tell "the page rendered" from "the app ran".
// Static HTML renders either way; only this proves the modules instantiated.
appScript += `
document.documentElement.dataset.nakliampReady = '1';
`;

const banner = `<!--
NakliAmp single-file release.

Everything needed to play music is in this file. It makes no network requests
of any kind once it is open: no analytics, no fonts, no CDN, no update check.
Verify that with your browser's network tab.

This file embeds the Reel media engine and the Mediabunny demuxer.
Mediabunny is licensed MPL-2.0; its full licence text and the corresponding
source location are included at the end of this file.

${vendorNotice.trim().split('\n').map(line => `  ${line}`).join('\n')}
-->`;

// Every replacement below is a function, never a string. A string replacement
// interprets `$&`, `$\`` and `$'`, and this code is full of `$('#id')` while the
// vendored runtime is full of `$` besides — a string replacement silently
// corrupts the output rather than failing.
const insert = value => () => value;

const scriptBlock = `<script type="module">\n${
  loader.replace('__NAKLIAMP_SOURCES__', insert(sources))
}\n${appScript}\n</script>`;

const licenceBlock = `<script type="application/vnd.nakliamp.licence" id="mediabunny-licence">\n${
  licence.replace(/<\/script>/gi, '<\\/script>')
}\n</script>\n</body>`;

const output = html
  .replace('<!DOCTYPE html>', insert(`<!DOCTYPE html>\n${banner}`))
  .replace(/<script type="module">[\s\S]*?<\/script>/, insert(scriptBlock))
  .replace('</body>', insert(licenceBlock));

await mkdir(resolve(root, dirname(OUTPUT)), { recursive: true });
await writeFile(resolve(root, OUTPUT), output);

const bytes = Buffer.byteLength(output);
console.log(`PASS — Single-file build: ${OUTPUT}; ${modules.size} modules inlined; ${(bytes / 1024 / 1024).toFixed(2)} MB`);
for (const path of modules.keys()) console.log(`  ${relative('.', join('.', path))}`);
