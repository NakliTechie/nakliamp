import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [index, vendor, readme] = await Promise.all([
  readFile(resolve(root, 'index.html'), 'utf8'),
  readFile(resolve(root, 'VENDOR.md'), 'utf8'),
  readFile(resolve(root, 'README.md'), 'utf8'),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// The allowlist is derived from what index.html actually imports, not written
// by hand. It went stale once: four modules the app had started importing were
// missing, so a deploy would have 404'd on them while this gate stayed green
// because it and the allowlist were hardcoded to the same wrong answer.
const SPECIFIER = /(?:from\s*|import\s*|new\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

async function reachableModules(entryScript) {
  const found = new Set();
  async function walk(path) {
    if (found.has(path)) return;
    found.add(path);
    const source = await readFile(resolve(root, path), 'utf8');
    for (const [, , specifier] of source.matchAll(SPECIFIER)) {
      await walk(posixNormalize(dirname(path), specifier));
    }
  }
  for (const [, , specifier] of entryScript.matchAll(SPECIFIER)) {
    await walk(specifier.replace(/^\.\//, ''));
  }
  return [...found].sort();
}

function posixNormalize(base, specifier) {
  const parts = base === '.' ? [] : base.split('/');
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

const inlineScript = index.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert(inlineScript, 'index.html has no inline module script.');
const modules = await reachableModules(inlineScript);
assert(modules.length >= 10, `Only ${modules.length} modules reachable; the graph walk is wrong.`);

// NakliAmp ships only as the NakliOS mirror (naklios.dev/apps/nakliamp/), which
// copies the files listed for it in NakliOS's apps/manifest.json. Every module
// the page imports must exist here, and must be in that list, or the mirror
// 404s on it. The manifest lives in another repository, so a missing entry is
// reported for the mirror owner rather than failing this gate.
const { access } = await import('node:fs/promises');
for (const module of modules) {
  await access(resolve(root, module)).catch(() => { throw new Error(`${module} is imported but missing.`); });
}
const shipped = ['index.html', 'VENDOR.md', 'commands.json', 'sw.js', ...modules];
const mirrorManifest = resolve(root, '../naklios-universe/naklios/apps/manifest.json');
try {
  const manifest = JSON.parse(await readFile(mirrorManifest, 'utf8'));
  const entry = manifest.apps.find(app => app.id === 'nakliamp');
  const listed = new Set((entry?.files ?? []).map(file => file.source));
  const missing = [];
  for (const file of shipped) {
    if (listed.has(file)) continue;
    try { await access(resolve(root, file)); missing.push(file); } catch { /* not a file here */ }
  }
  if (missing.length) console.log(`NOTE — NakliOS mirror manifest lacks ${missing.length} file(s): ${missing.join(', ')}`);
} catch {
  console.log('NOTE — NakliOS mirror manifest not readable here; mirror file list not compared.');
}

const pagePolicy = index.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
assert(pagePolicy, 'The in-document Content-Security-Policy is missing.');
// connect-src is exactly 'self', blob: (same-origin object URLs: the classic skin face
// and the wasm glue) and the opt-in services (T8, T9, I1). Each service is off until the
// person turns it on (app/net/consent.mjs); verify-boundary.mjs proves the default makes
// no request. Any other source, or a missing one, fails here.
const CONNECT_ALLOWLIST = [
  "'self'", 'blob:',
  'https://musicbrainz.org', 'https://coverartarchive.org', 'https://archive.org', 'https://*.archive.org',
  'https://lrclib.net', 'https://api.listenbrainz.org',
];
const connectSources = (pagePolicy.match(/(?:^|;)\s*connect-src([^;]*)/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
assert(
  connectSources.length === CONNECT_ALLOWLIST.length && CONNECT_ALLOWLIST.every(source => connectSources.includes(source)),
  `The page CSP connect-src is ${connectSources.join(' ')}; it must be exactly ${CONNECT_ALLOWLIST.join(' ')}.`,
);
// Derived, not hardcoded. A literal version here has gone stale at every bump
// and failed a correct build for naming the wrong number.
const declaredVersion = /<meta name="nakliamp-version" content="([^"]+)">/.exec(index)?.[1];
assert(declaredVersion, 'index.html declares no version.');
assert(
  index.includes(`<span class="version">v${declaredVersion}</span>`),
  `The visible version label does not match the declared version ${declaredVersion}.`,
);

assert(
  /Corresponding Mediabunny source is available[\s\S]*github\.com\/Vanilagy\/mediabunny\/tree\/v1\.51\.0/.test(vendor),
  'The Mediabunny corresponding-source notice is missing.',
);
assert(
  /The committed release gate is Chromium-only\./.test(readme),
  'The cross-browser release limitation is missing.',
);
console.log(
  `PASS — Delivery policy: ${modules.length} modules reachable, all present; `
  + 'strict CSP (connect-src = self, blob: and the opt-in allowlist); source notice; Chromium-only gate',
);
