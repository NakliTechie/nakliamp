// P12 cue sheets: parser, spans, file resolution, virtual records, scan plan.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCue, cueTimeToSeconds, cueSpans, resolveCueFile, virtualRecords, planCueRecords,
  decodeCueBytes, isCuePath, visibleTracks, playbackSpan, reachedSpanEnd, continuesInFile,
  virtualPath, CueFormatError,
} from '../app/library/cue.mjs';
import { validateTrack } from '../app/library/store.mjs';

const SHEET = `REM GENRE "Progressive Rock"
REM DATE 1973
PERFORMER "Pink Floyd"
TITLE "The Dark Side of the Moon"
FILE "Dark Side.wav" WAVE
  TRACK 01 AUDIO
    TITLE "Speak to Me"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Breathe"
    INDEX 00 01:07:50
    INDEX 01 01:08:00
  TRACK 03 AUDIO
    TITLE "On the Run"
    PERFORMER "Floyd and Friends"
    INDEX 01 03:57:37
`;

const parent = {
  id: 'p', path: 'Pink Floyd/Dark Side.flac', name: 'Dark Side.flac', size: 300_000_000, lastModified: 7,
  container: 'flac', title: 'Dark Side', artist: null, album: null, durationS: 400, sampleRate: 44100,
  channels: 2, artKey: 'p:art', dirArtKey: null, addedAt: 100, parserVersion: 2,
};

test('cue time is mm:ss:ff at 75 frames per second', () => {
  assert.equal(cueTimeToSeconds('00:00:00'), 0);
  assert.equal(cueTimeToSeconds('01:08:00'), 68);
  assert.equal(cueTimeToSeconds('03:57:37'), 237 + 37 / 75);
  assert.equal(cueTimeToSeconds('120:00:74'), 7200 + 74 / 75);
  assert.equal(cueTimeToSeconds('00:60:00'), null);
  assert.equal(cueTimeToSeconds('00:00:75'), null);
  assert.equal(cueTimeToSeconds('1:2'), null);
});

test('a sheet parses into album fields and tracks with INDEX 01 starts', () => {
  const sheet = parseCue(SHEET);
  assert.equal(sheet.title, 'The Dark Side of the Moon');
  assert.equal(sheet.performer, 'Pink Floyd');
  assert.equal(sheet.genre, 'Progressive Rock');
  assert.equal(sheet.year, 1973);
  assert.equal(sheet.files.length, 1);
  assert.equal(sheet.files[0].name, 'Dark Side.wav');
  assert.equal(sheet.files[0].type, 'WAVE');
  const [one, two, three] = sheet.files[0].tracks;
  assert.deepEqual([one.number, one.title, one.startS], [1, 'Speak to Me', 0]);
  assert.equal(two.startS, 68);
  assert.equal(two.pregapS, 67 + 50 / 75);
  assert.equal(three.performer, 'Floyd and Friends');
});

test('CRLF, unquoted values, data tracks and tracks without INDEX 01 are handled', () => {
  const sheet = parseCue('FILE album.flac WAVE\r\nTRACK 01 AUDIO\r\nTITLE Plain\r\nINDEX 01 00:00:00\r\nTRACK 02 MODE1/2352\r\nINDEX 01 01:00:00\r\nTRACK 03 AUDIO\r\nTITLE Lost\r\nTRACK 04 AUDIO\r\nINDEX 01 02:00:00\r\n');
  assert.equal(sheet.files[0].name, 'album.flac');
  assert.deepEqual(sheet.files[0].tracks.map(track => track.number), [1, 4]);
  assert.equal(sheet.files[0].tracks[0].title, 'Plain');
});

test('a sheet with nothing playable is refused by name', () => {
  assert.throws(() => parseCue('TITLE "x"'), CueFormatError);
  assert.throws(() => parseCue('FILE "a.wav" WAVE\nTRACK 01 AUDIO\n'), /no audio track/);
  assert.throws(() => parseCue('x'.repeat(600 * 1024)), /512 KB/);
});

test('spans end at the next start; the last ends at the file duration or null', () => {
  const tracks = parseCue(SHEET).files[0].tracks;
  const spans = cueSpans(tracks, 400);
  assert.deepEqual(spans.map(span => [span.startS, span.endS]), [[0, 68], [68, 237 + 37 / 75], [237 + 37 / 75, 400]]);
  assert.equal(cueSpans(tracks, null)[2].endS, null);
  // A last track starting after the known duration has no span.
  assert.equal(cueSpans(tracks, 200).length, 2);
});

test('cue FILE resolves in the same folder: exact, case-insensitive, then same stem', () => {
  const paths = ['A/Dark Side.flac', 'A/other.mp3', 'B/Dark Side.wav'];
  assert.equal(resolveCueFile('A/sheet.cue', 'Dark Side.wav', paths), 'A/Dark Side.flac');
  assert.equal(resolveCueFile('A/sheet.cue', 'OTHER.MP3', paths), 'A/other.mp3');
  assert.equal(resolveCueFile('B/sheet.cue', 'C:\\rips\\Dark Side.wav', paths), 'B/Dark Side.wav');
  assert.equal(resolveCueFile('A/sheet.cue', 'missing.wav', paths), null);
  // Two candidates with the same stem are ambiguous.
  assert.equal(resolveCueFile('C/s.cue', 'x.wav', ['C/x.flac', 'C/x.ape']), null);
});

test('virtual records carry tags, spans and the parent path, and validate in the store', () => {
  const sheet = parseCue(SHEET);
  const records = virtualRecords({ sheet, fileEntry: sheet.files[0], parent, cuePath: 'Pink Floyd/a.cue' });
  assert.equal(records.length, 3);
  const second = records[1];
  assert.equal(second.path, 'Pink Floyd/Dark Side.flac#2');
  assert.equal(second.title, 'Breathe');
  assert.equal(second.artist, 'Pink Floyd');
  assert.equal(second.album, 'The Dark Side of the Moon');
  assert.equal(second.trackNo, 2);
  assert.equal(second.trackTotal, 3);
  assert.equal(second.year, 1973);
  assert.equal(second.genre, 'Progressive Rock');
  assert.equal(second.artKey, 'p:art');
  assert.equal(second.addedAt, 100);
  assert.ok(Math.abs(second.durationS - (237 + 37 / 75 - 68)) < 1e-9);
  assert.equal(records[2].artist, 'Floyd and Friends');
  const valid = validateTrack({ ...second, id: 'v2' });
  assert.deepEqual(valid.virtual, { parentPath: parent.path, startS: 68, endS: 237 + 37 / 75, cuePath: 'Pink Floyd/a.cue' });
  assert.equal(valid.hidden, 0);
});

test('a FILE with a single track is not split', () => {
  const sheet = parseCue('FILE "a.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n');
  assert.deepEqual(virtualRecords({ sheet, fileEntry: sheet.files[0], parent }), []);
});

test('playback state survives a rescan through previous records', () => {
  const sheet = parseCue(SHEET);
  const previous = new Map([[virtualPath(parent.path, 1), { playCount: 4, rating: 5, bookmarked: 1, addedAt: 50 }]]);
  const [first] = virtualRecords({ sheet, fileEntry: sheet.files[0], parent, previous });
  assert.equal(first.playCount, 4);
  assert.equal(first.rating, 5);
  assert.equal(first.bookmarked, 1);
  assert.equal(first.addedAt, 50);
});

test('the scan plan builds virtual tracks, hides parents and reports bad sheets', () => {
  const records = new Map([[parent.path, parent], ['Other/x.mp3', { path: 'Other/x.mp3', durationS: 10 }]]);
  const plan = planCueRecords({
    cues: [
      { path: 'Pink Floyd/Dark Side.cue', text: SHEET },
      { path: 'Other/broken.cue', text: 'nothing here' },
      { path: 'Other/stray.cue', text: 'FILE "gone.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n' },
    ],
    records,
  });
  assert.equal(plan.virtual.length, 3);
  assert.deepEqual([...plan.hidden], [parent.path]);
  assert.deepEqual(plan.errors.map(error => error.path), ['Other/broken.cue', 'Other/stray.cue']);
  assert.match(plan.errors[1].message, /no audio file in its folder/);
});

test('an embedded sheet splits its own file whatever FILE says', () => {
  const records = new Map([[parent.path, parent]]);
  const plan = planCueRecords({ embedded: [{ parentPath: parent.path, text: SHEET.replace('Dark Side.wav', 'CDImage.wav') }], records });
  assert.equal(plan.virtual.length, 3);
  assert.equal(plan.virtual[0].virtual.cuePath, null);
});

test('children of an unchanged parent with an embedded sheet are kept', () => {
  const records = new Map([[parent.path, parent]]);
  const child = { path: `${parent.path}#1`, virtual: { parentPath: parent.path, startS: 0, endS: 68, cuePath: null } };
  const external = { path: `${parent.path}#9`, virtual: { parentPath: parent.path, startS: 0, endS: 68, cuePath: 'gone.cue' } };
  const previous = new Map([[child.path, child], [external.path, external]]);
  const plan = planCueRecords({ records, previous, unchangedParents: new Set([parent.path]) });
  assert.deepEqual([...plan.keep], [child.path]);
  assert.ok(plan.hidden.has(parent.path));
  // A re-read parent with no sheet any more loses its children.
  const reread = planCueRecords({ records, previous, unchangedParents: new Set() });
  assert.equal(reread.keep.size, 0);
  assert.equal(reread.hidden.size, 0);
});

test('Windows-1252 and UTF-8 with BOM sheets decode', () => {
  assert.equal(decodeCueBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9])), 'Café');
  assert.equal(decodeCueBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x43, 0x61, 0x66, 0xc3, 0xa9])), 'Café');
  assert.equal(isCuePath('a/B.CUE'), true);
  assert.equal(isCuePath('a/b.cuex'), false);
});

test('playback helpers: span, end detection, and continuing in one file', () => {
  const sheet = parseCue(SHEET);
  const [one, two, three] = virtualRecords({ sheet, fileEntry: sheet.files[0], parent });
  assert.deepEqual(playbackSpan(two), { path: parent.path, startS: 68, endS: 237 + 37 / 75 });
  assert.deepEqual(playbackSpan({ path: 'x.mp3' }), { path: 'x.mp3', startS: 0, endS: null });
  assert.equal(reachedSpanEnd(one, 67.9), false);
  assert.equal(reachedSpanEnd(one, 67.97), true);
  assert.equal(reachedSpanEnd({ path: 'x' }, 9999), false);
  assert.equal(continuesInFile(one, two), true);
  assert.equal(continuesInFile(one, three), false);
  assert.equal(continuesInFile(one, { path: 'x' }), false);
  assert.deepEqual(visibleTracks([{ id: 1, hidden: 1 }, { id: 2, hidden: 0 }, { id: 3 }]).map(t => t.id), [2, 3]);
});

test('the store refuses a malformed virtual span', () => {
  const base = { id: 'x', path: 'a#1', size: 1 };
  assert.throws(() => validateTrack({ ...base, virtual: { startS: 0 } }), /parent path/);
  assert.throws(() => validateTrack({ ...base, virtual: { parentPath: 'a', startS: -1 } }), /start/);
  assert.throws(() => validateTrack({ ...base, virtual: { parentPath: 'a', startS: 5, endS: 5 } }), /end/);
  assert.equal(validateTrack(base).virtual, null);
  assert.equal(validateTrack({ ...base, hidden: true }).hidden, 1);
});
