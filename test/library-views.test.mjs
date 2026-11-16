// Browse views and sorting, plus the 50,000-track scale check (L12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { browse, sortTracks, folderOf, BROWSE_VIEWS, SORT_KEYS, BrowseError } from '../app/library/views.mjs';
import { validateTrack } from '../app/library/store.mjs';
import { searchTracks } from '../app/library/search.mjs';

let counter = 0;
const make = overrides => {
  counter += 1;
  return validateTrack({ id: `t${counter}`, path: `x/${counter}.flac`, name: `${counter}.flac`, size: 1, ...overrides });
};

const library = [
  make({ path: 'Jazz/KoB/1.flac', title: 'So What', artist: 'Miles Davis', albumArtist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'Jazz', trackNo: 1, durationS: 545, addedAt: 100, playCount: 3, lastPlayedAt: 50, rating: 5 }),
  make({ path: 'Jazz/KoB/2.flac', title: 'Freddie Freeloader', artist: 'Miles Davis', albumArtist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'jazz', trackNo: 2, durationS: 586, addedAt: 100, playCount: 1, lastPlayedAt: 70 }),
  make({ path: 'Jazz/Evans/1.flac', title: 'Peace Piece', artist: 'Bill Evans', album: 'Everybody Digs', year: 1958, genre: 'Jazz', trackNo: 1, durationS: 400, addedAt: 300, bookmarked: 1, rating: 3 }),
  make({ path: 'loose.mp3', title: 'Untagged', addedAt: 200 }),
];

test('albums group with counts, durations and shelf order', () => {
  const albums = browse(library, { by: 'albums' });
  assert.equal(albums.length, 3);
  const kob = albums.find(album => album.label === 'Kind of Blue');
  assert.equal(kob.trackCount, 2);
  assert.equal(kob.durationS, 1131);
  assert.equal(kob.albumArtist, 'Miles Davis');
  assert.equal(kob.year, 1959);
  const tracks = browse(library, { by: 'albums', key: kob.key });
  assert.deepEqual(tracks.map(track => track.title), ['So What', 'Freddie Freeloader']);
});

test('genres fold case; unknown sorts last with a null label', () => {
  const genres = browse(library, { by: 'genres' });
  assert.equal(genres[0].label, 'Jazz');
  assert.equal(genres[0].trackCount, 3);
  assert.equal(genres.at(-1).label, null);
});

test('artists, album artists, years and folders', () => {
  const artists = browse(library, { by: 'artists' });
  assert.deepEqual(artists.map(row => row.label), ['Bill Evans', 'Miles Davis', null]);
  assert.equal(artists[1].albumCount, 1);
  const albumArtists = browse(library, { by: 'albumArtists' });
  assert.ok(albumArtists.some(row => row.label === 'Bill Evans'), 'falls back to the track artist');
  const years = browse(library, { by: 'years' });
  assert.deepEqual(years.map(row => row.key), ['1959', '1958', 'unknown']);
  const folders = browse(library, { by: 'folders' });
  assert.deepEqual(folders.map(row => row.key).sort(), ['', 'Jazz/Evans', 'Jazz/KoB']);
  assert.deepEqual(browse(library, { by: 'folders', key: '' }).map(t => t.title), ['Untagged']);
  assert.equal(folderOf('a/b/c.mp3'), 'a/b');
});

test('list views: recently added, recently played, most played, favourites, rated', () => {
  assert.deepEqual(browse(library, { by: 'recentlyAdded' }).map(t => t.title)[0], 'Peace Piece');
  assert.deepEqual(browse(library, { by: 'recentlyPlayed' }).map(t => t.title), ['Freddie Freeloader', 'So What']);
  assert.deepEqual(browse(library, { by: 'mostPlayed' }).map(t => t.title), ['So What', 'Freddie Freeloader']);
  assert.deepEqual(browse(library, { by: 'favourites' }).map(t => t.title), ['Peace Piece']);
  assert.deepEqual(browse(library, { by: 'rated' }).map(t => t.title), ['So What', 'Peace Piece']);
  assert.equal(browse(library, { by: 'recentlyAdded', limit: 2 }).length, 2);
});

test('browse refuses unknown views and bad limits by name', () => {
  assert.throws(() => browse(library, { by: 'moods' }), BrowseError);
  assert.throws(() => browse(library, { by: 'albums', limit: 0 }), /limit/);
  assert.equal(BROWSE_VIEWS.length, 11);
});

test('sortTracks: every key, both directions, missing values last', () => {
  for (const key of SORT_KEYS) {
    for (const direction of ['asc', 'desc']) assert.equal(sortTracks(library, key, direction).length, library.length);
  }
  assert.deepEqual(sortTracks(library, 'year', 'asc').map(t => t.year), [1958, 1959, 1959, null]);
  assert.deepEqual(sortTracks(library, 'year', 'desc').map(t => t.year), [1959, 1959, 1958, null]);
  assert.equal(sortTracks(library, 'artist', 'asc').at(-1).title, 'Untagged');
  assert.equal(sortTracks(library, 'title', 'desc')[0].title, 'Untagged');
  assert.deepEqual(sortTracks(library, 'durationS').map(t => t.durationS), [400, 545, 586, null]);
  assert.throws(() => sortTracks(library, 'mood'), BrowseError);
  assert.throws(() => sortTracks(library, 'title', 'up'), BrowseError);
  assert.notEqual(sortTracks(library, 'title'), library, 'returns a copy');
});

test('50,000 tracks: albums, artists, genres and a search stay inside a generous bound', () => {
  const genres = ['Jazz', 'Rock', 'Pop', 'Classical', 'Electronic', 'Folk', 'Hip Hop', 'Ambient'];
  const tracks = [];
  for (let i = 0; i < 50_000; i += 1) {
    const artist = `Artist ${Math.floor(i / 10) % 2000}`;
    const album = `Album ${Math.floor(i / 10)}`;
    tracks.push(validateTrack({
      id: `id${i}`, path: `${artist}/${album}/${i} Track ${i}.flac`, name: `${i} Track ${i}.flac`, size: 1000 + i,
      title: `Track ${i} ${['blue', 'red', 'night', 'sakura', 'river'][i % 5]}`, artist, albumArtist: artist, album,
      genre: genres[i % genres.length], year: 1950 + (i % 70), trackNo: (i % 10) + 1, durationS: 180 + (i % 120),
      addedAt: i, playCount: i % 7, lastPlayedAt: i % 3 ? i : 0,
    }));
  }
  const timings = {};
  const time = (name, fn) => { const start = performance.now(); const result = fn(); timings[name] = performance.now() - start; return result; };
  const albums = time('albums', () => browse(tracks, { by: 'albums' }));
  const artists = time('artists', () => browse(tracks, { by: 'artists' }));
  const genreRows = time('genres', () => browse(tracks, { by: 'genres' }));
  const found = time('search', () => searchTracks(tracks, 'sakura'));
  time('sortTitle', () => sortTracks(tracks, 'title'));
  assert.equal(albums.length, 5000);
  assert.equal(artists.length, 2000);
  assert.equal(genreRows.length, 8);
  assert.equal(found.length, 10_000);
  const total = timings.albums + timings.artists + timings.genres + timings.search;
  // Observed on a shared machine; a correctness bound, not a timing claim.
  console.log(`# scale-50k observed ms: ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])))} total(browse+search)=${Math.round(total)}`);
  assert.ok(total < 2000, `browse and search took ${Math.round(total)} ms`);
});
