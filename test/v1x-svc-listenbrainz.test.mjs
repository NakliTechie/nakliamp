import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsent } from '../app/net/consent.mjs';
import {
  memoryTokenStore,
  createListenBrainz, createPlayTracker, shouldScrobble, scrobbleThresholdS, makeListen, backoffMs,
  LB_ORIGIN, LB_KEY, BATCH_MAX, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
} from '../app/net/listenbrainz.mjs';
import { memoryStorage, json, fakeFetch, grantedConsent } from './v1x-svc-helpers.mjs';

const TOKEN = '0b9e1d6a-6f6c-4c55-9a0e-1234567890ab';
const track = (n = 1) => ({ id: `t${n}`, title: `Song ${n}`, artist: 'Band', album: 'LP', durationS: 200, trackNo: n, path: '/secret/x.mp3' });
const listen = (n = 1) => makeListen(track(n), 1_700_000_000 + n);

function client({ routes, storage = memoryStorage(), clock = { t: 1_000_000 }, tokenStore = memoryTokenStore() } = {}) {
  const f = fakeFetch(routes);
  const lb = createListenBrainz({ fetch: f, consent: grantedConsent(LB_ORIGIN), storage, tokenStore, now: () => clock.t, clientVersion: '1.0' });
  lb.setToken(TOKEN);
  return { lb, f, storage, clock };
}
const bodyOf = call => JSON.parse(call.init.body);

test('scrobble rule: over 30 s long, then half or 4 minutes', () => {
  assert.equal(shouldScrobble({ durationS: 30, playedS: 30 }), false);
  assert.equal(shouldScrobble({ durationS: 31, playedS: 15.4 }), false);
  assert.equal(shouldScrobble({ durationS: 31, playedS: 15.5 }), true);
  assert.equal(shouldScrobble({ durationS: 600, playedS: 239 }), false);
  assert.equal(shouldScrobble({ durationS: 600, playedS: 240 }), true);
  assert.equal(shouldScrobble({ durationS: NaN, playedS: 999 }), false);
  assert.equal(scrobbleThresholdS(20), null);
  assert.equal(scrobbleThresholdS(1000), 240);
});

test('makeListen: sends tags and client name, never the path', () => {
  const l = makeListen(track(3), 1700000000.9, { clientVersion: '1.2' });
  assert.equal(l.listened_at, 1700000000);
  assert.deepEqual(l.track_metadata, {
    artist_name: 'Band', track_name: 'Song 3', release_name: 'LP',
    additional_info: { media_player: 'NakliAmp', submission_client: 'NakliAmp', media_player_version: '1.2', submission_client_version: '1.2', duration_ms: 200000, tracknumber: 3 },
  });
  assert.equal(JSON.stringify(l).includes('secret'), false);
  assert.throws(() => makeListen({ title: 'x' }, 1), e => e.code === 'bad-input');
  assert.equal('listened_at' in makeListen(track(), null), false);
});

test('validate-token: sends Authorization: Token and reads user_name', async () => {
  const { lb, f } = client({ routes: url => (url.pathname === '/1/validate-token' ? json({ valid: true, user_name: 'chirag', code: 200 }) : json({}, 404)) });
  assert.deepEqual(await lb.validateToken(), { valid: true, userName: 'chirag' });
  assert.equal(f.calls[0].init.headers.Authorization, `Token ${TOKEN}`);
  const bad = client({ routes: () => json({ valid: false }, 401) });
  assert.deepEqual(await bad.lb.validateToken(), { valid: false, userName: null });
});

test('token: refused when malformed, kept when good, and never written to localStorage (N15)', () => {
  const { lb, storage } = client({ routes: () => json({}) });
  assert.throws(() => lb.setToken('bad token!'), e => e.code === 'bad-input');
  assert.equal(lb.token(), TOKEN);
  assert.equal(JSON.parse(storage.getItem(LB_KEY)).token, undefined);
  lb.clearToken();
  assert.equal(lb.token(), '');
});

test('flush: one listen goes as single, more as import batches of 50, in order', async () => {
  const { lb, f } = client({ routes: () => json({ status: 'ok' }) });
  lb.enqueue(listen(1));
  assert.equal((await lb.flush()).status, 'sent');
  assert.equal(bodyOf(f.calls[0]).listen_type, 'single');
  for (let i = 0; i < 120; i += 1) lb.enqueue(listen(i + 10));
  const r = await lb.flush();
  assert.deepEqual([r.sent, r.remaining, r.status], [120, 0, 'sent']);
  const batches = f.calls.slice(1).map(bodyOf);
  assert.deepEqual(batches.map(b => [b.listen_type, b.payload.length]), [['import', BATCH_MAX], ['import', 50], ['import', 20]]);
  assert.equal(batches[0].payload[0].listened_at, 1_700_000_010);
  assert.equal(batches[2].payload[19].listened_at, 1_700_000_129);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
});

test('offline queue survives a restart and is retried in order with backoff', async () => {
  const storage = memoryStorage(); const clock = { t: 5_000_000 };
  let online = false;
  const routes = () => { if (!online) throw new TypeError('Failed to fetch'); return json({ status: 'ok' }); };
  // The token store stands in for the sealed vault, which outlives the page.
  const tokenStore = memoryTokenStore();
  const first = client({ routes, storage, clock, tokenStore });
  first.lb.enqueue(listen(1)); first.lb.enqueue(listen(2));
  const r1 = await first.lb.flush();
  assert.equal(r1.status, 'offline');
  assert.equal(r1.retryAt, clock.t + BACKOFF_BASE_MS);
  // A new page load: same storage, the queue is still there.
  const f2 = fakeFetch(routes);
  const second = createListenBrainz({ fetch: f2, consent: grantedConsent(LB_ORIGIN), storage, tokenStore, now: () => clock.t });
  assert.equal(second.queued().length, 2);
  assert.equal((await second.flush()).status, 'waiting');
  assert.equal(f2.calls.length, 0);
  clock.t += BACKOFF_BASE_MS - 1;
  assert.equal((await second.flush()).status, 'waiting');
  clock.t += 1;
  assert.equal((await second.flush()).status, 'offline'); // second failure doubles the wait
  assert.equal(second.nextAttemptAt(), clock.t + 2 * BACKOFF_BASE_MS);
  online = true;
  const r = await second.flush({ force: true });
  assert.deepEqual([r.status, r.sent], ['sent', 2]);
  assert.deepEqual(bodyOf(f2.calls.at(-1)).payload.map(p => p.listened_at), [1_700_000_001, 1_700_000_002]);
  assert.equal(JSON.parse(storage.getItem(LB_KEY)).queue.length, 0);
});

test('429 honours Retry-After; 5xx backs off; backoff caps at 1 hour', async () => {
  const { lb, clock } = client({ routes: () => json({}, 429, { 'retry-after': '600' }) });
  lb.enqueue(listen(1));
  const r = await lb.flush();
  assert.equal(r.status, 'http-429');
  assert.equal(r.retryAt, clock.t + 600_000);
  assert.equal(backoffMs(30), BACKOFF_MAX_MS);
  assert.equal(backoffMs(1, 5), BACKOFF_BASE_MS);
  const s = client({ routes: () => json({}, 502) });
  s.lb.enqueue(listen(1));
  assert.equal((await s.lb.flush()).status, 'http-502');
});

test('401 keeps the queue and reports the token; no token means no request', async () => {
  const { lb, f } = client({ routes: () => json({ code: 401 }, 401) });
  lb.enqueue(listen(1));
  const r = await lb.flush();
  assert.deepEqual([r.status, r.remaining], ['bad-token', 1]);
  lb.clearToken();
  assert.equal((await lb.flush()).status, 'no-token');
  assert.equal(f.calls.length, 1);
});

test('400 on a batch resends one at a time and sets aside only the bad listen', async () => {
  const { lb, f } = client({ routes: (u, init) => {
    const body = JSON.parse(init.body);
    return body.payload.some(p => p.listened_at === 1_700_000_002) ? json({ code: 400 }, 400) : json({ status: 'ok' });
  } });
  [1, 2, 3].forEach(n => lb.enqueue(listen(n)));
  const r = await lb.flush();
  assert.deepEqual([r.status, r.sent, r.rejected, r.remaining], ['sent', 2, 1, 0]);
  assert.deepEqual(f.calls.map(c => bodyOf(c).payload.length), [3, 1, 1, 1]);
  assert.equal(lb.rejected()[0].listen.listened_at, 1_700_000_002);
});

test('refuses without consent; concurrent flushes share one run', async () => {
  const f = fakeFetch(() => json({ status: 'ok' }));
  const lb = createListenBrainz({ fetch: f, consent: createConsent({ storage: memoryStorage() }), storage: memoryStorage() });
  lb.setToken(TOKEN); lb.enqueue(listen(1));
  await assert.rejects(lb.flush(), e => e.code === 'not-granted');
  assert.equal(f.calls.length, 0);
  const ok = client({ routes: () => json({ status: 'ok' }) });
  ok.lb.enqueue(listen(1));
  const [a, b] = await Promise.all([ok.lb.flush(), ok.lb.flush()]);
  assert.equal(a, b);
  assert.equal(ok.f.calls.length, 1);
  assert.throws(() => ok.lb.enqueue({ nope: 1 }), e => e.code === 'bad-input');
});

test('playing_now is sent but never queued', async () => {
  const { lb, f } = client({ routes: () => { throw new TypeError('offline'); } });
  assert.deepEqual(await lb.nowPlaying(track()), { ok: false, status: 'offline' });
  assert.equal(lb.queued().length, 0);
  assert.equal(bodyOf(f.calls[0]).listen_type, 'playing_now');
  assert.equal('listened_at' in bodyOf(f.calls[0]).payload[0], false);
});

test('play tracker: counts forward play only and fires once at the threshold', () => {
  const got = [];
  const tr = createPlayTracker({ onScrobble: l => got.push(l), now: () => 1_700_000_000_000 });
  tr.start({ title: 'S', artist: 'A', durationS: 100 });
  for (let s = 1; s <= 30; s += 1) tr.position(s);
  tr.position(95); // a seek forward adds nothing
  assert.equal(got.length, 0);
  tr.position(40); // back seek, then play on
  for (let s = 41; s <= 60; s += 1) tr.position(s);
  assert.equal(got.length, 1);
  assert.equal(got[0].listened_at, 1_700_000_000);
  for (let s = 61; s <= 99; s += 1) tr.position(s);
  assert.equal(got.length, 1);
  tr.start({ title: 'Short', artist: 'A', durationS: 25 });
  for (let s = 1; s <= 25; s += 1) tr.position(s);
  assert.equal(got.length, 1);
});
