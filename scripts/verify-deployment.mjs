const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:8787/');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  return { response, body: await response.text() };
}

const expected = [
  ['/', 'text/html', 'v0.1.0-m0 · preview'],
  ['/VENDOR.md', 'text/markdown', 'Corresponding Mediabunny source is available'],
  ['/engine/nakliamp-engine.mjs', 'javascript', 'export function createNakliAmpEngine'],
  ['/engine/reel-engine.mjs', 'javascript', 'export function createReelEngine'],
  ['/vendor/mediabunny/LICENSE-MPL-2.0.txt', 'text/plain', 'Mozilla Public License Version 2.0'],
  ['/vendor/mediabunny/mediabunny-1.51.0.min.mjs', 'javascript', 'Vanilagy and contributors'],
];

let rootHeaders = null;
for (const [path, contentType, marker] of expected) {
  const { response, body } = await request(path);
  assert(response.status === 200, `${path}: expected 200, received ${response.status}`);
  assert(
    response.headers.get('content-type')?.toLowerCase().includes(contentType),
    `${path}: unexpected Content-Type ${response.headers.get('content-type')}`,
  );
  assert(body.includes(marker), `${path}: response omitted ${marker}`);
  if (path === '/') rootHeaders = response.headers;
}

const indexRedirect = await request('/index.html');
assert(indexRedirect.response.status === 307, `/index.html: expected 307, received ${indexRedirect.response.status}`);
assert(indexRedirect.response.headers.get('location') === '/', '/index.html: canonical redirect must target /.');

const forbidden = [
  '/.assetsignore',
  '/_headers',
  '/wrangler.jsonc',
  '/README.md',
  '/nakliamp-agent-handoff.md',
  '/scripts/verify-browser.sh',
  '/test/ui-smoke.html',
  '/.git/config',
  '/plan/history.md',
];
for (const path of forbidden) {
  const { response } = await request(path);
  assert(response.status === 404, `${path}: expected 404, received ${response.status}`);
}

assert(
  rootHeaders.get('content-security-policy') === "frame-ancestors 'self' https://naklios.dev https://naklios.com",
  `Unexpected live frame policy: ${rootHeaders.get('content-security-policy')}`,
);
assert(rootHeaders.get('referrer-policy') === 'no-referrer', 'The live referrer policy is missing.');
assert(rootHeaders.get('x-content-type-options') === 'nosniff', 'The live MIME-sniffing defense is missing.');

console.log(`PASS — Deployment boundary at ${baseUrl.origin}: 6 public assets; 1 canonical redirect; 9 private routes; strict headers`);
