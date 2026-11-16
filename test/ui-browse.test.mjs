// Library browser glue: view computation, virtual window arithmetic, keys (L6 to L8, L12).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeView, groupTracks, virtualWindow, gridLayout, arrowTarget, uniqueKeys, formatDuration, VIEWS, isGroupView,
} from '../app/ui/browse.mjs';
import { validateTrack } from '../app/library/store.mjs';

let counter = 0;
const make = overrides => {
  counter += 1;
  return validateTrack({ id: `t${counter}`, path: `x/${counter}.flac`, name: `${counter}.flac`, size: 1, ...overrides });
};

const library = [
  make({ path: 'Jazz/KoB/1.flac', title: 'So What', artist: 'Miles Davis', albumArtist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'Jazz', trackNo: 1, durationS: 545, addedAt: 100, playCount: 3, lastPlayedAt: 50, rating: 5 }),
  make({ path: 'Jazz/KoB/2.flac', title: 'Freddie Freeloader', artist: 'Miles Davis', albumArtist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'Jazz', trackNo: 2, durationS: 586, addedAt: 100, playCount: 1, lastPlayedAt: 70 }),
  make({ path: 'Jazz/Evans/1.flac', title: 'Peace Piece', artist: 'Bill Evans', album: 'Everybody Digs', year: 1958, genre: 'Jazz', trackNo: 1, durationS: 400, addedAt: 300, bookmarked: 1, rating: 3 }),
  make({ path: 'Rock/1.mp3', title: 'Paranoid', artist: 'Black Sabbath', album: 'Paranoid', year: 1970, genre: 'Rock', trackNo: 1, durationS: 170, addedAt: 200 }),
];
const [soWhat, freddie, peace, paranoid] = library;

test('every view id is known and the group views are the ones with groups', () => {
  assert.equal(VIEWS.length, 13);
  assert.ok(isGroupView('albums') && isGroupView('folders') && isGroupView('playlists'));
  assert.ok(!isGroupView('tracks') && !isGroupView('favourites'));
  assert.throws(() => computeView(library, { view: 'nope' }), /Unknown view/);
});

test('albums at the top level are group rows keyed for the selection model', () => {
  const view = computeView(library, { view: 'albums' });
  assert.equal(view.kind, 'groups');
  // Shelf order: album artist, then year, then title.
  assert.deepEqual(view.rows.map(row => row.label), ['Everybody Digs', 'Paranoid', 'Kind of Blue']);
  assert.equal(view.keys[0], `g:${view.rows[0].key}`);
  assert.equal(view.rows[2].trackCount, 2);
});

test('the search box filters group rows by label, and album rows by album artist too', () => {
  assert.deepEqual(computeView(library, { view: 'albums', query: 'kind' }).rows.map(row => row.label), ['Kind of Blue']);
  assert.deepEqual(computeView(library, { view: 'albums', query: 'miles' }).rows.map(row => row.label), ['Kind of Blue']);
  assert.deepEqual(computeView(library, { view: 'genres', query: 'rck' }).rows.map(row => row.label), ['Rock']);
});

test('drilling into a group lists its tracks in shelf order, then sort and search apply', () => {
  const albums = computeView(library, { view: 'albums' });
  const kob = albums.rows.find(row => row.label === 'Kind of Blue');
  const drilled = computeView(library, { view: 'albums', drill: { key: kob.key } });
  assert.equal(drilled.kind, 'tracks');
  assert.deepEqual(drilled.rows.map(track => track.id), [soWhat.id, freddie.id]);
  const sorted = computeView(library, { view: 'albums', drill: { key: kob.key }, sort: { key: 'durationS', direction: 'desc' } });
  assert.deepEqual(sorted.rows.map(track => track.id), [freddie.id, soWhat.id]);
  const searched = computeView(library, { view: 'albums', drill: { key: kob.key }, query: 'fred' });
  assert.deepEqual(searched.rows.map(track => track.id), [freddie.id]);
});

test('list views: songs, recently added, most played, favourites, rated', () => {
  assert.equal(computeView(library, { view: 'tracks' }).rows.length, 4);
  assert.deepEqual(computeView(library, { view: 'recentlyAdded' }).rows.map(track => track.id)[0], peace.id);
  assert.deepEqual(computeView(library, { view: 'mostPlayed' }).rows.map(track => track.id), [soWhat.id, freddie.id]);
  assert.deepEqual(computeView(library, { view: 'favourites' }).rows.map(track => track.id), [peace.id]);
  assert.deepEqual(computeView(library, { view: 'rated' }).rows.map(track => track.id), [soWhat.id, peace.id]);
  assert.deepEqual(computeView(library, { view: 'tracks', sort: { key: 'year', direction: 'asc' } }).rows.map(track => track.year), [1958, 1959, 1959, 1970]);
});

test('playlists list file playlists and smart playlists with counts, and resolve in playlist order', () => {
  const playlists = [{ name: 'Mix', path: 'Mix.m3u8', format: 'm3u8', entries: [
    { path: 'Rock/1.mp3' }, { path: 'Jazz/KoB/1.flac' }, { path: null }, { path: 'Gone.flac' }, { path: 'Rock/1.mp3' },
  ] }];
  const smartPlaylists = [{ path: 'Jazz.nakliamp-smart.json', rule: { name: 'All jazz', match: 'all', rules: [{ field: 'genre', op: 'is', value: 'jazz' }] } }];
  const top = computeView(library, { view: 'playlists', playlists, smartPlaylists });
  assert.deepEqual(top.rows.map(row => [row.label, row.kind, row.trackCount]), [['All jazz', 'smart', 3], ['Mix', 'playlist', 5]]);

  const mix = computeView(library, { view: 'playlists', drill: { key: 'p:Mix.m3u8' }, playlists, smartPlaylists });
  assert.deepEqual(mix.rows.map(track => track.id), [paranoid.id, soWhat.id, paranoid.id]);
  assert.equal(mix.missing, 2);
  assert.equal(mix.ordered, true);
  assert.deepEqual(mix.keys, [paranoid.id, soWhat.id, `${paranoid.id}#1`], 'a repeated track gets its own key');

  const smart = groupTracks(library, 'playlists', 's:Jazz.nakliamp-smart.json', { playlists, smartPlaylists });
  assert.equal(smart.tracks.length, 3);
  assert.deepEqual(groupTracks(library, 'playlists', 'p:missing', { playlists }).tracks, []);
});

test('a broken smart rule shows as an empty playlist, not an error', () => {
  const smartPlaylists = [{ path: 'Bad.nakliamp-smart.json', rule: { name: 'Bad', match: 'all', rules: [{ field: 'mood', op: 'is', value: 'x' }] } }];
  const top = computeView(library, { view: 'playlists', smartPlaylists });
  assert.equal(top.rows[0].trackCount, 0);
  assert.deepEqual(groupTracks(library, 'playlists', 's:Bad.nakliamp-smart.json', { smartPlaylists }).tracks, []);
});

test('uniqueKeys keeps first ids plain and numbers repeats', () => {
  assert.deepEqual(uniqueKeys(['a', 'b', 'a', 'a']), ['a', 'b', 'a#1', 'a#2']);
});

test('virtualWindow renders the visible rows plus overscan and no more', () => {
  const span = virtualWindow({ scrollTop: 5200, viewportHeight: 520, rowHeight: 52, count: 50_000, overscan: 8 });
  assert.equal(span.start, 92);
  assert.equal(span.end, 118);
  assert.equal(span.offset, 92 * 52);
  assert.equal(span.total, 50_000 * 52);
  assert.ok(span.end - span.start <= 10 + 16, 'about one screen of rows');

  const top = virtualWindow({ scrollTop: 0, viewportHeight: 520, rowHeight: 52, count: 3 });
  assert.deepEqual(top, { start: 0, end: 3, offset: 0, total: 156 });
  const bottom = virtualWindow({ scrollTop: 50_000 * 52, viewportHeight: 520, rowHeight: 52, count: 50_000 });
  assert.equal(bottom.end, 50_000);
  assert.deepEqual(virtualWindow({ scrollTop: 0, viewportHeight: 500, rowHeight: 52, count: 0 }), { start: 0, end: 0, offset: 0, total: 0 });
  assert.equal(virtualWindow({ scrollTop: -40, viewportHeight: 100, rowHeight: 50, count: 10, overscan: 0 }).start, 0);
});

test('gridLayout fits columns to the width and never fewer than one', () => {
  const wide = gridLayout({ width: 1000, minCell: 150, gap: 14, count: 100 });
  assert.equal(wide.columns, 6);
  assert.equal(wide.rows, 17);
  assert.equal(gridLayout({ width: 1000, count: 1 }).columns, 6, 'default cell 140 px');
  assert.equal(wide.rowHeight, wide.cellWidth + 52 + 14);
  const phone = gridLayout({ width: 300, count: 5 });
  assert.equal(phone.columns, 2);
  assert.ok(phone.cellWidth * 2 + 14 <= 304, 'two cells fit a 360 px phone (300 px of grid) without horizontal scroll');
  assert.equal(gridLayout({ width: 80, count: 3 }).columns, 1);
});

test('arrowTarget moves by one in a list and by a row in a grid, clamped', () => {
  assert.equal(arrowTarget('ArrowDown', -1, { count: 10 }), 0);
  assert.equal(arrowTarget('ArrowUp', -1, { count: 10 }), 9);
  assert.equal(arrowTarget('ArrowDown', 9, { count: 10 }), 9);
  assert.equal(arrowTarget('ArrowRight', 3, { count: 10 }), 3, 'left and right do nothing in a list');
  assert.equal(arrowTarget('ArrowDown', 1, { count: 20, columns: 4 }), 5);
  assert.equal(arrowTarget('ArrowRight', 1, { count: 20, columns: 4 }), 2);
  assert.equal(arrowTarget('ArrowUp', 2, { count: 20, columns: 4 }), 0);
  assert.equal(arrowTarget('End', 2, { count: 20 }), 19);
  assert.equal(arrowTarget('Home', 12, { count: 20 }), 0);
  assert.equal(arrowTarget('PageDown', 0, { count: 100, page: 10 }), 10);
  assert.equal(arrowTarget('ArrowDown', 0, { count: 0 }), -1);
});

test('formatDuration', () => {
  assert.equal(formatDuration(545), '9:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(null), '');
});

test('a 50,000-track library computes every view (correctness at scale, not a timing claim)', () => {
  const big = [];
  for (let n = 0; n < 50_000; n++) {
    big.push({
      id: `b${n}`, path: `A${n % 500}/${n}.flac`, name: `${n}.flac`, title: `Track ${n}`, artist: `Artist ${n % 900}`,
      album: `Album ${n % 4000}`, albumArtist: `Artist ${n % 900}`, albumKey: `k${n % 4000}`, artistKey: `a${n % 900}`,
      genre: `G${n % 30}`, year: 1950 + (n % 70), trackNo: n % 12, durationS: 200, addedAt: n, playCount: n % 5,
      lastPlayedAt: n % 7 ? n : 0, rating: n % 6, bookmarked: n % 50 === 0 ? 1 : 0,
    });
  }
  assert.equal(computeView(big, { view: 'albums' }).rows.length, 4000);
  assert.equal(computeView(big, { view: 'tracks' }).keys.length, 50_000);
  assert.equal(computeView(big, { view: 'favourites' }).rows.length, 1000);
  assert.ok(computeView(big, { view: 'tracks', query: 'track 4999' }).rows.length > 0);
});
