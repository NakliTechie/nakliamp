// Review 2026-11-17, playlist findings N2, N10, N11, N12, N32 and N33 (app/library/playlist.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaylist, toM3u8, mergeEntry, appendToPlaylist, decodePlaylistBytes, encodePlaylistText,
  assertPlaylistUnchanged, pickEntryPath, PlaylistFormatError,
} from '../app/library/playlist.mjs';

/** Parse, edit with `edit(entries)`, write, parse again: the shell's rewrite path. */
function roundTrip(text, path, edit = (entries) => entries) {
  const playlist = parsePlaylist(text, path);
  const base = path.split('/').slice(0, -1).join('/');
  const written = toM3u8(edit(playlist.entries).map((entry) => mergeEntry(entry)), {
    name: playlist.name, base, header: playlist.header, trailer: playlist.trailer,
  });
  return { written, again: parsePlaylist(written, path) };
}

test('N2: a track whose relative path starts with # is written as ./# and survives parse, edit, write, parse', () => {
  const tracks = [
    { path: '#9 Dream.mp3', title: 'Dream', durationS: 200 },
    { path: '#1 Hits/song.mp3', title: 'Song', durationS: 100 },
    { path: 'plain.mp3', title: 'Plain', durationS: 50 },
  ];
  const text = toM3u8(tracks, { name: 'Mix' });
  assert.ok(text.includes('\n./#9 Dream.mp3\n') && text.includes('\n./#1 Hits/song.mp3\n'));
  const parsed = parsePlaylist(text, 'mix.m3u8');
  assert.deepEqual(parsed.entries.map((entry) => entry.path), ['#9 Dream.mp3', '#1 Hits/song.mp3', 'plain.mp3']);
  const { again } = roundTrip(text, 'mix.m3u8', (entries) => [entries[2], entries[0], entries[1]]);
  assert.deepEqual(again.entries.map((entry) => entry.path), ['plain.mp3', '#9 Dream.mp3', '#1 Hits/song.mp3']);
  assert.deepEqual(again.entries.map((entry) => entry.target), ['plain.mp3', './#9 Dream.mp3', './#1 Hits/song.mp3']);
});

test('N2: appendToPlaylist adds a # track so it reads back', () => {
  const playlist = parsePlaylist('#EXTM3U\na.mp3\n', 'Lists/x.m3u8');
  const { text } = appendToPlaylist(playlist, [{ path: 'Lists/#2.mp3' }]);
  assert.deepEqual(parsePlaylist(text, 'Lists/x.m3u8').entries.map((entry) => entry.path), ['Lists/a.mp3', 'Lists/#2.mp3']);
});

test('N10: a Windows-1252 .m3u decodes exactly, and text with U+FFFD is never written back', () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('#EXTM3U\nBeyonc'), 0xe9, ...new TextEncoder().encode('/Halo.mp3\n')]);
  assert.deepEqual(decodePlaylistBytes(bytes), { text: '#EXTM3U\nBeyoncé/Halo.mp3\n', encoding: 'windows-1252' });
  const parsed = parsePlaylist(bytes, 'old.m3u');
  assert.equal(parsed.encoding, 'windows-1252');
  assert.equal(parsed.entries[0].path, 'Beyoncé/Halo.mp3');
  // The text a UTF-8-only read produces: the shell must not write it back.
  const damaged = parsePlaylist(new TextDecoder().decode(bytes), 'old.m3u');
  assert.throws(() => toM3u8(damaged.entries.map((entry) => mergeEntry(entry))), PlaylistFormatError);
  const out = encodePlaylistText(toM3u8(parsed.entries.map((entry) => mergeEntry(entry))), 'windows-1252');
  assert.ok(out.includes(0xe9), 'written back in its own code page');
  assert.throws(() => encodePlaylistText('日', 'windows-1252'), PlaylistFormatError);
  assert.equal(decodePlaylistBytes(new TextEncoder().encode('﻿Café.mp3')).text, 'Café.mp3');
});

test('N11: a rewrite is refused when the file changed on disk since the scan', async () => {
  const cached = parsePlaylist('#EXTM3U\na.mp3\nb.mp3\n', 'mix.m3u8', { lastModified: 10, size: 20 });
  await assertPlaylistUnchanged(cached, '#EXTM3U\na.mp3\nb.mp3\n');
  await assert.rejects(assertPlaylistUnchanged(cached, '#EXTM3U\na.mp3\nb.mp3\nc.mp3\n'), (error) => error.code === 'ERR_NAKLIAMP_PLAYLIST_CHANGED');
  const newer = new File(['#EXTM3U\na.mp3\nb.mp3\n'], 'mix.m3u8', { lastModified: 11 });
  await assert.rejects(assertPlaylistUnchanged(cached, newer), (error) => error.code === 'ERR_NAKLIAMP_PLAYLIST_CHANGED');
  const same = new File(['#EXTM3U\na.mp3\nb.mp3\n'], 'mix.m3u8', { lastModified: 10 });
  const sized = { ...cached, size: same.size };
  await assertPlaylistUnchanged(sized, same);
});

test('N12: comments, directives and EXTINF attributes survive a rewrite', () => {
  const text = [
    '#EXTM3U',
    '#PLAYLIST:Road',
    '#EXTALB:Road Trip',
    '# my notes',
    '#EXTINF:10 tvg-name="a,b",Artist - Song',
    '#EXTVLCOPT:start-time=5',
    'song.mp3',
    '#EXTGRP:Group',
    '#EXTINF:20,Other',
    'other.mp3',
    '# end note',
    '',
  ].join('\n');
  const parsed = parsePlaylist(text, 'road.m3u8');
  assert.equal(parsed.entries[0].title, 'Song');
  assert.equal(parsed.entries[0].artist, 'Artist');
  const { written } = roundTrip(text, 'road.m3u8');
  assert.equal(written, text, 'byte for byte');
  const { written: moved } = roundTrip(text, 'road.m3u8', (entries) => [entries[1], entries[0]]);
  assert.equal(moved, [
    '#EXTM3U', '#PLAYLIST:Road', '#EXTALB:Road Trip', '# my notes',
    '#EXTGRP:Group', '#EXTINF:20,Other', 'other.mp3',
    '#EXTINF:10 tvg-name="a,b",Artist - Song', '#EXTVLCOPT:start-time=5', 'song.mp3',
    '# end note', '',
  ].join('\n'), 'each entry takes its own lines when it moves');
});

test('N32: a newline in a title or playlist name cannot add an entry or rename the playlist', () => {
  const text = toM3u8([{ path: 'a.mp3', title: 'Evil\nb.mp3\n#PLAYLIST:pwned' }], { name: 'Mine\n#PLAYLIST:other' });
  const parsed = parsePlaylist(text, 'x.m3u8');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.name, 'Mine #PLAYLIST:other');
  assert.equal(parsed.entries[0].title, 'Evil b.mp3 #PLAYLIST:pwned');
  assert.throws(() => toM3u8([{ path: 'a\nb.mp3' }]), PlaylistFormatError);
});

test('N33: a file literally named Track%20One.mp3 is found; the decoded reading is the fallback', () => {
  const parsed = parsePlaylist('#EXTM3U\nTrack%20One.mp3\n', 'x.m3u8');
  const entry = parsed.entries[0];
  assert.deepEqual(entry.candidates, ['Track%20One.mp3', 'Track One.mp3']);
  assert.equal(pickEntryPath(entry, (path) => path === 'Track%20One.mp3'), 'Track%20One.mp3');
  assert.equal(pickEntryPath(entry, (path) => path === 'Track One.mp3'), 'Track One.mp3');
  const { text } = appendToPlaylist(parsed, [], { lookup: (path) => (path === 'Track%20One.mp3' ? { durationS: 61, title: 'Literal' } : null) });
  assert.ok(text.includes('#EXTINF:61,Literal'), 'the literal file filled the EXTINF');
});
