// L14 duplicate finder.
import test from 'node:test';
import assert from 'node:assert/strict';

import { findDuplicates, normaliseForMatch, suggestKeep } from '../app/library/duplicates.mjs';

const t = (id, overrides) => ({ id, path: `${id}.mp3`, size: 1000 + id.charCodeAt(0), durationS: 200, artist: 'A', title: 'T', ...overrides });

test('normalising folds accents, case, punctuation and ampersands', () => {
  assert.equal(normaliseForMatch('  Beyoncé & JAY-Z '), 'beyonce and jay z');
  assert.equal(normaliseForMatch("Don't Stop"), 'don t stop');
  assert.equal(normaliseForMatch(null), '');
});

test('same artist and title within 2 s is a likely group; 3 s apart is not', () => {
  const groups = findDuplicates([
    t('a', { durationS: 200 }), t('b', { durationS: 201.5, artist: 'a', title: 't!' }),
    t('c', { durationS: 204 }), t('d', { title: 'Other' }),
  ]);
  assert.deepEqual(groups.map(g => [g.kind, g.ids]), [['likely', ['a', 'b']]]);
});

test('clusters anchor on the shortest track so a chain does not stretch', () => {
  const groups = findDuplicates([t('a', { durationS: 100 }), t('b', { durationS: 101.5 }), t('c', { durationS: 103 })]);
  assert.deepEqual(groups.map(g => g.ids), [['a', 'b']]);
});

test('same size and duration is exact, whatever the tags; a likely group inside it is dropped', () => {
  const groups = findDuplicates([
    t('a', { size: 5000, durationS: 180, title: 'One' }),
    t('b', { size: 5000, durationS: 180, title: 'Two', artist: 'B' }),
    t('c', { size: 7000, durationS: 180, title: 'One' }),
    t('d', { size: 9000, durationS: 90, artist: 'X', title: 'Y' }),
    t('e', { size: 9000, durationS: 90, artist: 'X', title: 'Y' }),
  ]);
  assert.deepEqual(groups.map(g => [g.kind, g.ids]), [
    ['exact', ['a', 'b']],
    ['exact', ['d', 'e']],
    ['likely', ['a', 'c']],
  ]);
});

test('untagged, durationless, hidden and virtual tracks are left out where they would mislead', () => {
  const groups = findDuplicates([
    t('a', { artist: null, title: null }), t('b', { artist: null, title: null, size: 1 }),
    t('c', { durationS: null }), t('d', { durationS: null }),
    t('e', { hidden: 1, size: 77 }), t('f', { size: 77 }),
    t('g', { virtual: { parentPath: 'x' }, size: 55, title: 'V1' }), t('h', { virtual: { parentPath: 'x' }, size: 55, title: 'V2' }),
  ]);
  assert.deepEqual(groups, []);
});

test('keep suggestion prefers play count, rating, favourite, size, then shorter path', () => {
  assert.equal(suggestKeep([t('a', { playCount: 1 }), t('b', { playCount: 3 })]).id, 'b');
  assert.equal(suggestKeep([t('a', { rating: 2 }), t('b', { rating: 4 })]).id, 'b');
  assert.equal(suggestKeep([t('a', { size: 10 }), t('b', { size: 20 })]).id, 'b');
  assert.equal(suggestKeep([t('a', { size: 1, path: 'long/path.mp3' }), t('b', { size: 1, path: 'p.mp3' })]).id, 'b');
  const [group] = findDuplicates([t('a', { playCount: 9 }), t('b')]);
  assert.equal(group.keepId, 'a');
});
