// Playlist reading and writing. Run: node --test test/playlist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, resolveEntry, toM3u8, isPlaylistPath, safePlaylistFileName } from '../app/library/playlist.mjs';

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


// ------------------------------------------ manager round-trip ----
// The manager edits a playlist by rewriting the file. These assert the edit
// operations preserve exactly what they should and nothing else.

test('reordering rewrites order and nothing else', () => {
  const tracks = [
    track({ path: 'a/1.mp3', title: 'One', durationS: 10 }),
    track({ path: 'a/2.mp3', title: 'Two', durationS: 20 }),
    track({ path: 'a/3.mp3', title: 'Three', durationS: 30 }),
  ];
  const moved = [tracks[1], tracks[0], tracks[2]];
  const before = parsePlaylist(toM3u8(tracks, { name: 'L', base: 'a' }), 'a/L.m3u8');
  const after = parsePlaylist(toM3u8(moved, { name: 'L', base: 'a' }), 'a/L.m3u8');

  assert.deepEqual(after.entries.map(entry => entry.path), ['a/2.mp3', 'a/1.mp3', 'a/3.mp3']);
  assert.equal(after.entries.length, before.entries.length);
  assert.deepEqual(
    [...after.entries].map(entry => entry.path).sort(),
    [...before.entries].map(entry => entry.path).sort(),
    'reordering must not add or lose a track',
  );
});

test('removing a track drops exactly one entry', () => {
  const tracks = [
    track({ path: 'a/1.mp3', title: 'One' }),
    track({ path: 'a/2.mp3', title: 'Two' }),
    track({ path: 'a/3.mp3', title: 'Three' }),
  ];
  const kept = tracks.filter((_, index) => index !== 1);
  const after = parsePlaylist(toM3u8(kept, { name: 'L', base: 'a' }), 'a/L.m3u8');
  assert.deepEqual(after.entries.map(entry => entry.path), ['a/1.mp3', 'a/3.mp3']);
});

test('a rewritten playlist survives repeated round-trips unchanged', () => {
  const tracks = [
    track({ path: 'a/b/1.mp3', title: 'One', artist: 'X', durationS: 10 }),
    track({ path: 'a/2.mp3', title: 'Two', durationS: 20 }),
  ];
  let text = toM3u8(tracks, { name: 'Stable', base: 'a' });
  for (let round = 0; round < 3; round += 1) {
    const parsed = parsePlaylist(text, 'a/Stable.m3u8');
    const rebuilt = parsed.entries.map(entry => track({
      path: entry.path, title: entry.title, artist: entry.artist, durationS: entry.durationS,
    }));
    const next = toM3u8(rebuilt, { name: 'Stable', base: 'a' });
    assert.equal(next, text, `round ${round} changed the file`);
    text = next;
  }
});

test('a playlist name is made safe without erasing the alphabet it is in', () => {
  // The old `[^\w \-.]` sanitiser was ASCII-only, so every non-Latin name
  // collapsed to the same run of underscores and they overwrote each other.
  for (const name of ['Café', '日本のミックス', 'Кайф', 'Ελληνικά']) {
    assert.equal(safePlaylistFileName(name), name, `${name} was mangled`);
  }
  for (const [name, expected] of [
    ['My/List: 2024 <best>', 'My_List_ 2024 _best_'],
    ['..', 'playlist'], ['.', 'playlist'], ['.hidden', 'hidden'],
    ['   ', 'playlist'], ['', 'playlist'], ['trailing.', 'trailing'],
  ]) {
    assert.equal(safePlaylistFileName(name), expected, `${JSON.stringify(name)} sanitised wrongly`);
  }
  for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    const safe = safePlaylistFileName(name);
    assert.ok(!/[\\/:*?"<>|]/.test(safe), `${name} left a path or reserved character in ${safe}`);
  }
});

test('a track outside the playlist directory is written so it reads back', () => {
  // `Rock/song.mp3` written unchanged into `Playlists/mix.m3u8` re-read as
  // `Playlists/Rock/song.mp3`. Every track outside the playlist's own folder
  // was lost on the next read, which is what made a rewrite destructive.
  const tracks = [
    track({ path: 'Rock/song.mp3', title: 'Out' }),
    track({ path: 'Playlists/near.mp3', title: 'In' }),
    track({ path: 'Playlists/deep/further.mp3', title: 'Deeper' }),
    track({ path: 'top.mp3', title: 'Root' }),
  ];
  const text = toM3u8(tracks, { name: 'Mix', base: 'Playlists' });
  assert.ok(text.includes('../Rock/song.mp3'), `no climb was emitted:\n${text}`);
  const parsed = parsePlaylist(text, 'Playlists/Mix.m3u8');
  assert.deepEqual(
    parsed.entries.map(entry => entry.path),
    ['Rock/song.mp3', 'Playlists/near.mp3', 'Playlists/deep/further.mp3', 'top.mp3'],
  );
  assert.equal(parsed.unresolved, 0);
});

test('an entry the folder cannot resolve is written back verbatim', () => {
  // The write path used to keep only the entries that matched the index, so
  // every edit deleted the rest from the user's file.
  const source = [
    '#EXTM3U',
    '#PLAYLIST:Mix',
    '#EXTINF:-1,Radio Paradise',
    'https://stream.radioparadise.com/aac-320',
    '#EXTINF:120,Local - Known',
    'known.mp3',
    '#EXTINF:-1,Not scanned yet',
    'unscanned.flac',
    '#EXTINF:-1,Outside',
    '../../elsewhere.mp3',
    '',
  ].join('\n');
  const before = parsePlaylist(source, 'Playlists/Mix.m3u8');
  assert.equal(before.entries.length, 4);
  assert.equal(before.unresolved, 2, 'the remote stream and the climb must not resolve');

  const rewritten = toM3u8(before.entries, { name: 'Mix', base: 'Playlists' });
  assert.equal(rewritten, source, 'a no-op rewrite changed the file');
});

test('a reorder, a removal and a rename all keep every entry', () => {
  const source = [
    '#EXTM3U', '#PLAYLIST:Mix',
    '#EXTINF:-1,Radio Paradise', 'https://stream.radioparadise.com/aac-320',
    '#EXTINF:120,Local - One', 'one.mp3',
    '#EXTINF:-1,Not scanned yet', 'unscanned.flac',
    '#EXTINF:200,Local - Two', '../Rock/two.mp3',
    '',
  ].join('\n');
  const before = parsePlaylist(source, 'Playlists/Mix.m3u8');
  const targets = before.entries.map(entry => entry.target);

  // Reorder: swap the two entries the index can play, entries 1 and 3.
  const reordered = [...before.entries];
  [reordered[1], reordered[3]] = [reordered[3], reordered[1]];
  const afterMove = parsePlaylist(toM3u8(reordered, { name: 'Mix', base: 'Playlists' }), 'Playlists/Mix.m3u8');
  assert.deepEqual(afterMove.entries.map(entry => entry.target), [targets[0], targets[3], targets[2], targets[1]]);
  assert.equal(afterMove.unresolved, 1, 'the remote stream was dropped by a reorder');

  // Removal: exactly one entry goes.
  const removed = before.entries.filter((_, index) => index !== 1);
  const afterRemove = parsePlaylist(toM3u8(removed, { name: 'Mix', base: 'Playlists' }), 'Playlists/Mix.m3u8');
  assert.deepEqual(afterRemove.entries.map(entry => entry.target), [targets[0], targets[2], targets[3]]);

  // Rename: the name line changes and nothing else does.
  const renamed = toM3u8(before.entries, { name: 'Café Mix', base: 'Playlists' });
  assert.equal(renamed, source.replace('#PLAYLIST:Mix', '#PLAYLIST:Café Mix'));
});
