import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [configSource, headers, assetsIgnore, index, vendor, readme] = await Promise.all([
  readFile(resolve(root, 'wrangler.jsonc'), 'utf8'),
  readFile(resolve(root, '_headers'), 'utf8'),
  readFile(resolve(root, '.assetsignore'), 'utf8'),
  readFile(resolve(root, 'index.html'), 'utf8'),
  readFile(resolve(root, 'VENDOR.md'), 'utf8'),
  readFile(resolve(root, 'README.md'), 'utf8'),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const config = JSON.parse(configSource);
assert(config.name === 'nakliamp', `Unexpected Worker name: ${config.name}`);
assert(config.compatibility_date === '2026-07-21', 'Unexpected compatibility date.');
assert(config.workers_dev === false, 'The workers.dev route must stay disabled.');
assert(config.assets?.directory === './', 'The static asset directory must be the repository root.');
assert(
  config.routes?.length === 1
    && config.routes[0]?.pattern === 'nakliamp.naklitechie.com'
    && config.routes[0]?.custom_domain === true,
  'The standalone Custom Domain route is missing or unexpected.',
);

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

const assetRules = assetsIgnore.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
assert(assetRules[0] === '*', 'The asset policy must begin by excluding every path.');
const allowed = new Set(assetRules.slice(1).map(rule => rule.replace(/^!/, '')));

// Every module the app imports must be published, or the hosted build breaks.
for (const module of modules) {
  assert(allowed.has(module), `${module} is imported but not in .assetsignore.`);
}
// And every directory on the way to it, since the allowlist is path-prefixed.
for (const module of modules) {
  const parts = module.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    const directory = `${parts.slice(0, depth).join('/')}/`;
    assert(allowed.has(directory), `${directory} is on a published path but not in .assetsignore.`);
  }
}
// Nothing may be published that the app does not need.
const required = new Set([
  'index.html', 'VENDOR.md', 'vendor/mediabunny/LICENSE-MPL-2.0.txt',
  ...modules,
  ...modules.flatMap(module => module.split('/').slice(0, -1)
    .map((_, depth, parts) => `${parts.slice(0, depth + 1).join('/')}/`)),
]);
for (const rule of allowed) {
  assert(required.has(rule), `${rule} is published but nothing imports it.`);
}

assert(!assetRules.includes('!_headers'), 'The _headers control file must not be published.');
assert(!assetRules.includes('!wrangler.jsonc'), 'The Wrangler configuration must not be published.');

const framePolicy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];
assert(
  framePolicy === "frame-ancestors 'self' https://naklios.dev https://naklios.com",
  `Unexpected frame-ancestor policy: ${framePolicy}`,
);
assert(!framePolicy.includes('*'), 'The frame-ancestor allowlist contains a wildcard.');
assert(/^\s*Referrer-Policy:\s*no-referrer$/m.test(headers), 'The referrer policy is missing.');
assert(/^\s*X-Content-Type-Options:\s*nosniff$/m.test(headers), 'The MIME-sniffing defense is missing.');

const pagePolicy = index.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
assert(pagePolicy, 'The in-document Content-Security-Policy is missing.');
assert(/connect-src 'self'/.test(pagePolicy), 'The page CSP permits an unexpected network destination.');
assert(!/connect-src[^;]*https?:/.test(pagePolicy), 'The page CSP permits a remote HTTP connection.');
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
assert(
  /https:\/\/nakliamp\.naklitechie\.com\//.test(readme),
  'The standalone publication URL is missing.',
);

console.log(
  `PASS — Delivery policy: ${modules.length} modules reachable, all published; `
  + 'strict CSP; source notice; Chromium-only gate',
);
