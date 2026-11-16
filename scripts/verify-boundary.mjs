import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corePath = resolve(root, 'engine/nakliamp-engine.mjs');
const core = await readFile(corePath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  /^import \{ createReelEngine \} from '\.\/reel-engine\.mjs';$/m.test(core),
  'NakliAmp core does not import the pinned Reel boundary.',
);
assert(!/\b(document|querySelector|HTMLElement)\b/.test(core), 'NakliAmp core imports UI-layer concepts.');
assert(/export function createNakliAmpEngine/.test(core), 'NakliAmp core factory is missing.');

const sourceFiles = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.worktrees', 'vendor', 'dist'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(html|js|mjs)$/.test(entry.name)) sourceFiles.push(path);
  }
}
await walk(root);

const directIngress = [];
for (const path of sourceFiles) {
  if (path === resolve(root, 'engine/reel-engine.mjs')) continue;
  const source = await readFile(path, 'utf8');
  if (/from\s+['"][^'"]*mediabunny/i.test(source)) directIngress.push(relative(root, path));
}
assert(directIngress.length === 0, `Direct Mediabunny imports: ${directIngress.join(', ')}`);

// ---- Network boundary, two modes (plan/cliamp-parity.md: opt-in, per origin, off by default).
//
// Static: no app or engine code opens a network channel of its own. The only fetch
// callers are the app/net modules, and each wraps the injected fetch in consentedFetch,
// which checks the person's grant before every request. sw.js only serves its own scope.
const NETWORK_PRIMITIVE = /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|new\s+EventSource|sendBeacon|importScripts\s*\(/;
const sdkCut = text => text.replace(/\/\* naklios-sdk:begin[\s\S]*?\/\* naklios-sdk:end \*\//, '');
const strayNetwork = [];
for (const path of sourceFiles) {
  const rel = relative(root, path);
  if (rel === 'sw.js' || rel.startsWith('test/') || rel.startsWith('scripts/') || rel.startsWith('app/net/')) continue;
  if (NETWORK_PRIMITIVE.test(sdkCut(await readFile(path, 'utf8')))) strayNetwork.push(rel);
}
assert(strayNetwork.length === 0, `Network calls outside app/net: ${strayNetwork.join(', ')}`);
for (const name of ['musicbrainz', 'lrclib', 'listenbrainz']) {
  const source = await readFile(resolve(root, `app/net/${name}.mjs`), 'utf8');
  assert(/consentedFetch\(fetchFn, consent\)/.test(source), `app/net/${name}.mjs does not wrap its fetch in consentedFetch.`);
  assert(!/\bfetchFn\s*\(/.test(source), `app/net/${name}.mjs calls fetch without the consent check.`);
}
const sw = await readFile(resolve(root, 'sw.js'), 'utf8');
assert(/self\.registration\.scope|location\.origin|startsWith/.test(sw), 'sw.js does not limit itself to its own scope.');

// Runtime: every network feature, called with a recording fetch.
const { createConsent, KNOWN_ORIGINS } = await import('../app/net/consent.mjs');
const { createMusicBrainz } = await import('../app/net/musicbrainz.mjs');
const { createLrclib } = await import('../app/net/lrclib.mjs');
const { createListenBrainz, makeListen } = await import('../app/net/listenbrainz.mjs');

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
const MBID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const TRACK = { id: 't1', title: 'Song', artist: 'Artist', album: 'Album', durationS: 200, trackNo: 1 };

async function exercise(grantOrigins) {
  const requested = [];
  const fakeFetch = async url => {
    requested.push(new URL(String(url)).origin);
    return new Response(JSON.stringify({ releases: [], valid: true, user_name: 'x', syncedLyrics: null, plainLyrics: 'la' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const storage = memoryStorage();
  const consent = createConsent({ storage });
  for (const origin of grantOrigins) consent.grant(origin);
  const mb = createMusicBrainz({ fetch: fakeFetch, consent, sleep: async () => {}, intervalMs: 0 });
  const lrc = createLrclib({ fetch: fakeFetch, consent });
  const lb = createListenBrainz({ fetch: fakeFetch, consent, storage });
  lb.setToken('0123456789abcdef');
  lb.enqueue(makeListen(TRACK, 1_700_000_000));
  const calls = [
    () => mb.searchRelease({ artist: 'Artist', album: 'Album' }),
    () => mb.getRelease(MBID),
    () => mb.fetchFrontCover(MBID),
    () => lrc.getLyrics(TRACK),
    () => lb.validateToken(),
    () => lb.flush({ force: true }),
    () => lb.nowPlaying(TRACK),
  ];
  for (const call of calls) { try { await call(); } catch { /* a refusal or a parse error; only the requests count */ } }
  return requested;
}

// Default profile: nothing granted, so not one request leaves the page.
const defaultRequests = await exercise([]);
assert(defaultRequests.length === 0, `The default profile made ${defaultRequests.length} request(s): ${defaultRequests.join(', ')}`);
// Configured profile: each origin alone; requests go to that origin only.
for (const { origin } of KNOWN_ORIGINS) {
  const requests = await exercise([origin]);
  assert(requests.length > 0, `Granting ${origin} made no request; the runtime check exercised nothing.`);
  const stray = requests.filter(seen => seen !== origin);
  assert(stray.length === 0, `With only ${origin} granted, requests went to ${stray.join(', ')}.`);
}

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert(readme.includes('no analytics — verify with the network tab.'), 'README omits the network-verifiable analytics claim.');

console.log('PASS — Engine boundary: headless NakliAmp core; pinned Reel ingress; zero direct Mediabunny imports; '
  + `network two-mode: default profile 0 requests, each of ${KNOWN_ORIGINS.length} origins alone reaches only itself`);
