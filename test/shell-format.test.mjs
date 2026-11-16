import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime, formatBytes, stem, seekTarget, scaledSeek, steppedVolume, cycle, dspSummary,
  trackSummary, page, engineMeta,
} from '../app/ui/shell/format.mjs';

test('formatTime shows minutes, and hours past an hour', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-4), '0:00');
});

test('formatBytes and stem', () => {
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(undefined), '');
  assert.equal(stem('01 Song.flac'), '01 Song');
  assert.equal(stem(''), 'Untitled track');
});

test('seekTarget handles seconds, percent and delta, clamped to the track', () => {
  const state = { positionS: 10, duration: 100 };
  assert.equal(seekTarget(state, { seconds: 42 }), 42);
  assert.equal(seekTarget(state, { percent: 50 }), 50);
  assert.equal(seekTarget(state, { delta: -30 }), 0);
  assert.equal(seekTarget(state, { delta: 500 }), 99.95);
  assert.equal(seekTarget({ positionS: 3, duration: null }, { percent: 10 }), null);
  assert.equal(seekTarget({ positionS: 3, duration: null }, { delta: 5 }), 8);
  assert.equal(seekTarget(state, {}), null);
});

test('scaledSeek follows seekStepS for the plain arrow keys only', () => {
  assert.equal(scaledSeek(5, 10, true), 10);
  assert.equal(scaledSeek(-5, 10, true), -10);
  assert.equal(scaledSeek(30, 10, true), 30);
  assert.equal(scaledSeek(5, 10, false), 5);
  assert.equal(scaledSeek(5, 0, true), 5);
});

test('steppedVolume keeps the slider grid and the 0..1 range', () => {
  assert.equal(steppedVolume(0.31, { delta: 0.05 }), 0.36);
  assert.equal(steppedVolume(0.36, { delta: -0.05 }), 0.31);
  assert.equal(steppedVolume(0.98, { delta: 0.05 }), 1);
  assert.equal(steppedVolume(0.02, { delta: -0.05 }), 0);
  assert.equal(steppedVolume(0.5, { level: 0.25 }), 0.25);
  assert.equal(steppedVolume(0.37), 0.37);
});

test('cycle wraps', () => {
  assert.equal(cycle(['off', 'all', 'one'], 'one'), 'off');
  assert.equal(cycle(['off', 'all', 'one'], 'off'), 'all');
  assert.equal(cycle(['a', 'b'], 'missing'), 'a');
});

test('dspSummary names the chain, EQ, gain and the gapless lane', () => {
  assert.deepEqual(dspSummary(null), []);
  assert.deepEqual(dspSummary({ chain: 'off', lane: 'normal' }).map(i => i.text), ['sound chain off']);
  const lane = dspSummary({
    chain: 'on', lane: 'gapless', eq: { enabled: true, preset: 'rock' }, gainSource: 'album', gainDb: -6.25,
    clipLimited: true, next: 'gapless', crossfading: false, trim: 'trimmed',
  }).map(i => i.text);
  assert.deepEqual(lane, ['EQ rock', 'gain −6.3 dB (album, peak limited)', 'next joins gapless', 'trim trimmed']);
  const fade = dspSummary({ chain: 'on', lane: 'gapless', crossfading: true, gainSource: 'loudness', gainDb: 2 }).map(i => i.text);
  assert.deepEqual(fade, ['gain +2.0 dB (measured)', 'crossfading']);
  const skipped = dspSummary({ chain: 'on', lane: 'normal', gainSource: 'none', laneSkipped: 'ERR_X' });
  assert.deepEqual(skipped.map(i => i.tone), ['', 'warning']);
});

test('trackSummary never carries the path', () => {
  const summary = trackSummary({ id: 'a', name: 'x.mp3', path: 'Music/x.mp3', title: null, artist: 'A' });
  assert.equal(summary.title, 'x');
  assert.equal('path' in summary, false);
  assert.equal(trackSummary(null), null);
});

test('page slices by offset and limit with bounds', () => {
  const list = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(page(list).items, list.slice(0, 20));
  assert.deepEqual(page(list, { offset: 40, limit: 20 }), { total: 45, offset: 40, limit: 20, items: [40, 41, 42, 43, 44] });
  assert.equal(page(list, { limit: 1000 }).limit, 100);
});

test('engineMeta copies the audio fields the engine reads', () => {
  const meta = engineMeta({ albumKey: 'k', trackNo: 2, discNo: null, replayGain: { trackGainDb: -3 }, path: 'p' }, { gainDb: 1 });
  assert.deepEqual(meta, { albumKey: 'k', trackNo: 2, discNo: null, replayGain: { trackGainDb: -3 }, loudness: { gainDb: 1 } });
  assert.equal(engineMeta(null), null);
});
