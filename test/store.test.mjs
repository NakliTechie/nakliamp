// Library-index unit tests for the parts that do not need IndexedDB.
// The IndexedDB round-trip is covered by the browser harness; everything here
// is pure and runs under `node --test test/store.test.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRACK_SCHEMA,
  LibraryValidationError,
  validateTrack,
  groupKey,
  albumKeyOf,
  trackId,
  indexHash,
  groupAlbums,
  groupArtists,
  compareAlbumOrder,
  IDENTITY_FIELDS,
  MUTABLE_FIELDS,
} from '../app/library/store.mjs';

const base = overrides => ({
  id: 'a'.repeat(32),
  path: 'Jazz/Kind of Blue/01 So What.flac',
  name: '01 So What.flac',
  size: 1234,
  ...overrides,
});

// ------------------------------------------------------ validation ----

test('a minimal record is accepted and fully normalised', () => {
  const record = validateTrack(base());
  assert.equal(record.schema, TRACK_SCHEMA);
  assert.equal(record.title, null);
  assert.equal(record.resumePositionS, 0, 'D4 requires a resume position from the first schema version');
  assert.equal(record.playCount, 0);
  assert.equal(record.bookmarked, 0);
  assert.equal(record.hasLyrics, false);
  assert.equal(typeof record.albumKey, 'string');
  assert.equal(typeof record.artistKey, 'string');
});

test('missing identity fields are refused with a named field', () => {
  const cases = [
    [{ ...base(), id: '' }, 'id'],
    [{ ...base(), path: undefined }, 'path'],
    [{ ...base(), size: -1 }, 'size'],
    [{ ...base(), size: Number.NaN }, 'size'],
    [{ ...base(), title: 42 }, 'title'],
    [{ ...base(), trackNo: 'three' }, 'trackNo'],
    [{ ...base(), durationS: Number.POSITIVE_INFINITY }, 'durationS'],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => validateTrack(input), error => {
      assert.ok(error instanceof LibraryValidationError, 'wrong error type');
      assert.equal(error.code, 'ERR_NAKLIAMP_LIBRARY_INVALID');
      assert.equal(error.field, field);
      return true;
    }, `expected ${field} to be refused`);
  }
  assert.throws(() => validateTrack(null), LibraryValidationError);
  assert.throws(() => validateTrack('nope'), LibraryValidationError);
});

test('a track numbered 0 is preserved rather than coerced away', () => {
  const record = validateTrack(base({ trackNo: 0, year: 0, durationS: 0 }));
  assert.equal(record.trackNo, 0);
  assert.equal(record.year, 0);
  assert.equal(record.durationS, 0);
});

test('an empty-string tag is preserved rather than turned into null', () => {
  const record = validateTrack(base({ title: '', artist: '' }));
  assert.equal(record.title, '');
  assert.equal(record.artist, '');
});

test('unknown input fields do not survive into the record', () => {
  const record = validateTrack(base({ evil: 'payload', __proto__mark: 1 }));
  assert.equal(record.evil, undefined);
  assert.equal(Object.hasOwn(record, 'evil'), false);
});

// ------------------------------------------------------------ keys ----

test('groupKey folds case, accents and whitespace', () => {
  assert.equal(groupKey('Bjork'), 'bjork');
  assert.equal(groupKey('BJORK'), 'bjork');
  assert.equal(groupKey('  Miles   Davis  '), 'miles davis');
  assert.equal(groupKey('Björk'), 'bjork', 'a composed umlaut must fold to its base letter');
  assert.equal(groupKey('Björk'), 'bjork', 'a decomposed umlaut must fold the same way');
  assert.equal(groupKey(''), 'unknown');
  assert.equal(groupKey(null), 'unknown');
  assert.equal(groupKey(undefined), 'unknown');
});

test('albumKeyOf falls back from album artist to track artist', () => {
  assert.equal(
    albumKeyOf({ albumArtist: 'Miles Davis', artist: 'Bill Evans', album: 'Kind of Blue' }),
    albumKeyOf({ albumArtist: null, artist: 'Miles Davis', album: 'Kind of Blue' }),
  );
});

test('albumKeyOf separates two albums that share a title', () => {
  const first = albumKeyOf({ albumArtist: 'Nirvana', album: 'Live' });
  const second = albumKeyOf({ albumArtist: 'Alice Coltrane', album: 'Live' });
  assert.notEqual(first, second);
});

test('trackId is stable for a path and differs between paths', async () => {
  const first = await trackId('a/b.flac');
  assert.equal(first, await trackId('a/b.flac'));
  assert.notEqual(first, await trackId('a/c.flac'));
  assert.match(first, /^[0-9a-f]{32}$/);
});

// ------------------------------------------------------ index hash ----

const track = (path, overrides = {}) => validateTrack(base({ id: path, path, ...overrides }));

test('indexHash is order-independent and reproducible', async () => {
  const tracks = [track('b.flac'), track('a.flac'), track('c.flac')];
  const forward = await indexHash(tracks);
  const reversed = await indexHash([...tracks].reverse());
  assert.equal(forward, reversed, 'scan order must not change the hash');
  assert.equal(forward, await indexHash(tracks), 'the same input must hash the same twice');
  assert.match(forward, /^[0-9a-f]{64}$/);
});

test('indexHash ignores playback state but reacts to identity', async () => {
  const before = [track('a.flac', { title: 'One' })];
  const played = [validateTrack({ ...before[0], resumePositionS: 42, playCount: 9, bookmarked: 1, lastPlayedAt: 1700 })];
  assert.equal(await indexHash(before), await indexHash(played), 'playback state must not perturb the hash');

  const retitled = [track('a.flac', { title: 'Two' })];
  assert.notEqual(await indexHash(before), await indexHash(retitled), 'a changed title must change the hash');
});

test('no field appears in both the identity and mutable sets', () => {
  const overlap = IDENTITY_FIELDS.filter(field => MUTABLE_FIELDS.includes(field));
  assert.deepEqual(overlap, []);
});

test('field values cannot run together across a boundary', async () => {
  // Without delimiters, ("ab", "c") and ("a", "bc") would hash identically.
  const left = [track('a.flac', { title: 'ab', artist: 'c' })];
  const right = [track('a.flac', { title: 'a', artist: 'bc' })];
  assert.notEqual(await indexHash(left), await indexHash(right));
});

test('two tracks cannot be merged into one by a row boundary', async () => {
  const split = [track('a.flac', { title: 'x' }), track('b.flac', { title: 'y' })];
  const joined = [track('a.flac', { title: 'x' }), track('b.flac', { title: 'y' })];
  assert.equal(await indexHash(split), await indexHash(joined));
  const fewer = [track('a.flac', { title: 'x' })];
  assert.notEqual(await indexHash(split), await indexHash(fewer));
});

// -------------------------------------------------------- grouping ----

const albumTrack = (title, overrides) => validateTrack(base({
  id: title, path: `${title}.flac`, title, ...overrides,
}));

test('groupAlbums folds tracks into albums with counts and durations', () => {
  const tracks = [
    albumTrack('So What', { album: 'Kind of Blue', albumArtist: 'Miles Davis', year: 1959, durationS: 545 }),
    albumTrack('Blue in Green', { album: 'Kind of Blue', albumArtist: 'Miles Davis', year: 1959, durationS: 327 }),
    albumTrack('Solo', { album: 'Alone', albumArtist: 'Bill Evans', year: 1968, durationS: 100 }),
  ];
  const albums = groupAlbums(tracks);
  assert.equal(albums.length, 2);
  const kindOfBlue = albums.find(album => album.album === 'Kind of Blue');
  assert.equal(kindOfBlue.trackCount, 2);
  assert.equal(kindOfBlue.durationS, 872);
  assert.equal(albums[0].albumArtist, 'Bill Evans', 'albums sort by album artist');
});

test('groupArtists counts tracks and distinct albums', () => {
  const tracks = [
    albumTrack('One', { artist: 'Miles Davis', album: 'A' }),
    albumTrack('Two', { artist: 'Miles Davis', album: 'B' }),
    albumTrack('Three', { artist: 'Miles Davis', album: 'B' }),
  ];
  const [artist] = groupArtists(tracks);
  assert.equal(artist.trackCount, 3);
  assert.equal(artist.albumCount, 2);
  assert.equal(artist.albums, undefined, 'the working Set must not leak into the view row');
});

test('a track with no tags still groups under a stable unknown key', () => {
  const albums = groupAlbums([validateTrack(base())]);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].key, `unknown${'\u001f'}unknown`);
});

test('compareAlbumOrder sorts by disc, then track, then title', () => {
  const rows = [
    { discNo: 2, trackNo: 1, title: 'D2T1' },
    { discNo: 1, trackNo: 2, title: 'D1T2' },
    { discNo: 1, trackNo: 1, title: 'D1T1' },
    { discNo: null, trackNo: null, title: 'Alpha' },
  ];
  const sorted = [...rows].sort(compareAlbumOrder).map(row => row.title);
  assert.deepEqual(sorted, ['D1T1', 'D1T2', 'Alpha', 'D2T1']);
});
