// Add to playlist (Y2): append tracks, keep every existing entry verbatim.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePlaylist, appendToPlaylist, mergeEntry, playlistBase, PlaylistFormatError } from '../app/library/playlist.mjs';

const source = [
  '#EXTM3U',
  '#PLAYLIST:Mix',
  '#EXTINF:200,Miles Davis - So What',
  '../Jazz/so-what.flac',
  'http://radio.example/stream',
  '../../outside.mp3',
  'not-scanned-yet.flac',
  '',
].join('\n');

test('appending keeps unresolved entries verbatim and adds relative paths', () => {
  const playlist = parsePlaylist(source, 'Playlists/mix.m3u8');
  assert.equal(playlist.unresolved, 2);
  const { entries, text } = appendToPlaylist(playlist, [
    { path: 'Rock/song.mp3', title: 'Song', artist: 'Band', durationS: 181.4 },
    { path: 'Playlists/local.mp3', title: 'Local' },
  ]);
  assert.equal(entries.length, 6);
  assert.deepEqual(text.split('\n'), [
    '#EXTM3U',
    '#PLAYLIST:Mix',
    '#EXTINF:200,Miles Davis - So What',
    '../Jazz/so-what.flac',
    '#EXTINF:-1,',
    'http://radio.example/stream',
    '#EXTINF:-1,',
    '../../outside.mp3',
    '#EXTINF:-1,',
    'not-scanned-yet.flac',
    '#EXTINF:181,Band - Song',
    '../Rock/song.mp3',
    '#EXTINF:-1,Local',
    'local.mp3',
    '',
  ]);
  // Re-reading the written text resolves the new entries to the same paths.
  const reread = parsePlaylist(text, 'Playlists/mix.m3u8');
  assert.equal(reread.entries.at(-2).path, 'Rock/song.mp3');
  assert.equal(reread.entries.at(-1).path, 'Playlists/local.mp3');
  assert.equal(reread.entries[1].target, 'http://radio.example/stream');
});

test('lookup fills missing EXTINF metadata from the index; entry tags win', () => {
  const playlist = parsePlaylist('#EXTM3U\na.flac\n#EXTINF:10,Own - Title\nb.flac\n', 'p.m3u');
  const index = { 'a.flac': { durationS: 99, artist: 'Indexed', title: 'A' }, 'b.flac': { durationS: 5, artist: 'X', title: 'Y' } };
  const { text } = appendToPlaylist(playlist, [], { lookup: path => index[path] ?? null });
  assert.match(text, /#EXTINF:99,Indexed - A\na\.flac/);
  assert.match(text, /#EXTINF:10,Own - Title\nb\.flac/);
});

test('PLS, XSPF and JSPF are refused by name rather than overwritten as M3U8', () => {
  const pls = parsePlaylist('[playlist]\nFile1=a.mp3\n', 'old.pls');
  assert.throws(() => appendToPlaylist(pls, [{ path: 'b.mp3' }]), error => error instanceof PlaylistFormatError && /PLS/.test(error.message));
  assert.throws(() => appendToPlaylist(null, []), PlaylistFormatError);
});

test('tracks without a path are skipped; helpers behave', () => {
  const playlist = parsePlaylist('#EXTM3U\n', 'root.m3u8');
  assert.equal(appendToPlaylist(playlist, [null, {}, { path: '' }, { path: 'x.mp3', name: 'x.mp3' }]).entries.length, 1);
  assert.equal(playlistBase('a/b/c.m3u8'), 'a/b');
  assert.equal(playlistBase('c.m3u8'), '');
  assert.deepEqual(mergeEntry({ target: 't', path: null }, null), { target: 't', path: null, durationS: null, artist: null, title: null });
});
