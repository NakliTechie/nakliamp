import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsent, consentedFetch, originOf, KNOWN_ORIGINS, NETWORK_KEY, NetworkConsentError } from '../app/net/consent.mjs';
import { createMusicBrainz, createRateQueue, releaseToPatch, summariseReleases, isMbid, MB_ORIGIN, CAA_ORIGIN } from '../app/net/musicbrainz.mjs';
import { createLrclib, lyricsUrl, readLrclibReply, sidecarPlan, LRCLIB_ORIGIN } from '../app/net/lrclib.mjs';
import { memoryStorage, brokenStorage, json, fakeFetch, grantedConsent } from './v1x-svc-helpers.mjs';

const MBID = 'b84ee12a-09ef-421b-82de-0441a926375b';

// ------------------------------------------------------------- consent ----

test('consent: nothing is granted by default and assertAllowed refuses by name', () => {
  const c = createConsent({ storage: memoryStorage() });
  assert.equal(c.list().every(r => !r.granted), true);
  assert.equal(c.isAllowed(MB_ORIGIN), false);
  assert.throws(() => c.assertAllowed(`${MB_ORIGIN}/ws/2/release`), e => e instanceof NetworkConsentError && e.code === 'not-granted' && /MusicBrainz/.test(e.message));
});

test('consent: grant and revoke persist per origin, not per path', () => {
  const storage = memoryStorage();
  const c = createConsent({ storage, now: () => 42 });
  c.grant('https://lrclib.net/api/get?x=1');
  assert.equal(c.isAllowed('https://lrclib.net/other'), true);
  assert.equal(c.isAllowed('https://musicbrainz.org'), false);
  const again = createConsent({ storage });
  assert.equal(again.isAllowed(LRCLIB_ORIGIN), true);
  assert.equal(again.list().find(r => r.origin === LRCLIB_ORIGIN).grantedAt, 42);
  again.revoke(LRCLIB_ORIGIN);
  assert.equal(createConsent({ storage }).isAllowed(LRCLIB_ORIGIN), false);
  assert.match(storage.getItem(NETWORK_KEY), /"grants":\{\}/);
});

test('consent: plain http is refused except on localhost; junk storage is ignored', () => {
  assert.throws(() => originOf('http://192.168.1.5:4533'), e => e.code === 'bad-origin');
  assert.equal(originOf('http://localhost:4533/rest'), 'http://localhost:4533');
  const c = createConsent({ storage: memoryStorage({ [NETWORK_KEY]: '{"grants":{"http://evil.example":{},"https://ok.example":{"grantedAt":1}}}' }) });
  assert.equal(c.isAllowed('https://ok.example'), true);
  assert.equal(c.isAllowed('http://evil.example'), false);
  assert.equal(createConsent({ storage: memoryStorage({ [NETWORK_KEY]: 'not json' }) }).list().some(r => r.granted), false);
});

test('consent: blocked storage leaves everything off and grants last only for the page', () => {
  const c = createConsent({ storage: brokenStorage() });
  assert.equal(c.isAllowed(MB_ORIGIN), false);
  c.grant(MB_ORIGIN);
  assert.equal(c.isAllowed(MB_ORIGIN), true);
});

test('consent: every known origin says what it sends; onChange fires', () => {
  for (const k of KNOWN_ORIGINS) { assert.ok(k.sends.length > 10); assert.match(k.origin, /^https:\/\//); }
  const c = createConsent({ storage: memoryStorage() });
  let seen = null; c.onChange(rows => { seen = rows; });
  c.grant(CAA_ORIGIN);
  assert.equal(seen.find(r => r.origin === CAA_ORIGIN).granted, true);
});

test('consentedFetch: refuses before fetching and omits credentials and referrer', async () => {
  const f = fakeFetch(() => json({}));
  const c = createConsent({ storage: memoryStorage() });
  const get = consentedFetch(f, c);
  assert.throws(() => get('https://lrclib.net/api/get'), NetworkConsentError);
  assert.equal(f.calls.length, 0);
  c.grant(LRCLIB_ORIGIN);
  await get('https://lrclib.net/api/get');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.referrerPolicy, 'no-referrer');
});

// ---------------------------------------------------------- musicbrainz ----

test('rate queue: starts tasks at least the interval apart, in order', async () => {
  let clock = 1000; const slept = [];
  const q = createRateQueue({ intervalMs: 1000, now: () => clock, sleep: async ms => { slept.push(ms); clock += ms; } });
  const starts = [];
  await Promise.all([1, 2, 3].map(n => q(async () => { starts.push([n, clock]); clock += 100; })));
  assert.deepEqual(starts.map(s => s[0]), [1, 2, 3]);
  assert.equal(starts[1][1] - starts[0][1] >= 1000, true);
  assert.equal(starts[2][1] - starts[1][1] >= 1000, true);
  assert.deepEqual(slept, [900, 900]);
});

test('musicbrainz: search sends only artist and album text, with fmt=json', async () => {
  const f = fakeFetch(url => {
    assert.equal(url.origin, MB_ORIGIN);
    assert.equal(url.pathname, '/ws/2/release/');
    assert.equal(url.searchParams.get('fmt'), 'json');
    assert.equal(url.searchParams.get('query'), 'release:"Abbey \\"Road\\"" AND artist:"The Beatles"');
    return json({ releases: [{ id: MBID, title: 'Abbey Road', score: 100, date: '1969-09-26', country: 'GB', 'track-count': 17, 'artist-credit': [{ name: 'The Beatles' }] }, { id: 'nope' }] });
  });
  const mb = createMusicBrainz({ fetch: f, consent: grantedConsent(MB_ORIGIN), sleep: async () => {} });
  const r = await mb.searchRelease({ artist: 'The Beatles', album: 'Abbey "Road"' });
  assert.deepEqual(r, [{ mbid: MBID, title: 'Abbey Road', artist: 'The Beatles', date: '1969-09-26', year: 1969, country: 'GB', trackCount: 17, score: 100 }]);
  assert.equal(f.calls.length, 1);
});

test('musicbrainz: refuses without consent and never queues the request', async () => {
  const f = fakeFetch(() => json({}));
  const mb = createMusicBrainz({ fetch: f, consent: createConsent({ storage: memoryStorage() }) });
  await assert.rejects(mb.searchRelease({ artist: 'a', album: 'b' }), e => e.code === 'not-granted');
  await assert.rejects(mb.fetchFrontCover(MBID), e => e.code === 'not-granted');
  assert.equal(f.calls.length, 0);
});

test('musicbrainz: 503 is rate-limited, 404 not-found, bad ids refused', async () => {
  const mb = createMusicBrainz({ fetch: fakeFetch((u, i, n) => json({}, n === 1 ? 503 : 404)), consent: grantedConsent(MB_ORIGIN), sleep: async () => {} });
  await assert.rejects(mb.searchRelease({ album: 'x' }), e => e.code === 'rate-limited');
  await assert.rejects(mb.getRelease(MBID), e => e.code === 'not-found');
  await assert.rejects(mb.getRelease('../../etc'), e => e.code === 'bad-input');
  await assert.rejects(mb.searchRelease({ artist: 'x' }), e => e.code === 'bad-input');
});

const RELEASE = {
  id: MBID, title: 'Abbey Road', date: '1969-09-26',
  'artist-credit': [{ name: 'The Beatles' }],
  'release-group': { 'first-release-date': '1969-09-26', genres: [{ name: 'rock', count: 9 }, { name: 'pop', count: 3 }] },
  genres: [{ name: 'pop', count: 2 }],
  media: [{ position: 1, 'track-count': 2, tracks: [
    { position: 1, number: '1', title: 'Come Together', 'artist-credit': [{ name: 'The Beatles' }] },
    { position: 2, number: '2', title: 'Something', recording: { title: 'Something' } },
  ] }],
};

test('releaseToPatch: matches by number, then title, else album fields only', () => {
  const byNo = releaseToPatch(RELEASE, { trackNo: 2, discNo: 1, title: 'wrong' });
  assert.equal(byNo.matched, 'number');
  assert.deepEqual(byNo.patch, { album: 'Abbey Road', albumArtist: 'The Beatles', year: 1969, genre: 'Rock', discTotal: 1, title: 'Something', artist: 'The Beatles', trackNo: 2, trackTotal: 2, discNo: 1 });
  const byTitle = releaseToPatch(RELEASE, { title: 'come together' });
  assert.equal(byTitle.matched, 'title');
  assert.equal(byTitle.patch.trackNo, 1);
  const none = releaseToPatch(RELEASE, { title: 'Octopus’s Garden' });
  assert.equal(none.matched, 'album-only');
  assert.equal('title' in none.patch, false);
});

test('musicbrainz: patchesFor asks for recordings and genres', async () => {
  const f = fakeFetch(url => {
    assert.equal(url.pathname, `/ws/2/release/${MBID}`);
    assert.match(url.searchParams.get('inc'), /recordings.*genres/);
    return json(RELEASE);
  });
  const mb = createMusicBrainz({ fetch: f, consent: grantedConsent(MB_ORIGIN), sleep: async () => {} });
  const out = await mb.patchesFor(MBID, [{ id: 't1', trackNo: 1 }, { id: 't2', title: 'Something' }]);
  assert.deepEqual(out.map(o => [o.trackId, o.patch.title]), [['t1', 'Come Together'], ['t2', 'Something']]);
});

test('cover art: front-500 becomes a picture patch; 404 is null; non-images refused', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let mode = 'ok';
  const f = fakeFetch(url => {
    assert.equal(url.href, `${CAA_ORIGIN}/release/${MBID}/front-500`);
    if (mode === '404') return new Response('', { status: 404 });
    if (mode === 'html') return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  const mb = createMusicBrainz({ fetch: f, consent: grantedConsent(CAA_ORIGIN) });
  assert.deepEqual(await mb.fetchFrontCover(MBID), { mime: 'image/png', bytes: png });
  mode = '404'; assert.equal(await mb.fetchFrontCover(MBID), null);
  mode = 'html'; await assert.rejects(mb.fetchFrontCover(MBID), e => e.code === 'bad-reply');
  assert.equal(isMbid(MBID.toUpperCase()), true);
  assert.deepEqual(summariseReleases(null), []);
});

// --------------------------------------------------------------- lrclib ----

test('lrclib: URL carries title, artist, album and whole-second duration only', () => {
  const u = lyricsUrl({ title: 'Song', artist: 'Band', album: 'LP', durationS: 233.6, path: '/secret/a.mp3' });
  assert.equal(u.origin, LRCLIB_ORIGIN);
  assert.equal(u.pathname, '/api/get');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['album_name', 'artist_name', 'duration', 'track_name']);
  assert.equal(u.searchParams.get('duration'), '234');
  assert.throws(() => lyricsUrl({ title: 'x', artist: 'y' }), e => e.code === 'bad-input');
  assert.throws(() => lyricsUrl({ title: 'x', durationS: 3 }), e => e.code === 'bad-input');
});

test('lrclib: synced lyrics win; plain lyrics parse with null times; 404 is null', async () => {
  let reply = { id: 7, syncedLyrics: '[00:01.00]Hello\n[00:02.50]World', plainLyrics: 'Hello\nWorld' };
  const f = fakeFetch(() => (reply ? json(reply) : new Response('{}', { status: 404 })));
  const lr = createLrclib({ fetch: f, consent: grantedConsent(LRCLIB_ORIGIN) });
  const track = { title: 'S', artist: 'A', album: 'L', durationS: 100 };
  const synced = await lr.getLyrics(track);
  assert.equal(synced.synced, true);
  assert.deepEqual(synced.lines.map(l => [l.timeS, l.text]), [[1, 'Hello'], [2.5, 'World']]);
  reply = { syncedLyrics: null, plainLyrics: 'Just words' };
  const plain = await lr.getLyrics(track);
  assert.equal(plain.synced, false);
  assert.equal(plain.lines[0].timeS, null);
  reply = null;
  assert.equal(await lr.getLyrics(track), null);
});

test('lrclib: instrumental and empty replies; refusal without consent', async () => {
  assert.equal(readLrclibReply({ instrumental: true }).instrumental, true);
  assert.equal(readLrclibReply({ syncedLyrics: '', plainLyrics: '  ' }), null);
  const f = fakeFetch(() => json({}));
  const lr = createLrclib({ fetch: f, consent: createConsent({ storage: memoryStorage() }) });
  await assert.rejects(lr.getLyrics({ title: 'a', artist: 'b', durationS: 9 }), e => e.code === 'not-granted');
  assert.equal(f.calls.length, 0);
  const err = createLrclib({ fetch: fakeFetch(() => json({}, 500)), consent: grantedConsent(LRCLIB_ORIGIN) });
  await assert.rejects(err.getLyrics({ title: 'a', artist: 'b', durationS: 9 }), e => e.code === 'http');
});

test('lrclib: sidecar plan names the .lrc beside the track', () => {
  const r = readLrclibReply({ syncedLyrics: '[00:01.00]Hi' });
  assert.deepEqual(sidecarPlan('Music/Band/01 Song.flac', r), { name: '01 Song.lrc', text: '[00:01.00]Hi\n' });
  assert.equal(sidecarPlan('a.mp3', readLrclibReply({ instrumental: true })), null);
  assert.equal(sidecarPlan('a.mp3', null), null);
});
