// Visualiser driver lifetime. Run: node --test test/visualiser-driver.test.mjs
//
// `modes.mjs` is pure and tested against a recording context; this covers the
// part that owns a lifetime — the scheduled callback and the installed mode.
// Both failures here are invisible in a screenshot and permanent in a tab:
//
//   - `stop()` cancelled one id in two independent pools, so it could cancel
//     an unrelated callback that happened to share the number, including the
//     page's own clock frame, which nothing reschedules;
//   - a mode that threw was left installed, so the caller's next `start()`
//     ran it again — throw, report, stop, restart, once per frame, forever.
//
// The driver reaches for globals (`requestAnimationFrame`, `setTimeout`) and a
// canvas, so both are supplied here as recording fakes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createVisualiser } from '../app/visualiser/driver.mjs';

/** A canvas whose 2D context accepts everything and remembers nothing. */
function fakeCanvas() {
  const context = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : () => {}),
    set: (target, name, value) => { target[name] = value; return true; },
  });
  return { clientWidth: 320, clientHeight: 120, width: 320, height: 120, getContext: () => context };
}

/**
 * Take over both scheduling pools with ids that deliberately overlap, which is
 * the only way the confusion between them is observable.
 */
function fakeScheduler() {
  const log = { frames: [], timeouts: [], cancelledFrames: [], clearedTimeouts: [] };
  let nextId = 0;
  const saved = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.requestAnimationFrame = callback => {
    const id = (nextId += 1);
    log.frames.push({ id, callback });
    return id;
  };
  globalThis.cancelAnimationFrame = id => { log.cancelledFrames.push(id); };
  globalThis.setTimeout = callback => {
    const id = (nextId += 1);
    log.timeouts.push({ id, callback });
    return id;
  };
  globalThis.clearTimeout = id => { log.clearedTimeouts.push(id); };
  log.restore = () => Object.assign(globalThis, saved);
  return log;
}

test('stopping cancels only the pool the pending callback came from', () => {
  const scheduler = fakeScheduler();
  try {
    const animated = createVisualiser({ canvas: fakeCanvas(), getAnalyser: () => null });
    animated.setMode('bars');
    assert.equal(scheduler.frames.length, 1, 'an animation frame should be pending');
    animated.stop();
    assert.deepEqual(scheduler.cancelledFrames, [scheduler.frames[0].id]);
    assert.deepEqual(scheduler.clearedTimeouts, [],
      'an animation frame id was also cleared as a timeout, cancelling whatever holds that number');

    // Reduced motion schedules with setTimeout instead. Its id is a different
    // number in a different pool, and cancelling it as a frame would cancel
    // the page's own clock frame.
    const slowed = createVisualiser({ canvas: fakeCanvas(), getAnalyser: () => null, reducedMotion: () => true });
    slowed.setMode('bars');
    assert.equal(scheduler.timeouts.length, 1, 'a timeout should be pending under reduced motion');
    const before = scheduler.cancelledFrames.length;
    slowed.stop();
    assert.deepEqual(scheduler.clearedTimeouts, [scheduler.timeouts[0].id]);
    assert.equal(scheduler.cancelledFrames.length, before,
      'a timeout id was cancelled as an animation frame');
  } finally {
    scheduler.restore();
  }
});

test('a mode that throws is replaced, not merely stopped', () => {
  const scheduler = fakeScheduler();
  try {
    const errors = [];
    const visualiser = createVisualiser({
      canvas: fakeCanvas(),
      // The analyser read is the first thing inside the frame's try block.
      getAnalyser: () => { throw new Error('the analyser is gone'); },
      onError: error => errors.push(error),
    });
    visualiser.setMode('bars');
    assert.equal(visualiser.mode(), 'bars');

    scheduler.frames.at(-1).callback();
    assert.equal(errors.length, 1, 'the failure was not reported');
    assert.equal(visualiser.running, false, 'the driver kept running after a throw');
    assert.equal(visualiser.mode(), 'none',
      'the throwing mode is still installed; the next start() runs it again');

    // The caller restarts on the next clock frame. That must be a no-op now.
    const scheduled = scheduler.frames.length;
    visualiser.start();
    assert.equal(visualiser.running, false, 'the failing mode restarted itself');
    assert.equal(scheduler.frames.length, scheduled, 'a frame was scheduled for a mode that cannot draw');
    assert.equal(errors.length, 1, 'the failure repeated');
  } finally {
    scheduler.restore();
  }
});

test('the mode reported after a failure is the one a caller can persist', () => {
  const scheduler = fakeScheduler();
  try {
    let reported = null;
    const visualiser = createVisualiser({
      canvas: fakeCanvas(),
      getAnalyser: () => { throw new Error('gone'); },
      onError: () => { reported = visualiser.mode(); },
    });
    visualiser.setMode('wave');
    scheduler.frames.at(-1).callback();
    assert.equal(reported, 'none', 'onError saw the failing mode, so the UI would restore it');
  } finally {
    scheduler.restore();
  }
});

test('a stereo mode is given two channels, not one spectrum cut in half', () => {
  const scheduler = fakeScheduler();
  try {
    // Distinct per-channel content, so a mode drawing the same array twice —
    // or drawing halves of the summed one — is visible in what it draws.
    const analyserFor = fill => ({
      fftSize: 2048,
      frequencyBinCount: 1024,
      getByteFrequencyData: array => array.fill(fill),
      getByteTimeDomainData: array => array.fill(128),
    });
    const summed = analyserFor(60);
    const channels = [analyserFor(200), analyserFor(20)];

    let asked = 0;
    const visualiser = createVisualiser({
      canvas: fakeCanvas(),
      getAnalyser: () => summed,
      getChannelAnalysers: () => { asked += 1; return channels; },
    });

    // A mode that does not declare stereo must not pay for the second tap.
    visualiser.setMode('bars');
    scheduler.frames.at(-1).callback();
    assert.equal(asked, 0, 'a mono mode read the per-channel taps');

    visualiser.setMode('stereo');
    scheduler.frames.at(-1).callback();
    assert.equal(asked, 1, 'the stereo mode did not read the per-channel taps');
  } finally {
    scheduler.restore();
  }
});
