// Review 2026-11-17, findings N38 (repeat all with shuffle replays one order) and N39
// (a stored order with a duplicate key loses an entry). Run: node --test test/review-d-queue.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, QUEUE_STORAGE_KEY } from '../app/player/queue.mjs';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// Play one full pass from the current entry: the ids in the order they become current.
function playPass(queue, length, options = { auto: true }) {
  const order = [queue.current()];
  for (let i = 1; i < length; i++) order.push(queue.next(options));
  return order;
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

test('N38: repeat all with shuffle reshuffles each pass instead of replaying it', () => {
  const queue = createQueue({ storage: memoryStorage(), random: seeded(11) });
  queue.set(IDS, 0);
  queue.setShuffle('tracks');
  queue.setRepeat('all');
  const first = playPass(queue, IDS.length);
  const passes = [first];
  for (let p = 0; p < 4; p++) {
    passes.push([queue.next({ auto: true }), ...playPass(queue, IDS.length).slice(1)]);
  }
  for (const pass of passes) assert.deepEqual(pass.slice().sort(), IDS.slice().sort(), 'every pass plays each entry once');
  const distinct = new Set(passes.map(p => p.join(',')));
  assert.ok(distinct.size > 1, `all ${passes.length} passes played the same order: ${first.join(',')}`);
  for (let p = 1; p < passes.length; p++) {
    assert.notEqual(passes[p][0], passes[p - 1].at(-1), 'a new pass never starts on the entry that just played');
  }
});

test('N38: peekNext at the wrap names the entry next then plays, and stays stable', () => {
  const queue = createQueue({ storage: memoryStorage(), random: seeded(5) });
  queue.set(IDS, 0);
  queue.setShuffle('tracks');
  queue.setRepeat('all');
  playPass(queue, IDS.length);
  const peeked = queue.peekNext({ auto: true });
  assert.equal(queue.peekNext({ auto: true }), peeked, 'two peeks at the wrap disagree');
  assert.equal(queue.next({ auto: true }), peeked);
  assert.equal(queue.snapshot().index, 0);
  assert.equal(queue.current(), peeked);
});

test('N38: tracks added during a shuffled pass are mixed into the next pass', () => {
  const queue = createQueue({ storage: memoryStorage(), random: seeded(3) });
  queue.set(['a', 'b', 'c', 'd'], 0);
  queue.setShuffle('tracks');
  queue.setRepeat('all');
  queue.add(['x', 'y', 'z']);
  playPass(queue, 7);
  const second = [queue.next({ auto: true }), ...playPass(queue, 7).slice(1)];
  assert.deepEqual(second.slice().sort(), ['a', 'b', 'c', 'd', 'x', 'y', 'z']);
  assert.notDeepEqual(second.slice(-3), ['x', 'y', 'z'], 'the added tracks still sit at the end');
});

test('N38: without shuffle, repeat all still wraps to the first entry in order', () => {
  const queue = createQueue({ storage: memoryStorage(), random: seeded(9) });
  queue.set(['a', 'b', 'c'], 2);
  queue.setRepeat('all');
  assert.equal(queue.next({ auto: true }), 'a');
  assert.deepEqual(queue.snapshot().ids, ['a', 'b', 'c']);
});

test('N38: turning shuffle off after a reshuffled pass restores the person\'s order', () => {
  const queue = createQueue({ storage: memoryStorage(), random: seeded(13) });
  queue.set(IDS, 0);
  queue.setShuffle('tracks');
  queue.setRepeat('all');
  playPass(queue, IDS.length);
  queue.next({ auto: true });
  queue.setShuffle('off');
  assert.deepEqual(queue.snapshot().ids, IDS);
});

test('N39: a stored order with a duplicate key keeps every entry when shuffle is turned off', () => {
  const stored = {
    entries: [{ key: 1, id: 'a' }, { key: 2, id: 'b' }, { key: 3, id: 'c' }],
    unshuffled: [1, 1, 2],
    index: 2, shuffle: 'tracks', repeat: 'off', nextKey: 4,
  };
  const queue = createQueue({ storage: memoryStorage({ [QUEUE_STORAGE_KEY]: JSON.stringify(stored) }), random: seeded(1) });
  assert.equal(queue.current(), 'c');
  queue.setShuffle('off');
  assert.equal(queue.current(), 'c', 'the current entry was lost');
  assert.deepEqual(queue.snapshot().ids.slice().sort(), ['a', 'b', 'c']);
  assert.equal(new Set(queue.snapshot().keys).size, 3, 'an entry appears twice');
});

test('N39: a stored order missing a key keeps the person\'s order and appends the missing entry', () => {
  const stored = {
    entries: [{ key: 3, id: 'c' }, { key: 1, id: 'a' }, { key: 2, id: 'b' }],
    unshuffled: [2, 1],
    index: 0, shuffle: 'tracks', repeat: 'off', nextKey: 4,
  };
  const queue = createQueue({ storage: memoryStorage({ [QUEUE_STORAGE_KEY]: JSON.stringify(stored) }) });
  queue.setShuffle('off');
  assert.deepEqual(queue.snapshot().ids, ['b', 'a', 'c']);
  assert.equal(queue.current(), 'c');
});
