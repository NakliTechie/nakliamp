// Playlist reading and writing. Run: node --test test/playlist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, resolveEntry, toM3u8, isPlaylistPath } from '../app/library/playlist.mjs';

// ------------------------------------------------------- resolution ----

test('relative entries resolve against the playlist directory', () => {
  assert.equal(resolveEntry('Jazz', '01 So What.flac'), 'Jazz/01 So What.flac');
  assert.equal(resolveEntry('Jazz/Kind of Blue', '../Alone/01.flac'), 'Jazz/Alone/01.flac');
  assert.equal(resolveEntry('', 'track.mp3'), 'track.mp3');
  assert.equal(resolveEntry('a/b', './c.mp3'), 'a/b/c.mp3');
});

test('an entry cannot climb above the granted folder', () => {
  assert.equal(resolveEntry('Jazz', '../../etc/passwd'), null);
  assert.equal(resolveEntry('', '../secret.mp3'), null);
  assert.equal(resolveEntry('a', '../../../b.mp3'), null);
});

test('an absolute path is reinterpreted from the granted root, never the disk', () => {
  assert.equal(resolveEntry('Jazz', '/Music/track.mp3'), 'Music/track.mp3');
});

test('a remote target is recorded as unresolvable rather than fetched', () => {
  assert.equal(resolveEntry('', 'https://example.com/stream.mp3'), null);
  assert.equal(resolveEntry('', 'http://radio.example/live'), null);
});

test('percent-encoding and backslashes are handled', () => {
  assert.equal(resolveEntry('', 'Kind%20of%20Blue/01.flac'), 'Kind of Blue/01.flac');
  assert.equal(resolveEntry('', 'Jazz\\Album\\01.flac'), 'Jazz/Album/01.flac');
  assert.equal(resolveEntry('', 'file:///Music/01.flac'), 'Music/01.flac');
});

test('isPlaylistPath recognises the formats read and nothing else', () => {
  for (const good of ['a.m3u', 'a.M3U8', 'x/y.pls', 'z.xspf', 'z.jspf']) {
    assert.ok(isPlaylistPath(good), `${good} was not recognised`);
  }
  for (const bad of ['a.mp3', 'a.flac', 'a.m3u.txt', 'a', '']) {
    assert.ok(!isPlaylistPath(bad), `${bad} was wrongly recognised`);
  }
});

// -------------------------------------------------------------- M3U ----

test('M3U8 with EXTINF yields paths, durations, artist and title', () => {
  const playlist = parsePlaylist([
    '#EXTM3U',
    '#PLAYLIST:Evening',
    '#EXTINF:545,Miles Davis - So What',
    'Kind of Blue/01 So What.flac',
    '#EXTINF:-1,Untitled',
    'Kind of Blue/02.flac',
    '',
    '# a stray comment',
  ].join('\n'), 'Jazz/evening.m3u8');

  assert.equal(playlist.name, 'Evening');
  assert.equal(playlist.format, 'm3u8');
  assert.equal(playlist.entries.length, 2);
  assert.equal(playlist.entries[0].path, 'Jazz/Kind of Blue/01 So What.flac');
  assert.equal(playlist.entries[0].durationS, 545);
  assert.equal(playlist.entries[0].artist, 'Miles Davis');
  assert.equal(playlist.entries[0].title, 'So What');
  assert.equal(playlist.entries[1].durationS, null, 'a -1 duration means unknown');
  assert.equal(playlist.entries[1].title, 'Untitled');
  assert.equal(playlist.unresolved, 0);
});

test('a bare M3U with no directives still yields entries', () => {
  const playlist = parsePlaylist('one.mp3\ntwo.mp3\n', 'mix.m3u');
  assert.deepEqual(playlist.entries.map(entry => entry.path), ['one.mp3', 'two.mp3']);
  assert.equal(playlist.name, 'mix', 'the file name is the fallback playlist name');
});

test('CRLF line endings parse the same as LF', () => {
  const playlist = parsePlaylist('#EXTM3U\r\n#EXTINF:10,A - B\r\none.mp3\r\n', 'x.m3u');
  assert.equal(playlist.entries.length, 1);
  assert.equal(playlist.entries[0].artist, 'A');
});

test('a remote entry is kept and counted, not silently dropped', () => {
  const playlist = parsePlaylist('#EXTM3U\nhttps://radio.example/live\nlocal.mp3\n', 'x.m3u');
  assert.equal(playlist.entries.length, 2);
  assert.equal(playlist.entries[0].path, null);
  assert.equal(playlist.entries[0].target, 'https://radio.example/live');
  assert.equal(playlist.unresolved, 1);
});

// -------------------------------------------------------------- PLS ----

test('PLS entries are ordered by index, not file order', () => {
  const playlist = parsePlaylist([
    '[playlist]',
    'NumberOfEntries=2',
    'File2=b.mp3',
    'Title2=Second',
    'Length2=20',
    'File1=a.mp3',
    'Title1=First',
    'Length1=10',
    'PlaylistName=Mine',
  ].join('\n'), 'lists/x.pls');

  assert.equal(playlist.name, 'Mine');
  assert.deepEqual(playlist.entries.map(entry => entry.title), ['First', 'Second']);
  assert.deepEqual(playlist.entries.map(entry => entry.path), ['lists/a.mp3', 'lists/b.mp3']);
  assert.equal(playlist.entries[0].durationS, 10);
});

test('a PLS is detected by its header even with the wrong extension', () => {
  const playlist = parsePlaylist('[playlist]\nFile1=a.mp3\n', 'wrong.m3u');
  assert.equal(playlist.entries.length, 1);
  assert.equal(playlist.entries[0].path, 'a.mp3');
});

// ------------------------------------------------------------- XSPF ----

test('XSPF yields locations, titles and millisecond durations', () => {
  const playlist = parsePlaylist(`<?xml version="1.0"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <title>Road Trip</title>
  <trackList>
    <track>
      <location>Rock/01%20Song.mp3</location>
      <title>Song &amp; Dance</title>
      <creator>The Band</creator>
      <duration>245000</duration>
    </track>
    <track><location>Rock/02.mp3</location></track>
  </trackList>
</playlist>`, 'lists/trip.xspf');

  assert.equal(playlist.name, 'Road Trip');
  assert.equal(playlist.entries.length, 2);
  assert.equal(playlist.entries[0].path, 'lists/Rock/01 Song.mp3');
  assert.equal(playlist.entries[0].title, 'Song & Dance', 'XML entities must be decoded');
  assert.equal(playlist.entries[0].artist, 'The Band');
  assert.equal(playlist.entries[0].durationS, 245);
  assert.equal(playlist.entries[1].durationS, null);
});

// ------------------------------------------------------------- JSPF ----

test('JSPF yields the same shape as XSPF', () => {
  const playlist = parsePlaylist(JSON.stringify({
    playlist: {
      title: 'From JSON',
      track: [
        { location: ['Pop/01.mp3'], title: 'One', creator: 'Someone', duration: 180000 },
        { location: 'Pop/02.mp3' },
        { title: 'No location at all' },
      ],
    },
  }), 'lists/x.jspf');

  assert.equal(playlist.name, 'From JSON');
  assert.equal(playlist.entries.length, 2, 'an entry with no location is not an entry');
  assert.equal(playlist.entries[0].path, 'lists/Pop/01.mp3');
  assert.equal(playlist.entries[0].durationS, 180);
});

// ------------------------------------------------------- robustness ----

test('malformed input yields an empty playlist rather than throwing', () => {
  for (const [text, path] of [
    ['', 'x.m3u'], ['{not json', 'x.jspf'], ['<playlist', 'x.xspf'],
    ['[playlist]', 'x.pls'], [null, 'x.m3u'],
  ]) {
    const playlist = parsePlaylist(text, path);
    assert.ok(Array.isArray(playlist.entries), `${path} did not return entries`);
  }
});

// -------------------------------------------------------- writing ----

const track = fields => ({ path: null, title: null, artist: null, name: null, durationS: null, ...fields });

test('M3U8 export writes EXTINF and paths relative to the base', () => {
  const text = toM3u8([
    track({ path: 'Jazz/Kind of Blue/01.flac', title: 'So What', artist: 'Miles Davis', durationS: 545.4 }),
    track({ path: 'Jazz/Alone/02.flac', name: '02.flac' }),
  ], { name: 'Evening', base: 'Jazz' });

  assert.equal(text, [
    '#EXTM3U',
    '#PLAYLIST:Evening',
    '#EXTINF:545,Miles Davis - So What',
    'Kind of Blue/01.flac',
    '#EXTINF:-1,02.flac',
    'Alone/02.flac',
    '',
  ].join('\n'));
});

test('export then re-import round-trips paths exactly', () => {
  const tracks = [
    track({ path: 'a/one.mp3', title: 'One', artist: 'X', durationS: 10 }),
    track({ path: 'a/b/two.mp3', title: 'Two', durationS: 20 }),
  ];
  const text = toM3u8(tracks, { base: 'a' });
  const reimported = parsePlaylist(text, 'a/list.m3u8');
  assert.deepEqual(reimported.entries.map(entry => entry.path), tracks.map(entry => entry.path));
  assert.deepEqual(reimported.entries.map(entry => entry.durationS), [10, 20]);
});

test('export is byte-stable for the same input', () => {
  const tracks = [track({ path: 'a.mp3', title: 'A', durationS: 1 })];
  assert.equal(toM3u8(tracks, { name: 'N' }), toM3u8(tracks, { name: 'N' }));
});
