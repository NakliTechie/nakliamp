// Play queue model (P5, P6, Y5). Run: node --test test/queue-model.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, QUEUE_STORAGE_KEY, UNDO_LIMIT } from '../app/player/queue.mjs';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}
// A seeded generator so shuffles are reproducible.
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const q = (opts = {}) => createQueue({ storage: memoryStorage(), random: seeded(7), ...opts });

test('set starts at the given entry and next/prev walk the list', () => {
  const queue = q();
  queue.set(['a', 'b', 'c'], 1);
  assert.equal(queue.current(), 'b');
  assert.equal(queue.next(), 'c');
  assert.equal(queue.next(), null, 'repeat off stops at the end');
  assert.equal(queue.current(), 'c');
  assert.equal(queue.prev(), 'b');
  assert.equal(queue.prev(), 'a');
  assert.equal(queue.prev(), null);
});

test('an empty queue has nothing current and set([]) leaves index -1', () => {
  const queue = q();
  assert.equal(queue.current(), null);
  assert.equal(queue.next(), null);
  queue.set([]);
  assert.equal(queue.snapshot().index, -1);
});

test('set clamps startIndex and drops invalid ids', () => {
  const queue = q();
  queue.set(['a', '', null, 'b'], 99);
  assert.deepEqual(queue.snapshot().ids, ['a', 'b']);
  assert.equal(queue.current(), 'b');
});

test('playNext inserts after the current entry in order; add appends', () => {
  const queue = q();
  queue.set(['a', 'b', 'c'], 0);
  queue.playNext(['x', 'y']);
  queue.add(['z']);
  assert.deepEqual(queue.snapshot().ids, ['a', 'x', 'y', 'b', 'c', 'z']);
  assert.equal(queue.next(), 'x');
});

test('the same track can be queued twice and keys stay unique', () => {
  const queue = q();
  queue.set(['a', 'a']);
  queue.add(['a']);
  const { keys } = queue.snapshot();
  assert.equal(new Set(keys).size, 3);
});

test('move keeps the current entry current', () => {
  const queue = q();
  queue.set(['a', 'b', 'c', 'd'], 1);
  queue.move(1, 3);
  assert.deepEqual(queue.snapshot().ids, ['a', 'c', 'd', 'b']);
  assert.equal(queue.snapshot().index, 3);
  queue.move(0, 3);
  assert.equal(queue.current(), 'b');
  assert.throws(() => queue.move(0, 9), RangeError);
});

test('remove before the current entry shifts the index; removing the current entry moves on', () => {
  const queue = q();
  queue.set(['a', 'b', 'c', 'd'], 2);
  let info;
  queue.onChange((_, i) => { info = i; });
  queue.remove([0]);
  assert.equal(queue.current(), 'c');
  assert.equal(info.currentChanged, false);
  queue.remove([1]);
  assert.equal(queue.current(), 'd');
  assert.equal(info.currentChanged, true);
  queue.remove([1]);
  assert.equal(queue.current(), 'b', 'removing the last entry falls back to the new last');
  queue.remove([0]);
  assert.equal(queue.current(), null);
  assert.equal(queue.snapshot().index, -1);
});

test('clear empties and undo restores', () => {
  const queue = q();
  queue.set(['a', 'b'], 1);
  queue.clear();
  assert.equal(queue.snapshot().length, 0);
  assert.equal(queue.undo(), true);
  assert.deepEqual(queue.snapshot().ids, ['a', 'b']);
  assert.equal(queue.current(), 'b');
});

test('undo is one step per edit, keeps the playing entry, and ignores navigation', () => {
  const queue = q();
  queue.set(['a', 'b', 'c']);
  queue.add(['d']);
  queue.next(); queue.next();          // now on c; navigation is not an edit
  queue.remove([3]);
  assert.deepEqual(queue.snapshot().ids, ['a', 'b', 'c']);
  queue.undo();
  assert.deepEqual(queue.snapshot().ids, ['a', 'b', 'c', 'd']);
  assert.equal(queue.current(), 'c', 'undo keeps the entry that is playing');
  queue.undo();
  assert.deepEqual(queue.snapshot().ids, ['a', 'b', 'c']);
  queue.undo();
  assert.deepEqual(queue.snapshot().ids, []);
  assert.equal(queue.undo(), false);
  assert.equal(queue.snapshot().canUndo, false);
});

test(`undo keeps at least 50 steps (limit ${UNDO_LIMIT})`, () => {
  const queue = q();
  queue.set(['start']);
  for (let i = 0; i < 60; i++) queue.add([`t${i}`]);
  for (let i = 0; i < 60; i++) assert.equal(queue.undo(), true);
  assert.deepEqual(queue.snapshot().ids, ['start']);
  assert.ok(UNDO_LIMIT >= 50);
});

test('repeat all wraps both ways; repeat one replays on auto-advance only', () => {
  const queue = q();
  queue.set(['a', 'b'], 1);
  queue.setRepeat('all');
  assert.equal(queue.peekNext(), 'a');
  assert.equal(queue.next(), 'a');
  assert.equal(queue.prev(), 'b');
  queue.setRepeat('one');
  assert.equal(queue.peekNext({ auto: true }), 'b');
  assert.equal(queue.next({ auto: true }), 'b');
  assert.equal(queue.next(), 'a', 'a person pressing Next still moves on');
  assert.throws(() => queue.setRepeat('sometimes'), RangeError);
});

test('track shuffle keeps the current entry first and every entry once; off restores order', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const queue = q();
  queue.set(ids, 5);
  queue.setShuffle('tracks');
  const s = queue.snapshot();
  assert.equal(s.index, 0);
  assert.equal(s.current, 't5');
  assert.deepEqual([...s.ids].sort(), [...ids].sort());
  assert.notDeepEqual(s.ids, ids);
  queue.setShuffle('off');
  assert.deepEqual(queue.snapshot().ids, ids);
  assert.equal(queue.current(), 't5');
});

test('edits while shuffled survive turning shuffle off', () => {
  const queue = q();
  queue.set(['a', 'b', 'c', 'd'], 0);
  queue.setShuffle('tracks');
  queue.add(['e']);
  queue.playNext(['n']);
  queue.remove([queue.snapshot().ids.indexOf('c')]);
  queue.setShuffle('off');
  assert.deepEqual(queue.snapshot().ids, ['a', 'n', 'b', 'd', 'e']);
});

test('album shuffle keeps track order inside each album', () => {
  const album = { a1: 'A', a2: 'A', a3: 'A', b1: 'B', b2: 'B', c1: 'C', c2: 'C', c3: 'C', d1: 'D' };
  const ids = Object.keys(album);
  for (let seed = 1; seed < 12; seed++) {
    const queue = createQueue({ storage: null, random: seeded(seed), albumOf: id => album[id] });
    queue.set(ids, 3); // b1
    queue.setShuffle('albums');
    const out = queue.snapshot().ids;
    assert.equal(queue.current(), 'b1');
    assert.deepEqual([...out].sort(), [...ids].sort());
    for (const name of ['A', 'B', 'C', 'D']) {
      const run = out.filter(id => album[id] === name);
      const at = out.indexOf(run[0]);
      assert.deepEqual(out.slice(at, at + run.length), run, `album ${name} stays together`);
      assert.deepEqual(run, ids.filter(id => album[id] === name), `album ${name} keeps its order`);
    }
    assert.deepEqual(out.slice(0, 2), ['b1', 'b2'], 'the playing album comes first');
  }
});

test('setShuffle is an undo step', () => {
  const queue = q();
  queue.set(['a', 'b', 'c', 'd', 'e'], 0);
  queue.setShuffle('tracks');
  queue.undo();
  assert.equal(queue.snapshot().shuffle, 'off');
  assert.deepEqual(queue.snapshot().ids, ['a', 'b', 'c', 'd', 'e']);
});

test('the queue persists and reloads, including shuffle and repeat', () => {
  const storage = memoryStorage();
  const first = createQueue({ storage, random: seeded(3) });
  first.set(['a', 'b', 'c'], 0);
  first.setShuffle('tracks');
  first.setRepeat('all');
  first.next();
  const second = createQueue({ storage });
  const a = first.snapshot(); const b = second.snapshot();
  assert.deepEqual(b.ids, a.ids);
  assert.equal(b.index, a.index);
  assert.equal(b.shuffle, 'tracks');
  assert.equal(b.repeat, 'all');
  second.setShuffle('off');
  assert.deepEqual(second.snapshot().ids, ['a', 'b', 'c']);
  assert.ok(storage.data.has(QUEUE_STORAGE_KEY));
});

test('damaged or blocked storage starts an empty queue without throwing', () => {
  assert.equal(createQueue({ storage: memoryStorage({ [QUEUE_STORAGE_KEY]: '{not json' }) }).snapshot().length, 0);
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const queue = createQueue({ storage: blocked });
  queue.set(['a']);
  assert.equal(queue.current(), 'a');
  const odd = memoryStorage({ [QUEUE_STORAGE_KEY]: JSON.stringify({ entries: [{ key: 1, id: 'a' }, { key: 1, id: 'b' }, { key: 'x', id: 'c' }], index: 7, shuffle: 'wild' }) });
  const loaded = createQueue({ storage: odd }).snapshot();
  assert.deepEqual(loaded.ids, ['a']);
  assert.equal(loaded.index, 0);
  assert.equal(loaded.shuffle, 'off');
});

test('onChange reports the reason and can be removed', () => {
  const queue = q();
  const reasons = [];
  const off = queue.onChange((snap, info) => reasons.push(info.reason));
  queue.set(['a', 'b']);
  queue.jump(1);
  off();
  queue.clear();
  assert.deepEqual(reasons, ['set', 'jump']);
});
