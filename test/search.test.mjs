// Fuzzy-search unit tests. Run: node --test test/search.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, searchTracks } from '../app/library/search.mjs';

const track = fields => ({
  title: null, artist: null, album: null, albumArtist: null, name: null, genre: null, ...fields,
});

test('a subsequence matches; a non-subsequence does not', () => {
  assert.notEqual(fuzzyScore('skr', 'Sakura'), null);
  assert.notEqual(fuzzyScore('saku', 'Sakura'), null);
  assert.notEqual(fuzzyScore('sakura', 'Sakura'), null);
  assert.equal(fuzzyScore('sakz', 'Sakura'), null);
  assert.equal(fuzzyScore('xyz', 'Sakura'), null);
});

test('matching is case-insensitive and ignores spaces in the query', () => {
  assert.notEqual(fuzzyScore('SAKURA', 'sakura'), null);
  assert.notEqual(fuzzyScore('s k r', 'Sakura'), null);
});

test('an empty query matches everything, an empty field matches nothing', () => {
  assert.equal(fuzzyScore('', 'anything'), 0);
  assert.equal(fuzzyScore('a', ''), null);
  assert.equal(fuzzyScore('a', null), null);
});

test('a contiguous run outranks scattered letters', () => {
  const contiguous = fuzzyScore('blue', 'Blue in Green');
  const scattered = fuzzyScore('blue', 'Bells Loom Under Everything');
  assert.ok(contiguous > scattered, `${contiguous} should beat ${scattered}`);
});

test('a match at a word start outranks one mid-word', () => {
  const wordStart = fuzzyScore('gr', 'Blue in Green');
  const midWord = fuzzyScore('gr', 'Programme');
  assert.ok(wordStart > midWord, `${wordStart} should beat ${midWord}`);
});

test('an exact title ranks above an incidental match', () => {
  const results = searchTracks([
    track({ title: 'Something Else Entirely', artist: 'So What Band' }),
    track({ title: 'So What', artist: 'Miles Davis' }),
  ], 'so what');
  assert.equal(results[0].title, 'So What');
});

test('the title field outweighs the genre field', () => {
  const results = searchTracks([
    track({ title: 'Unrelated', genre: 'Jazz' }),
    track({ title: 'Jazz', genre: 'Rock' }),
  ], 'jazz');
  assert.equal(results[0].title, 'Jazz');
});

test('a track matching on any field is found', () => {
  const rows = [
    track({ title: 'One', artist: 'Miles Davis' }),
    track({ title: 'Two', album: 'Kind of Blue' }),
    track({ title: 'Three', name: '03 hidden.flac' }),
  ];
  assert.equal(searchTracks(rows, 'miles').length, 1);
  assert.equal(searchTracks(rows, 'kind').length, 1);
  assert.equal(searchTracks(rows, 'hidden').length, 1);
});

test('an empty query preserves the incoming order', () => {
  const rows = [track({ title: 'B' }), track({ title: 'A' }), track({ title: 'C' })];
  assert.deepEqual(searchTracks(rows, '').map(row => row.title), ['B', 'A', 'C']);
  assert.deepEqual(searchTracks(rows, '   ').map(row => row.title), ['B', 'A', 'C']);
});

test('search never mutates the input array', () => {
  const rows = [track({ title: 'B' }), track({ title: 'A' })];
  const before = rows.map(row => row.title);
  searchTracks(rows, 'a');
  assert.deepEqual(rows.map(row => row.title), before);
});

test('a query longer than every field matches nothing rather than throwing', () => {
  assert.deepEqual(searchTracks([track({ title: 'Hi' })], 'a very long query indeed'), []);
});
