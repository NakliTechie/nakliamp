import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LANE_LEAD_S, alignToFrame, createGaplessLane, equalPowerCurves, laneItem, laneJoin, sameAlbumConsecutive,
  scheduleTransition, wantsLane,
} from '../app/audio/gapless.mjs';
import { fakeBuffer, fakeContext } from './audio-fakes.mjs';

const t = (albumKey, trackNo, discNo = 1) => ({ albumKey, trackNo, discNo });

test('consecutive album tracks: next track number, or track 1 of the next disc', () => {
  assert.equal(sameAlbumConsecutive(t('a', 3), t('a', 4)), true);
  assert.equal(sameAlbumConsecutive(t('a', 3), t('a', 5)), false);
  assert.equal(sameAlbumConsecutive(t('a', 12, 1), t('a', 1, 2)), true);
  assert.equal(sameAlbumConsecutive(t('a', 12, 1), t('a', 2, 2)), false);
  assert.equal(sameAlbumConsecutive(t('a', 3), t('b', 4)), false);
  assert.equal(sameAlbumConsecutive({ albumKey: 'a', trackNo: 3 }, { albumKey: 'a', trackNo: 4 }), true, 'missing disc = disc 1');
  assert.equal(sameAlbumConsecutive({ albumKey: 'a' }, { albumKey: 'a' }), false, 'unknown order does not join');
  assert.equal(sameAlbumConsecutive(null, t('a', 1)), false);
});

test('join rule: gapless wins, crossfade otherwise, never both', () => {
  assert.equal(laneJoin({ gapless: 'albums', crossfadeS: 0 }, t('a', 1), t('a', 2)), 'gapless');
  assert.equal(laneJoin({ gapless: 'albums', crossfadeS: 4 }, t('a', 1), t('a', 2)), 'gapless');
  assert.equal(laneJoin({ gapless: 'albums', crossfadeS: 4 }, t('a', 1), t('b', 1)), 'crossfade');
  assert.equal(laneJoin({ gapless: 'albums', crossfadeS: 0 }, t('a', 1), t('b', 1)), null);
  assert.equal(laneJoin({ gapless: 'always', crossfadeS: 4 }, t('a', 1), t('b', 1)), 'gapless');
  assert.equal(laneJoin({ gapless: 'off', crossfadeS: 0 }, t('a', 1), t('a', 2)), null);
  assert.equal(laneJoin({ gapless: 'always' }, t('a', 1), null), null);
});

test('lane at load time: when any join out of the track is possible', () => {
  assert.equal(wantsLane({ gapless: 'off', crossfadeS: 0 }, t('a', 1)), false);
  assert.equal(wantsLane({ gapless: 'albums', crossfadeS: 0 }, t('a', 1)), true);
  assert.equal(wantsLane({ gapless: 'albums', crossfadeS: 0 }, null), false);
  assert.equal(wantsLane({ gapless: 'always' }, null), true);
  assert.equal(wantsLane({ gapless: 'off', crossfadeS: 3 }, null), true);
});

test('equal-power curves keep summed power at 1', () => {
  const { fadeOut, fadeIn } = equalPowerCurves(33);
  assert.equal(fadeOut[0], 1);
  assert.ok(Math.abs(fadeOut[32]) < 1e-7);
  assert.ok(Math.abs(fadeIn[32] - 1) < 1e-7);
  for (let i = 0; i < 33; i += 1) assert.ok(Math.abs(fadeOut[i] ** 2 + fadeIn[i] ** 2 - 1) < 1e-6);
  const scaled = equalPowerCurves(2, 0.5, 2);
  assert.deepEqual([scaled.fadeOut[0], scaled.fadeIn[1]], [0.5, 2]);
});

test('gapless schedule: the next starts on the frame the current ends', () => {
  const plan = scheduleTransition({ currentStartAt: 1, offsetS: 0, lengthS: 3, nextLengthS: 2, mode: 'gapless', now: 1.5, sampleRate: 48000 });
  assert.equal(plan.nextStartAt, 4);
  assert.equal(plan.fadeS, 0);
  assert.equal(plan.late, false);
  const fromOffset = scheduleTransition({ currentStartAt: 10, offsetS: 1.25, lengthS: 3, nextLengthS: 2, mode: 'gapless', now: 10, sampleRate: 48000 });
  assert.equal(fromOffset.nextStartAt, 11.75);
  assert.equal(fromOffset.nextStartAt * 48000, Math.round(fromOffset.nextStartAt * 48000), 'frame aligned');
});

test('crossfade schedule: overlap length capped at half of either track', () => {
  const plan = scheduleTransition({ currentStartAt: 0, lengthS: 10, nextLengthS: 10, mode: 'crossfade', crossfadeS: 4, now: 0 });
  assert.deepEqual([plan.nextStartAt, plan.fadeS], [6, 4]);
  const short = scheduleTransition({ currentStartAt: 0, lengthS: 10, nextLengthS: 3, mode: 'crossfade', crossfadeS: 4, now: 0 });
  assert.equal(short.fadeS, 1.5);
  const late = scheduleTransition({ currentStartAt: 0, lengthS: 10, nextLengthS: 10, mode: 'crossfade', crossfadeS: 4, now: 8 });
  assert.ok(Math.abs(late.nextStartAt - (8 + LANE_LEAD_S)) < 1e-4);
  assert.ok(Math.abs(late.fadeS - (2 - LANE_LEAD_S)) < 1e-4);
});

test('a preload that arrives after the end starts as soon as possible and says it was late', () => {
  const plan = scheduleTransition({ currentStartAt: 0, lengthS: 2, nextLengthS: 2, mode: 'gapless', now: 3 });
  assert.equal(plan.late, true);
  assert.ok(plan.nextStartAt >= 3);
});

test('laneItem snaps trims to whole frames', () => {
  const buffer = fakeBuffer(2, 48000, 48000);
  const item = laneItem(buffer, { startS: 0.0230001, endS: 0.9 }, { gainDb: -2 });
  assert.equal(item.startS * 48000, Math.round(0.0230001 * 48000));
  assert.ok(Math.abs(item.lengthS - (0.9 - item.startS)) < 1 / 48000);
  assert.equal(item.gainDb, -2);
  assert.equal(laneItem(buffer).lengthS, 1);
  assert.equal(alignToFrame(1.00001, 48000) * 48000 % 1, 0);
});

function setupLane() {
  const context = fakeContext({ sampleRate: 48000 });
  const destination = context.createGain();
  const advances = [];
  const timers = [];
  const lane = createGaplessLane({
    context,
    destination,
    onAdvance: (item, info) => advances.push([item.name, info.mode]),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const item = (name, seconds, trimStartS = 0) => ({ ...laneItem(fakeBuffer(2, Math.round((seconds + trimStartS) * 48000), 48000), { startS: trimStartS }), name, gainDb: 0 });
  return { context, destination, lane, advances, timers, item };
}

test('lane plays the trimmed region and joins the next track on the exact frame', () => {
  const { context, lane, advances, item } = setupLane();
  const a = item('a', 2, 0.05);
  lane.load(a);
  lane.play();
  const first = context.sources[0];
  assert.equal(first.started.when, LANE_LEAD_S);
  assert.ok(Math.abs(first.started.offset - 0.05) < 1e-12, 'encoder delay cut by the offset');
  assert.ok(Math.abs(first.started.duration - 2) < 1e-9);
  lane.queue(item('b', 3), { mode: 'gapless' });
  const second = context.sources[1];
  assert.equal(second.started.when, first.started.when + 2);
  assert.equal(second.started.offset, 0);
  context.currentTime = 1;
  assert.ok(Math.abs(lane.position() - (1 - LANE_LEAD_S)) < 1e-9);
  context.currentTime = second.started.when;
  assert.equal(lane.position(), 0);
  assert.deepEqual(advances, [['b', 'gapless']]);
  assert.equal(lane.current().name, 'b');
  assert.equal(first.stopped, true, 'old source released once it has finished');
});

test('lane crossfade: overlapping start and equal-power curves on both voices', () => {
  const { context, lane, advances, item } = setupLane();
  lane.load(item('a', 10));
  lane.play();
  lane.queue(item('b', 10), { mode: 'crossfade', fadeS: 4 });
  const [first, second] = context.sources;
  assert.ok(Math.abs(second.started.when - (first.started.when + 6)) < 1e-9);
  const outGain = [...first.outputs][0];
  const inGain = [...second.outputs][0];
  const outCurve = outGain.gain.calls.find(call => call[0] === 'curve');
  const inCurve = inGain.gain.calls.find(call => call[0] === 'curve');
  assert.equal(outCurve[3], 4);
  assert.equal(inCurve[2], second.started.when);
  assert.equal(outCurve[1][0], 1);
  assert.equal(inCurve[1][0], 0);
  context.currentTime = second.started.when + 1;
  lane.position();
  assert.deepEqual(advances, [['b', 'crossfade']]);
  assert.equal(lane.crossfading(), true);
  assert.equal(first.stopped, false, 'outgoing track keeps fading');
  context.currentTime = second.started.when + 4.5;
  assert.equal(lane.crossfading(), false);
});

test('lane pause, seek and clearNext reschedule cleanly', () => {
  const { context, lane, item } = setupLane();
  lane.load(item('a', 5));
  lane.play();
  lane.queue(item('b', 5), { mode: 'gapless' });
  context.currentTime = 2;
  lane.pause();
  assert.ok(context.sources.slice(0, 2).every(source => source.stopped));
  lane.seek(4);
  assert.equal(lane.position(), 4);
  lane.play();
  const resumed = context.sources[2];
  assert.equal(resumed.started.offset, 4);
  const rescheduled = context.sources[3];
  assert.ok(Math.abs(rescheduled.started.when - (resumed.started.when + 1)) < 1e-9);
  lane.clearNext();
  assert.equal(rescheduled.stopped, true);
  assert.equal(lane.next(), null);
  context.currentTime = resumed.started.when + 1.5;
  assert.equal(lane.ended(), true);
  assert.equal(lane.playing(), false);
});

test('lane gain: each voice carries its own track gain', () => {
  const { context, lane, item } = setupLane();
  const a = { ...item('a', 2), gainDb: -6 };
  lane.load(a);
  lane.play();
  // source -> fade stage -> level stage (the track gain) -> destination
  const level = source => [...[...source.outputs][0].outputs][0];
  const gain = level(context.sources[0]);
  assert.ok(Math.abs(gain.gain.value - Math.pow(10, -6 / 20)) < 1e-12);
  lane.setCurrentGainDb(-3);
  assert.equal(gain.gain.calls.at(-1)[0], 'target');
  lane.queue({ ...item('b', 2), gainDb: 2 }, { mode: 'gapless' });
  const nextGain = level(context.sources[1]);
  assert.ok(Math.abs(nextGain.gain.value - Math.pow(10, 2 / 20)) < 1e-12);
});
