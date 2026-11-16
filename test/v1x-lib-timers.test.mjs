// P9 speed, P10 stop after current and sleep timer.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSpeed, stepSpeed, formatSpeed, createPlaybackTimers, formatRemaining, SPEED_STEPS, TimerError,
} from '../app/player/timers.mjs';

test('speed clamps to 0.5..2 and steps through the table', () => {
  assert.equal(clampSpeed(3), 2);
  assert.equal(clampSpeed(0.1), 0.5);
  assert.equal(clampSpeed('x'), 1);
  assert.equal(clampSpeed(1.333), 1.33);
  assert.equal(stepSpeed(1, 1), 1.1);
  assert.equal(stepSpeed(1, -1), 0.9);
  assert.equal(stepSpeed(2, 1), 2);
  assert.equal(stepSpeed(0.5, -1), 0.5);
  assert.equal(stepSpeed(1.3, 1), 1.5);
  assert.equal(stepSpeed(1.3, -1), 1.25);
  assert.equal(SPEED_STEPS.includes(1), true);
  assert.equal(formatSpeed(1.25), '1.25x');
});

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('stop after current fires once on the next track end', () => {
  const timers = createPlaybackTimers();
  const seen = [];
  timers.onChange(state => seen.push(state.stopAfterCurrent));
  timers.setStopAfterCurrent(true);
  assert.equal(timers.trackEnded(), 'stop');
  assert.equal(timers.trackEnded(), 'continue');
  assert.deepEqual(seen, [true, false]);
});

test('sleep timer in minutes fades over the last 10 s, then stops and clears', () => {
  const c = clock(1000);
  const timers = createPlaybackTimers({ now: c.now });
  timers.setSleep({ minutes: 1 });
  assert.equal(timers.status().sleep.remainingS, 60);
  assert.deepEqual(timers.tick(), { volume: 1, action: null });
  c.advance(55_000);
  assert.deepEqual(timers.tick(), { volume: 0.5, action: null });
  c.advance(5_000);
  assert.deepEqual(timers.tick(), { volume: 0, action: 'stop' });
  assert.equal(timers.status().sleep, null);
  assert.deepEqual(timers.tick(), { volume: 1, action: null }, 'the next play is not faded');
});

test('sleep at end of track fades on track time and stops at the end', () => {
  const timers = createPlaybackTimers();
  timers.setSleep({ mode: 'end-of-track' });
  assert.equal(timers.status().sleep.remainingS, null);
  assert.equal(timers.tick({ positionS: 100, durationS: 200 }).volume, 1);
  assert.equal(timers.tick({ positionS: 195, durationS: 200 }).volume, 0.5);
  assert.equal(timers.tick({ positionS: 5 }).volume, 1, 'unknown duration does not fade');
  assert.equal(timers.trackEnded(), 'stop');
  assert.equal(timers.status().sleep, null);
});

test('sleep at end of queue fades and stops only on the last track', () => {
  const timers = createPlaybackTimers();
  timers.setSleep({ mode: 'end-of-queue' });
  assert.equal(timers.tick({ positionS: 195, durationS: 200, isLast: false }).volume, 1);
  assert.equal(timers.trackEnded({ isLast: false }), 'continue');
  assert.equal(timers.tick({ positionS: 198, durationS: 200, isLast: true }).volume, 0.2);
  assert.equal(timers.trackEnded({ isLast: true }), 'stop');
});

test('bad sleep settings are refused; cancel clears', () => {
  const timers = createPlaybackTimers();
  assert.throws(() => timers.setSleep({ minutes: 0 }), TimerError);
  assert.throws(() => timers.setSleep({ minutes: 5000 }), /1440/);
  assert.throws(() => timers.setSleep({ mode: 'whenever' }), /whenever/);
  timers.setSleep({ minutes: 5 });
  timers.cancelSleep();
  assert.equal(timers.status().sleep, null);
});

test('remaining time formats as m:ss or h:mm:ss', () => {
  assert.equal(formatRemaining(1500), '25:00');
  assert.equal(formatRemaining(3723), '1:02:03');
  assert.equal(formatRemaining(0.2), '0:01');
  assert.equal(formatRemaining(null), '');
});
