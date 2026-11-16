// Folder watcher: focus after the interval, FileSystemObserver with debounce,
// one rescan at a time, no polling.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWatcher } from '../app/library/watch.mjs';

function harness({ withObserver = false, observeThrows = false } = {}) {
  let clock = 0;
  const timers = new Map();
  let nextTimer = 1;
  const focus = new Set();
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    async observe(handle, options) {
      if (observeThrows) throw new Error('not allowed');
      this.handle = handle; this.options = options;
    }
    disconnect() { this.disconnected = true; }
  }
  const environment = {
    now: () => clock,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    FileSystemObserver: withObserver ? FakeObserver : undefined,
    onFocus: listener => { focus.add(listener); return () => focus.delete(listener); },
  };
  return {
    environment, observers, timers,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of Array.from(timers)) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    },
    focus() { for (const listener of focus) listener(); },
    focusCount: () => focus.size,
  };
}

test('focus rescans only after the interval has passed', async () => {
  const h = harness();
  const reasons = [];
  const watcher = createWatcher({ handle: {}, rescan: async ({ reason }) => { reasons.push(reason); }, intervalMs: 1000, environment: h.environment });
  const state = await watcher.start();
  assert.equal(state.observing, false, 'no observer where the API is absent');
  h.focus();
  await watcher.idle();
  assert.deepEqual(reasons, []);
  h.advance(1000);
  h.focus();
  await watcher.idle();
  assert.deepEqual(reasons, ['focus']);
  h.focus();
  await watcher.idle();
  assert.deepEqual(reasons, ['focus'], 'the rescan reset the clock');
  assert.equal(h.timers.size, 0, 'no timer is left running: no polling loop');
});

test('markScanned defers the next focus rescan', async () => {
  const h = harness();
  let count = 0;
  const watcher = createWatcher({ rescan: async () => { count += 1; }, intervalMs: 1000, environment: h.environment });
  await watcher.start();
  h.advance(900);
  watcher.markScanned();
  h.advance(900);
  h.focus();
  await watcher.idle();
  assert.equal(count, 0);
});

test('observer events are debounced into one rescan', async () => {
  const h = harness({ withObserver: true });
  const reasons = [];
  const handle = { name: 'Music' };
  const watcher = createWatcher({ handle, rescan: async ({ reason }) => { reasons.push(reason); }, intervalMs: 1e9, debounceMs: 500, environment: h.environment });
  const state = await watcher.start();
  assert.equal(state.observing, true);
  const [observer] = h.observers;
  assert.equal(observer.handle, handle);
  assert.deepEqual(observer.options, { recursive: true });
  for (let i = 0; i < 20; i += 1) { observer.callback([{ type: 'appeared' }]); h.advance(100); }
  assert.deepEqual(reasons, []);
  h.advance(500);
  await watcher.idle();
  assert.deepEqual(reasons, ['observer']);
  watcher.stop();
  assert.equal(observer.disconnected, true);
  assert.equal(h.focusCount(), 0);
});

test('an observer that refuses leaves focus watching in place', async () => {
  const h = harness({ withObserver: true, observeThrows: true });
  const errors = [];
  const watcher = createWatcher({ handle: {}, rescan: async () => {}, environment: h.environment, onError: e => errors.push(e) });
  const state = await watcher.start();
  assert.equal(state.observing, false);
  assert.equal(errors.length, 1);
  assert.equal(h.focusCount(), 1);
});

test('triggers during a rescan queue exactly one more; errors do not stop the watcher', async () => {
  const h = harness();
  let release;
  let calls = 0;
  const errors = [];
  const watcher = createWatcher({
    rescan: () => { calls += 1; if (calls === 1) return new Promise(resolve => { release = resolve; }); throw new Error('disk gone'); },
    intervalMs: 0, environment: h.environment, onError: error => errors.push(error.message),
  });
  await watcher.start();
  h.focus(); h.focus(); h.focus();
  assert.equal(watcher.state().running, true);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await watcher.idle();
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['disk gone']);
  assert.equal(watcher.state().running, false);
});

test('a stopped watcher does not rescan', async () => {
  const h = harness();
  let count = 0;
  const watcher = createWatcher({ rescan: async () => { count += 1; }, intervalMs: 0, environment: h.environment });
  await watcher.start();
  watcher.stop();
  h.focus();
  await watcher.idle();
  assert.equal(count, 0);
  assert.throws(() => createWatcher({}), TypeError);
});
