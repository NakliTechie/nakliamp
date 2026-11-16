// Queue panel glue: drag arithmetic, mode cycling, rows (P5, P6).
import test from 'node:test';
import assert from 'node:assert/strict';

import { dropSlot, moveTarget, nextMode, queueRows, SHUFFLE_ORDER, REPEAT_ORDER } from '../app/ui/queue-panel.mjs';
import { createQueue } from '../app/player/queue.mjs';

test('dropSlot picks the gap nearest the pointer and clamps to the list', () => {
  assert.equal(dropSlot({ y: 0, rowHeight: 48, count: 5 }), 0);
  assert.equal(dropSlot({ y: 20, rowHeight: 48, count: 5 }), 0, 'top half of row 0');
  assert.equal(dropSlot({ y: 30, rowHeight: 48, count: 5 }), 1, 'bottom half of row 0');
  assert.equal(dropSlot({ y: 48 * 4 + 40, rowHeight: 48, count: 5 }), 5, 'below the last row');
  assert.equal(dropSlot({ y: 9999, rowHeight: 48, count: 5 }), 5);
  assert.equal(dropSlot({ y: -50, rowHeight: 48, count: 5 }), 0);
  assert.equal(dropSlot({ y: 10, rowHeight: 48, count: 0 }), 0);
});

test('moveTarget turns a drop slot into queue.move\'s final position', () => {
  assert.equal(moveTarget(1, 4), 3, 'moving down: the slot after the removal');
  assert.equal(moveTarget(3, 0), 0, 'moving up');
  assert.equal(moveTarget(2, 2), -1, 'dropping above itself is no move');
  assert.equal(moveTarget(2, 3), -1, 'dropping below itself is no move');
});

test('moveTarget agrees with the queue model', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (let from = 0; from < ids.length; from++) {
    for (let slot = 0; slot <= ids.length; slot++) {
      const expected = ids.slice();
      const [moved] = expected.splice(from, 1);
      expected.splice(slot > from ? slot - 1 : slot, 0, moved);
      const queue = createQueue({ storage: null });
      queue.set(ids, 0);
      const to = moveTarget(from, slot);
      if (to >= 0) queue.move(from, to);
      assert.deepEqual(queue.snapshot().ids, expected, `from ${from} to slot ${slot}`);
    }
  }
});

test('nextMode cycles shuffle and repeat in the command order', () => {
  assert.equal(nextMode(SHUFFLE_ORDER, 'off'), 'tracks');
  assert.equal(nextMode(SHUFFLE_ORDER, 'albums'), 'off');
  assert.equal(nextMode(REPEAT_ORDER, 'all'), 'one');
  assert.equal(nextMode(REPEAT_ORDER, 'one'), 'off');
});

test('queueRows marks the current entry and keeps a row for a missing track', () => {
  const queue = createQueue({ storage: null });
  queue.set(['t1', 'gone', 't1'], 2);
  const tracks = new Map([['t1', { id: 't1', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', durationS: 545 }]]);
  const rows = queueRows(queue.snapshot(), id => tracks.get(id));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.current), [false, false, true]);
  assert.equal(rows[0].subtitle, 'Miles Davis · Kind of Blue');
  assert.equal(rows[1].missing, true);
  assert.equal(rows[1].title, 'Missing track');
  assert.notEqual(rows[0].key, rows[2].key, 'the same track twice has two keys');
});
