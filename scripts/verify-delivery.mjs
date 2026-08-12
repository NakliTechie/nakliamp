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

const expectedAllowlist = [
  '!index.html',
  '!VENDOR.md',
  '!engine/',
  '!engine/nakliamp-engine.mjs',
  '!engine/reel-engine.mjs',
  '!vendor/',
  '!vendor/mediabunny/',
  '!vendor/mediabunny/LICENSE-MPL-2.0.txt',
  '!vendor/mediabunny/mediabunny-1.51.0.min.mjs',
];
const assetRules = assetsIgnore.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
assert(assetRules[0] === '*', 'The asset policy must begin by excluding every path.');
assert(
  JSON.stringify(assetRules.slice(1)) === JSON.stringify(expectedAllowlist),
  `Unexpected asset allowlist: ${assetRules.slice(1).join(', ')}`,
);
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
assert(/<span class="version">v0\.1\.0-m0 · preview<\/span>/.test(index), 'The visible M0 preview label is missing.');

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

console.log('PASS — Delivery policy: six public artifacts; strict CSP; source notice; Chromium-only gate');
