// Regression tests for the UI defects seen while capturing the promo videos
// (2026-11-17). The layout defects are checked in the browser by
// test/promo-fixes.html; these are the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackNumber, trackNumberLabel, compareAlbumOrder } from '../app/library/store.mjs';
import { sortTracks } from '../app/library/views.mjs';
import { networkRows, sendsText, hostOf } from '../app/ui/v1x-network.mjs';
import { KNOWN_ORIGINS } from '../app/net/consent.mjs';

test('defect 2: a track tag of 0 means no track number', () => {
  assert.equal(trackNumber(0), null);
  assert.equal(trackNumber('0'), null);
  assert.equal(trackNumber(null), null);
  assert.equal(trackNumber(undefined), null);
  assert.equal(trackNumber(-3), null);
  assert.equal(trackNumber(7), 7);
  assert.equal(trackNumberLabel(0), '');
  assert.equal(trackNumberLabel(null), '');
  assert.equal(trackNumberLabel(12), '12');
});

test('defect 2: tracks tagged 0 sort after the numbered tracks, by title', () => {
  const rows = [
    { title: 'Zulu', trackNo: 0 },
    { title: 'Two', trackNo: 2 },
    { title: 'Alpha', trackNo: 0 },
    { title: 'One', trackNo: 1 },
    { title: 'Bravo', trackNo: null },
  ];
  assert.deepEqual([...rows].sort(compareAlbumOrder).map(row => row.title), ['One', 'Two', 'Alpha', 'Bravo', 'Zulu']);
});

test('defect 2: an album where every track is tagged 0 keeps title order in the shelf sort', () => {
  const tracks = ['Cherokee', 'Autumn Leaves', 'Blue Monk'].map((title, i) => ({
    id: i + 1, title, trackNo: 0, album: 'Jazz Sampler', albumArtist: 'Various', albumKey: 'jazz',
  }));
  const sorted = sortTracks(tracks, 'album', 'asc').map(track => track.title);
  assert.deepEqual(sorted, ['Autumn Leaves', 'Blue Monk', 'Cherokee']);
});

test('Network panel: each switch says what turning it on sends, and to which host', () => {
  const rows = networkRows(KNOWN_ORIGINS);
  assert.equal(rows.length, KNOWN_ORIGINS.length);
  for (const row of rows) {
    const text = sendsText(row);
    const host = hostOf(row.origin);
    assert.ok(host && !host.includes('/'), `host of ${row.origin} is ${host}`);
    assert.ok(text.startsWith(`Turning this on sends ${host} `), `${row.label}: ${text}`);
    assert.ok(text.length > `Turning this on sends ${host} `.length + 10, `${row.label} names nothing it sends: ${text}`);
  }
  const lrclib = rows.find(row => row.label === 'LRCLIB');
  assert.equal(sendsText(lrclib), 'Turning this on sends lrclib.net the track title, artist, album and length in seconds.');
  const caa = rows.find(row => row.label === 'Cover Art Archive');
  assert.match(sendsText(caa), /Also contacts archive\.org and \*\.archive\.org\.$/);
});
