// describeTagChange and summariseTagChanges (app/tags/diff.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTagChange, summariseTagChanges, formatTagValue } from '../app/tags/diff.mjs';
import { planTagWrite } from '../app/tags/write.mjs';
import { fixture, id3Tag, latin1, concat, mp3Audio, PNG, JPEG } from './tags-helpers.mjs';

const BEFORE = {
  title: 'Old', artist: 'Band', album: null, albumArtist: null, trackNo: 1, trackTotal: null,
  discNo: null, discTotal: null, year: 2001, genre: 'Rock', rating: 0, picture: { mime: 'image/png', bytes: PNG },
};

test('describeTagChange lists only the fields that change', () => {
  const diff = describeTagChange(BEFORE, { title: 'New', artist: 'Band', album: 'First', trackNo: '1', year: 2002, rating: 3, genre: '' });
  assert.deepEqual(diff.changes.map((change) => change.field), ['title', 'album', 'genre', 'year', 'rating']);
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.lines, [
    'Title: "Old" to "New"',
    'Album: (empty) to "First"',
    'Genre: "Rock" to (empty)',
    'Year: 2001 to 2002',
    'Rating: (empty) to 3 stars',
  ]);
});

test('describeTagChange compares pictures by bytes', () => {
  assert.equal(describeTagChange(BEFORE, { picture: { mime: 'image/png', bytes: PNG.slice() } }).unchanged, true);
  const replaced = describeTagChange(BEFORE, { picture: { mime: 'image/jpeg', bytes: JPEG } });
  assert.equal(replaced.changes[0].label, 'Cover art');
  assert.match(replaced.lines[0], /^Cover art: PNG image, 1 KB to JPEG image, 1 KB$/);
  assert.equal(describeTagChange(BEFORE, { picture: null }).changes[0].toText, '(empty)');
});

test('describeTagChange carries the ID3v2.3 upgrade note from planTagWrite', async () => {
  const bytes = concat(id3Tag(3, [['TIT2', latin1('Old')]]), mp3Audio(await fixture('audio-mp3.mp3')));
  const plan = await planTagWrite(new Blob([bytes]), { title: 'New' });
  const diff = describeTagChange({ title: 'Old' }, { title: 'New' }, plan);
  assert.equal(diff.lines.length, 2);
  assert.match(diff.lines[1], /ID3v2\.3 tag will be saved as ID3v2\.4/);
});

test('summariseTagChanges counts files and fields and lists notes once', () => {
  const plan = { notes: ['note A'] };
  const summary = summariseTagChanges([
    describeTagChange({ album: 'X' }, { album: 'Y' }, plan),
    describeTagChange({ album: 'Y' }, { album: 'Y' }, plan),
    describeTagChange({ album: 'Z', genre: null }, { album: 'Y', genre: 'Pop' }),
  ]);
  assert.deepEqual(summary, { files: 3, filesChanged: 2, fields: { album: 2, genre: 1 }, notes: ['note A'] });
});

test('formatTagValue', () => {
  assert.equal(formatTagValue('rating', 1), '1 star');
  assert.equal(formatTagValue('title', null), '(empty)');
});
