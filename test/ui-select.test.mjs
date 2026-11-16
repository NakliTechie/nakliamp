// Selection model for the library and queue lists (Y4).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelection } from '../app/ui/select.mjs';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];

test('a plain click selects only that row and sets anchor and cursor', () => {
  const s = createSelection(order);
  s.click(2);
  s.click(4);
  assert.deepEqual(s.selectedKeys(), ['e']);
  assert.equal(s.anchor, 4);
  assert.equal(s.cursor, 4);
});

test('Cmd or Ctrl click toggles rows without touching the others', () => {
  const s = createSelection(order);
  s.click(1).click(3, { toggle: true }).click(5, { toggle: true });
  assert.deepEqual(s.selectedKeys(), ['b', 'd', 'f']);
  s.click(3, { toggle: true });
  assert.deepEqual(s.selectedKeys(), ['b', 'f']);
});

test('Shift click selects from the anchor and replaces the selection, in either direction', () => {
  const s = createSelection(order);
  s.click(3).click(5, { range: true });
  assert.deepEqual(s.selectedKeys(), ['d', 'e', 'f']);
  s.click(1, { range: true });
  assert.deepEqual(s.selectedKeys(), ['b', 'c', 'd']);
  assert.equal(s.anchor, 3, 'the anchor stays where the range started');
  assert.equal(s.cursor, 1);
});

test('Cmd Shift click adds a range to an existing selection', () => {
  const s = createSelection(order);
  s.click(0).click(3, { toggle: true }).click(5, { range: true, toggle: true });
  assert.deepEqual(s.selectedKeys(), ['a', 'd', 'e', 'f']);
});

test('arrows move and select one row; Shift arrows extend from the anchor', () => {
  const s = createSelection(order);
  s.move(1);
  assert.equal(s.cursor, 0, 'the first arrow down lands on the first row');
  s.move(1).move(1, { extend: true }).move(1, { extend: true });
  assert.deepEqual(s.selectedKeys(), ['b', 'c', 'd']);
  s.move(-1, { extend: true });
  assert.deepEqual(s.selectedKeys(), ['b', 'c']);
  s.move(1);
  assert.deepEqual(s.selectedKeys(), ['d']);
});

test('the cursor clamps at both ends and an up arrow from nothing starts at the end', () => {
  const s = createSelection(order);
  s.move(-1);
  assert.equal(s.cursor, 5);
  s.move(10);
  assert.equal(s.cursor, 5);
  s.moveTo(-4);
  assert.equal(s.cursor, 0);
});

test('focus moves the cursor only, and Space toggles the cursor row', () => {
  const s = createSelection(order);
  s.click(0).focus(2).toggleCursor();
  assert.deepEqual(s.selectedKeys(), ['a', 'c']);
  s.toggleCursor();
  assert.deepEqual(s.selectedKeys(), ['a']);
});

test('select all and clear', () => {
  const s = createSelection(order);
  s.selectAll();
  assert.equal(s.size, 6);
  assert.deepEqual(s.selectedIndices(), [0, 1, 2, 3, 4, 5]);
  s.clear();
  assert.equal(s.size, 0);
  assert.deepEqual(s.selectedKeys(), []);
});

test('a new order keeps the keys still present, in the new order', () => {
  const s = createSelection(order);
  s.click(1).click(4, { toggle: true });
  s.setOrder(['e', 'x', 'b']);
  assert.deepEqual(s.selectedKeys(), ['e', 'b']);
  assert.deepEqual(s.selectedIndices(), [0, 2]);
  assert.equal(s.cursor, 0, 'the cursor follows its key');
  s.setOrder(['x']);
  assert.equal(s.size, 0);
  assert.equal(s.cursor, -1);
  assert.equal(s.anchor, -1);
});

test('an empty list ignores every gesture', () => {
  const s = createSelection([]);
  s.click(0).move(1).selectAll().toggleCursor();
  assert.equal(s.size, 0);
  assert.equal(s.cursor, -1);
  assert.equal(s.isSelected(0), false);
});
