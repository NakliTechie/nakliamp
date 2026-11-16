// Review 2026-11-17, findings N35 (MusicBrainz rate and cover size) and N48 (ListenBrainz
// queue persistence). Run: node --test test/review-d-net.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicBrainz, createRateQueue, MB_ORIGIN, CAA_ORIGIN, MB_PAUSE_MS } from '../app/net/musicbrainz.mjs';
import { createListenBrainz, makeListen, QUEUE_MAX, LB_ORIGIN } from '../app/net/listenbrainz.mjs';
import { memoryStorage, brokenStorage, fakeFetch, grantedConsent, json } from './v1x-svc-helpers.mjs';

const MBID = 'b84ee12a-09ef-421b-82de-0441a926375b';

// A Web Locks stand-in: one holder per name at a time, the others wait in order.
function fakeLocks() {
  const tails = new Map();
  return {
    request(name, callback) {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(() => callback());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

// A shared fake clock: sleep advances it, so waits are measured exactly.
function fakeClock(start = 10_000) {
  const clock = { t: start };
  clock.now = () => clock.t;
  clock.sleep = async ms => { clock.t += ms; };
  return clock;
}

test('N35: two pages sharing one Web Lock start MusicBrainz requests at least the interval apart', async () => {
  const clock = fakeClock();
  const locks = fakeLocks();
  const tabA = createRateQueue({ intervalMs: 1000, now: clock.now, sleep: clock.sleep, locks });
  const tabB = createRateQueue({ intervalMs: 1000, now: clock.now, sleep: clock.sleep, locks });
  const starts = [];
  await Promise.all([
    tabA(async () => { starts.push(clock.t); clock.t += 50; }),
    tabB(async () => { starts.push(clock.t); clock.t += 50; }),
    tabA(async () => { starts.push(clock.t); clock.t += 50; }),
  ]);
  assert.equal(starts.length, 3);
  const sorted = starts.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 1000, `starts ${sorted.join(', ')} are closer than 1 s across pages`);
  }
});

test('N35: a 503 pauses the MusicBrainz queue for Retry-After before the next request', async () => {
  const clock = fakeClock();
  const starts = [];
  const f = fakeFetch((url, init, n) => {
    starts.push(clock.t);
    return n === 1 ? json({}, 503, { 'retry-after': '4' }) : json({ releases: [] });
  });
  const mb = createMusicBrainz({ fetch: f, consent: grantedConsent(MB_ORIGIN), now: clock.now, sleep: clock.sleep, locks: null });
  await assert.rejects(mb.searchRelease({ album: 'x' }), e => e.code === 'rate-limited');
  await mb.searchRelease({ album: 'y' });
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 4000, `second request started ${starts[1] - starts[0]} ms after the 503`);
});

test('N35: a 503 with no Retry-After pauses for MB_PAUSE_MS', async () => {
  const clock = fakeClock();
  const starts = [];
  const f = fakeFetch((url, init, n) => { starts.push(clock.t); return json({}, n === 1 ? 503 : 200); });
  const mb = createMusicBrainz({ fetch: f, consent: grantedConsent(MB_ORIGIN), now: clock.now, sleep: clock.sleep, locks: null });
  await assert.rejects(mb.searchRelease({ album: 'x' }), e => e.code === 'rate-limited');
  await mb.searchRelease({ album: 'y' });
  assert.ok(starts[1] - starts[0] >= MB_PAUSE_MS);
});

test('N35: a cover whose content-length is over 8 MB is refused before its body is read', async () => {
  let bodyRead = false;
  const big = {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg', 'content-length': String(9 * 1024 * 1024) }),
    body: null,
    async arrayBuffer() { bodyRead = true; return new ArrayBuffer(9 * 1024 * 1024); },
  };
  const mb = createMusicBrainz({ fetch: async () => big, consent: grantedConsent(CAA_ORIGIN) });
  await assert.rejects(mb.fetchFrontCover(MBID), e => e.code === 'too-large');
  assert.equal(bodyRead, false, 'the oversized body was read');
});

test('N35: a cover with no content-length stops reading once it passes 8 MB', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 20) controller.close(); else controller.enqueue(chunk);
    },
  });
  const res = new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
  const mb = createMusicBrainz({ fetch: async () => res, consent: grantedConsent(CAA_ORIGIN) });
  await assert.rejects(mb.fetchFrontCover(MBID), e => e.code === 'too-large');
  assert.ok(pulled <= 10, `read ${pulled} chunks of 1 MB for an 8 MB limit`);
});

test('N35: a cover under the limit still comes back whole', async () => {
  const png = new Uint8Array(3000).map((_, i) => i % 251);
  const mb = createMusicBrainz({
    fetch: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    consent: grantedConsent(CAA_ORIGIN),
  });
  assert.deepEqual(await mb.fetchFrontCover(MBID), { mime: 'image/png', bytes: png });
});

const TRACK = { artist: 'Some Artist Name', title: 'A Fairly Long Track Title (Remastered 2019)', album: 'An Album Title, Deluxe Edition', durationS: 245, trackNo: 7, releaseMbid: MBID };

test('N48: a failed save is reported by saveError, enqueue and flush', async () => {
  const lb = createListenBrainz({ fetch: fakeFetch(() => json({ status: 'ok' })), consent: grantedConsent(LB_ORIGIN), storage: brokenStorage() });
  assert.equal(lb.saveError(), null);
  const out = lb.enqueue(makeListen(TRACK, 1_700_000_000));
  assert.deepEqual(out, { queued: 1, saved: false });
  assert.equal(lb.saveError()?.queued, 1);
  assert.match(lb.saveError().message, /blocked/);
  const flushed = await lb.flush();
  assert.equal(flushed.saved, false);
});

test('N48: a save that succeeds clears the error and reports saved', async () => {
  let fail = true;
  const inner = memoryStorage();
  const storage = { getItem: k => inner.getItem(k), setItem: (k, v) => { if (fail) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } inner.setItem(k, v); } };
  const lb = createListenBrainz({ fetch: fakeFetch(() => json({})), consent: grantedConsent(LB_ORIGIN), storage });
  assert.equal(lb.enqueue(makeListen(TRACK, 1_700_000_000)).saved, false);
  assert.equal(lb.saveError().name, 'QuotaExceededError');
  fail = false;
  assert.deepEqual(lb.enqueue(makeListen(TRACK, 1_700_000_100)), { queued: 2, saved: true });
  assert.equal(lb.saveError(), null);
  assert.equal(JSON.parse(inner.getItem('nakliamp:listenbrainz')).queue.length, 2);
});

test('N48: a full queue of typical listens takes at most 2 MiB of storage, counted as UTF-16', () => {
  const listen = makeListen(TRACK, 1_700_000_000, { clientVersion: '0.3.0-m2' });
  const bytes = JSON.stringify({ token: 'x'.repeat(36), queue: Array.from({ length: QUEUE_MAX }, () => listen), rejected: [], nextAttemptAt: 0, failures: 0 }).length * 2;
  assert.ok(bytes <= 2 * 1024 * 1024, `a full queue takes ${bytes} bytes as UTF-16, past 2 MiB`);
});
