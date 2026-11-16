// v1.x panels (W2): pure parts of the network, library tools, timers, command bar and AI panels.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  plainError, runOr, writeTagPatches, writeSummary, formatSize, formatDuration, compareRows, duplicateRows,
  renamePreview, renameSummary, insertToken, replacePreview, replaceDiff, renameDiff, folderRows, statusWord,
} from '../app/ui/v1x-library-tools.mjs';
import { sleepInput, applySleep, timerStatusText, choiceFor } from '../app/ui/v1x-timers.mjs';
import { pathText, undoFor, describeStep, resultText, captureBefore } from '../app/ui/v1x-command-bar.mjs';
import { similarPathText, playingIdOf, approvedEdits, genreRows, modelReady, chatOf } from '../app/ui/v1x-ai-tools.mjs';
import {
  networkRows, sendsText, scrobbleStatusText, flushText, albumQuery, releaseLabel, patchPreview, patchItems, lyricsOf, sidecarName,
} from '../app/ui/v1x-network.mjs';
import { createPlaybackTimers } from '../app/player/timers.mjs';
import { findDuplicates } from '../app/library/duplicates.mjs';
import { createConsent } from '../app/net/consent.mjs';
import { SIMILAR_PATHS } from '../app/ai/similar.mjs';

const notFound = () => Object.assign(new Error('[not-found] x has no handler in this build.'), { code: 'not-found' });
const declined = () => Object.assign(new Error('[declined] The person did not approve.'), { code: 'declined' });

// ------------------------------------------------------------ shared helpers ----

test('plainError strips the [code] prefix', () => {
  assert.equal(plainError(new Error('[not-granted] LRCLIB is off.')), 'LRCLIB is off.');
  assert.equal(plainError('plain'), 'plain');
  assert.equal(plainError(null), 'Something went wrong.');
});

test('runOr runs the command, falls back only on not-found, and rethrows other errors', async () => {
  assert.equal(await runOr({ run: async () => 'ran' }, 'a.b', {}, () => 'fell'), 'ran');
  assert.equal(await runOr({ run: async () => { throw notFound(); } }, 'a.b', {}, () => 'fell'), 'fell');
  assert.equal(await runOr({}, 'a.b', {}, () => 'direct'), 'direct');
  await assert.rejects(runOr({ run: async () => { throw declined(); } }, 'a.b', {}, () => 'fell'), /declined/);
  await assert.rejects(runOr({}, 'a.b', {}), /not-found/);
});

test('writeTagPatches prefers ctx.editTags and passes the whole batch once', async () => {
  const calls = [];
  const ctx = { editTags: async (items, opts) => { calls.push([items, opts]); return { written: items.length }; }, run: () => assert.fail('no run') };
  const result = await writeTagPatches(ctx, [{ ids: ['1'], patch: { genre: 'Jazz' } }, { ids: ['2'], patch: {} }], { title: 'Genres' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].length, 1, 'empty patches are dropped');
  assert.equal(calls[0][1].title, 'Genres');
  assert.deepEqual(result, { written: 1, refused: 0, failed: [] });
});

test('writeTagPatches falls back to one track.edit_tags per item, dropping picture and keeping coverFrom', async () => {
  const runs = [];
  let n = 0;
  const ctx = {
    run: async (name, input) => {
      runs.push([name, input]);
      n += 1;
      if (n === 2) throw declined();
      if (n === 3) throw new Error('[unsupported] WAV tags cannot be written.');
      return { ok: true };
    },
  };
  const items = [
    { ids: [1], patch: { album: 'A', picture: { mime: 'image/png', bytes: new Uint8Array(1) } }, coverFrom: 'mbid-1' },
    { ids: [2], patch: { album: 'A' } },
    { ids: [3], patch: { album: 'A' } },
  ];
  const result = await writeTagPatches(ctx, items);
  assert.deepEqual(runs[0], ['track.edit_tags', { ids: ['1'], patch: { album: 'A' }, coverFrom: 'mbid-1' }]);
  assert.equal(result.written, 1);
  assert.equal(result.refused, 1);
  assert.deepEqual(result.failed, [{ ids: [3], error: 'WAV tags cannot be written.' }]);
  assert.equal(writeSummary(result), '1 file written, 1 not approved, 1 failed: WAV tags cannot be written.');
  assert.equal(writeSummary({ written: 0, refused: 0, failed: [] }), 'Nothing was written.');
});

// ---------------------------------------------------------------- duplicates ----

const dupTracks = [
  { id: 'a', path: 'A/song.flac', title: 'Song', artist: 'Band', album: 'LP', durationS: 200, size: 30_000_000, playCount: 5 },
  { id: 'b', path: 'B/song.flac', title: 'Song', artist: 'Band', album: 'LP', durationS: 200, size: 30_000_000, playCount: 0 },
  { id: 'c', path: 'C/song.mp3', title: 'song', artist: 'band', album: 'Best of', durationS: 201, size: 8_000_000, codec: 'mp3', bitrate: 320000 },
  { id: 'd', path: 'D/other.mp3', title: 'Other', artist: 'Band', durationS: 100, size: 2 },
];
const getDup = id => dupTracks.find(t => t.id === id) ?? null;

test('formatSize and formatDuration', () => {
  assert.equal(formatSize(30_000_000), '28.6 MB');
  assert.equal(formatSize(2048), '2 KB');
  assert.equal(formatSize(0), '');
  assert.equal(formatDuration(200), '3:20');
  assert.equal(formatDuration(null), '');
});

test('duplicateRows names each group, keeps the suggested copy and skips hidden ones', () => {
  const rows = duplicateRows(findDuplicates(dupTracks), getDup);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'exact');
  assert.equal(rows[0].keepId, 'a');
  assert.match(rows[0].heading, /^Exact copy: Song by Band \(2 files\)$/);
  assert.equal(rows[1].kind, 'likely');
  assert.equal(rows[1].tracks.length, 3);
  const hidden = duplicateRows(findDuplicates(dupTracks), getDup, { hiddenIds: new Set(['b']) });
  assert.equal(hidden.length, 1, 'the exact group drops below two once b is hidden');
  assert.equal(hidden[0].tracks.length, 2);
});

test('compareRows marks the fields that differ', () => {
  const rows = compareRows([dupTracks[0], dupTracks[2]]);
  const by = Object.fromEntries(rows.map(r => [r.field, r]));
  assert.equal(by.Artist.differs, true, 'Band vs band');
  assert.equal(by.Length.differs, true);
  assert.equal(by.Folder.values[0], 'A');
  assert.equal(by.Format.values[1], 'mp3, 320 kbps');
  assert.equal(compareRows([dupTracks[0], dupTracks[1]]).find(r => r.field === 'Size').differs, false);
});

// ------------------------------------------------------------- rename ----

const renameTracks = [
  { id: 1, path: 'LP/01.flac', title: 'Intro', artist: 'Band', trackNo: 1 },
  { id: 2, path: 'LP/02.flac', title: 'Intro', artist: 'Band', trackNo: 1 },
  { id: 3, path: 'LP/03.flac' },
  { id: 4, path: 'LP/image.flac#1', virtual: { parentPath: 'LP/image.flac' }, title: 'Part' },
  { id: 5, path: 'LP/05 - Outro.flac', title: 'Outro', trackNo: 5 },
];

test('renamePreview counts every status and reports a bad pattern', () => {
  const preview = renamePreview(renameTracks, '%track% - %title%');
  assert.equal(preview.error, null);
  assert.deepEqual(preview.counts, { rename: 0, same: 1, empty: 1, virtual: 1, conflict: 2 });
  assert.equal(renameSummary(preview.counts), '1 already named so, 1 no tags for the pattern, 1 part of a cue sheet, 2 name clash.');
  const bad = renamePreview(renameTracks, '%nope%');
  assert.match(bad.error, /Unknown token %nope%/);
  assert.equal(renameSummary(bad.counts), '');
  assert.equal(statusWord('conflict'), 'name clash');
});

test('renameDiff lists only the files that move', () => {
  const preview = renamePreview([renameTracks[0], renameTracks[4]], '%title%');
  const diff = renameDiff(preview.rows);
  assert.equal(diff.title, 'Rename 2 files?');
  assert.deepEqual(diff.lines, ['01.flac to Intro.flac', '05 - Outro.flac to Outro.flac']);
});

test('insertToken inserts at the selection and moves the caret after it', () => {
  assert.deepEqual(insertToken('a - b', 2, 2, 'title'), { value: 'a %title%- b', caret: 9 });
  assert.deepEqual(insertToken('a - b', 0, 1, 'track'), { value: '%track% - b', caret: 7 });
  assert.deepEqual(insertToken('x', undefined, undefined, 'year'), { value: 'x%year%', caret: 7 });
});

test('replacePreview flattens per-field changes and replaceDiff describes them', () => {
  const recs = [
    { id: 1, path: 'a.mp3', title: 'Song (Remastered)', album: 'LP (Remastered)' },
    { id: 2, path: 'b.mp3', title: 'Other' },
  ];
  const preview = replacePreview(recs, { find: ' (Remastered)', replace: '' });
  assert.equal(preview.plans.length, 1);
  assert.deepEqual(preview.rows.map(r => [r.field, r.before, r.after]), [['Title', 'Song (Remastered)', 'Song'], ['Album', 'LP (Remastered)', 'LP']]);
  const diff = replaceDiff(preview.rows);
  assert.equal(diff.title, 'Change tags in 1 files?');
  assert.equal(diff.lines[0], 'Song (Remastered), Title: "Song (Remastered)" to "Song"');
  assert.deepEqual(replacePreview(recs, { find: '' }).rows, []);
  assert.match(replacePreview(recs, { find: '(', regex: true }).error, /not a valid regular expression/);
});

test('folderRows counts visible tracks per folder and words the grant state', () => {
  const tracks = [
    { path: 'a.flac' }, { path: 'x/b.flac' }, { path: '//f1/c.flac' }, { path: 'hidden.flac', hidden: 1 }, { path: '' },
  ];
  const rows = folderRows([{ id: 'main', name: 'Music', primary: true, grant: 'granted' }, { id: 'f1', name: 'Extra', primary: false, grant: 'prompt' }], tracks);
  assert.deepEqual(rows, [
    { id: 'main', name: 'Music', primary: true, count: 2, grantText: '' },
    { id: 'f1', name: 'Extra', primary: false, count: 1, grantText: 'Needs permission again' },
  ]);
  assert.equal(folderRows({ folders: [{ id: 'main' }] }, [])[0].primary, true, 'command result shape; first row is primary');
});

// ---------------------------------------------------------------- timers ----

test('sleepInput maps choices to player.sleep_timer input', () => {
  assert.deepEqual(sleepInput('off'), { mode: 'off' });
  assert.deepEqual(sleepInput('minutes', '30'), { minutes: 30 });
  assert.deepEqual(sleepInput('end-of-queue'), { mode: 'end-of-queue' });
  assert.throws(() => sleepInput('minutes', 0), /between 1 and 1440/);
  assert.throws(() => sleepInput('minutes', 'x'), /between 1 and 1440/);
});

test('applySleep and timerStatusText follow the timers object', () => {
  let now = 0;
  const timers = createPlaybackTimers({ now: () => now });
  assert.equal(timerStatusText(timers.status()), 'No timer is set.');
  applySleep(timers, { minutes: 25 });
  now = 60_000;
  assert.equal(choiceFor(timers.status()), 'minutes');
  assert.match(timerStatusText(timers.status()), /^Sleep in 24:00;/);
  timers.setStopAfterCurrent(true);
  applySleep(timers, { mode: 'end-of-queue' });
  assert.equal(timerStatusText(timers.status()), 'Playback stops when this track ends. Sleep at the end of the queue.');
  applySleep(timers, { mode: 'off' });
  assert.equal(choiceFor(timers.status()), 'off');
  assert.equal(timerStatusText(null), 'No timer is set.');
});

// ------------------------------------------------------------ command bar ----

test('undoFor reverses queue changes and restores toggled state', () => {
  const before = { shuffle: 'off', repeat: 'all', volume: 0.4, muted: false, playing: true };
  assert.deepEqual(undoFor({ steps: [{ name: 'queue.clear', input: {} }] }, before), { name: 'queue.undo', input: {} });
  assert.deepEqual(undoFor({ steps: [{ name: 'library.search', input: { query: 'jazz' } }], followUp: 'queue.set' }, before), { name: 'queue.undo', input: {} });
  assert.deepEqual(undoFor({ steps: [{ name: 'queue.shuffle', input: { mode: 'tracks' } }] }, before), { name: 'queue.shuffle', input: { mode: 'off' } });
  assert.deepEqual(undoFor({ steps: [{ name: 'player.volume', input: { level: 0.9 } }] }, before), { name: 'player.volume', input: { level: 0.4 } });
  assert.deepEqual(undoFor({ steps: [{ name: 'player.mute', input: { muted: true } }] }, before), { name: 'player.mute', input: { muted: false } });
  assert.deepEqual(undoFor({ steps: [{ name: 'player.pause', input: {} }] }, before), { name: 'player.play', input: {} });
  assert.equal(undoFor({ steps: [{ name: 'player.next', input: {} }] }, before), null);
  assert.equal(undoFor({ steps: [{ name: 'player.status', input: {} }] }, before), null);
  assert.equal(undoFor({ steps: [{ name: 'player.volume', input: { level: 1 } }] }, { volume: null }), null);
});

test('captureBefore reads the shell state and engine clock without throwing', () => {
  const ctx = { state: () => ({ playing: false, queue: { shuffle: 'albums', repeat: 'off' } }), engine: { state: () => ({ clock: { volume: 0.7, muted: true } }) } };
  assert.deepEqual(captureBefore(ctx), { shuffle: 'albums', repeat: 'off', volume: 0.7, muted: true, playing: false });
  assert.deepEqual(captureBefore({ state: () => { throw new Error('x'); } }), { shuffle: null, repeat: null, volume: null, muted: null, playing: null });
});

test('describeStep, pathText and resultText', () => {
  assert.equal(describeStep({ name: 'queue.shuffle', input: { mode: 'albums' } }), 'Shuffle (queue.shuffle) with mode albums');
  assert.equal(describeStep({ name: 'queue.set', input: { ids: ['1', '2'] } }), 'Replace queue (queue.set) with ids 2 items');
  assert.equal(pathText('rules'), 'Answered by the built-in phrases.');
  assert.equal(pathText('model-failed-then-rules', 'timed out.'), 'The NakliOS model did not answer, so the built-in phrases did. (timed out)');
  assert.equal(resultText({ track: { title: 'So What', artist: 'Miles Davis' }, playing: true }), 'Playing: So What by Miles Davis.');
  assert.equal(resultText({ tracks: [{}, {}], total: 7 }), '7 tracks.');
  assert.equal(resultText(undefined), '');
});

// ---------------------------------------------------------------- AI tools ----

test('similarPathText words each path', () => {
  assert.match(similarPathText({ path: SIMILAR_PATHS.model, candidateCount: 12 }), /^Picked by the NakliOS model from 12 candidates/);
  assert.match(similarPathText({ path: SIMILAR_PATHS.failed, candidateCount: 3, error: 'bad JSON.' }), /\(bad JSON\), so these come from matching tags\.$/);
  assert.match(similarPathText({ path: SIMILAR_PATHS.tags, candidateCount: 0 }), /^Nothing else/);
  assert.match(similarPathText({ path: SIMILAR_PATHS.tags, candidateCount: 4 }), /^Matched by tags/);
});

test('playingIdOf prefers the shell state and falls back to the queue', () => {
  assert.equal(playingIdOf({ state: () => ({ playingId: 't1' }), queue: { current: () => 't2' } }), 't1');
  assert.equal(playingIdOf({ state: () => ({ playingId: null }), queue: { current: () => 't2' } }), 't2');
  assert.equal(playingIdOf({}), null);
});

test('genreRows and approvedEdits write only approved rows with the edited genre', () => {
  const rows = genreRows([
    { id: 1, key: 'k1', artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', trackIds: ['a', 'b'] },
    { id: 2, key: 'k2', artist: 'X', album: 'Y', genre: 'Rock', trackIds: ['c'] },
  ]);
  assert.ok(rows.every(r => r.approved));
  rows[1].approved = false;
  rows[0].genre = 'Blues';
  const edits = approvedEdits(rows);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].ids, ['a', 'b']);
  assert.deepEqual(edits[0].patch, { genre: 'Blues' });
  assert.match(edits[0].label, /Kind of Blue: set genre to Blues on 2 tracks/);
});

test('modelReady and chatOf prefer ctx.ai, then the host', async () => {
  assert.equal(modelReady({ ai: { ready: () => false }, host: { aiReady: () => true } }), false);
  assert.equal(chatOf({ ai: { ready: () => false, chat: () => 1 } }), null);
  const viaAi = chatOf({ ai: { ready: () => true, chat: async body => ['ai', body] } });
  assert.deepEqual(await viaAi('b'), ['ai', 'b']);
  const viaHost = chatOf({ host: { aiReady: () => true, aiChat: async body => ['host', body] } });
  assert.deepEqual(await viaHost('b'), ['host', 'b']);
  assert.equal(chatOf({}), null);
});

// ---------------------------------------------------------------- network ----

test('networkRows lists every known origin off by default, with what it sends', () => {
  const memory = new Map();
  const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const consent = createConsent({ storage });
  const rows = networkRows(consent.list());
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => !r.granted));
  const caa = rows.find(r => r.label === 'Cover Art Archive');
  assert.match(sendsText(caa), /^Sends: The MusicBrainz release id\..* Also contacts https:\/\/archive\.org and https:\/\/\*\.archive\.org\.$/);
  consent.grant('https://lrclib.net');
  assert.equal(networkRows(consent.list()).find(r => r.label === 'LRCLIB').granted, true);
  assert.equal(networkRows({ origins: [{ origin: 'https://x.test' }] })[0].label, 'https://x.test');
});

test('scrobbleStatusText and flushText', () => {
  assert.equal(scrobbleStatusText({ tokenSet: false, queued: 0, rejected: 0 }), 'No token saved. 0 listens waiting to send.');
  assert.equal(
    scrobbleStatusText({ tokenSet: true, userName: 'chirag', queued: 1, rejected: 2, nextAttemptAt: 90_000, lastError: 'Offline.' }, 0),
    'Token saved for chirag. 1 listen waiting to send. 2 refused by ListenBrainz and set aside. Next try in 1:30. Last error: Offline.',
  );
  assert.equal(flushText({ status: 'sent', sent: 3 }), 'Sent. 3 sent.');
  assert.equal(flushText({ status: 'http-503' }), 'ListenBrainz answered 503. NakliAmp tries again later.');
  assert.equal(flushText({ status: 'waiting' }), 'Waiting before the next try.');
  assert.equal(flushText(null), '');
});

test('albumQuery picks the most common album and artist', () => {
  const q = albumQuery([
    { album: 'Kind of Blue', albumArtist: 'Miles Davis' },
    { album: 'Kind of Blue', artist: 'Miles Davis' },
    { album: 'Other', artist: 'Someone' },
  ]);
  assert.deepEqual(q, { album: 'Kind of Blue', artist: 'Miles Davis' });
  assert.deepEqual(albumQuery([]), { album: '', artist: '' });
});

test('releaseLabel, patchPreview and patchItems', () => {
  assert.equal(releaseLabel({ title: 'Kind of Blue', artist: 'Miles Davis', year: 1959, country: 'US', trackCount: 5 }), 'Kind of Blue by Miles Davis (1959, US, 5 tracks)');
  assert.equal(releaseLabel({ title: 'Single', trackCount: 1 }), 'Single (1 track)');
  const tracks = { t1: { id: 't1', title: 'so what', album: 'Kind of Blue', year: 1959 } };
  const patches = [{ trackId: 't1', matched: 'number', patch: { title: 'So What', album: 'Kind of Blue', year: 1959, trackNo: 1 } }];
  const preview = patchPreview(patches, id => tracks[id]);
  assert.equal(preview[0].matched, 'matched by track number');
  assert.deepEqual(preview[0].changes, [{ field: 'Title', before: 'so what', after: 'So What' }, { field: 'Track', before: '(empty)', after: '1' }]);
  assert.deepEqual(patchItems(patches, { coverFrom: 'mb' }), [{ ids: ['t1'], patch: patches[0].patch, coverFrom: 'mb' }]);
  assert.equal(patchItems(patches)[0].coverFrom, undefined);
});

test('lyricsOf reads LRCLIB results, command results and raw text; sidecarName', () => {
  assert.deepEqual(lyricsOf({ instrumental: true }), { synced: false, lines: [], instrumental: true });
  assert.equal(lyricsOf({ lyrics: { synced: true, lines: [{ timeS: 1, text: 'a' }] } }).synced, true);
  const fromText = lyricsOf({ text: '[00:01.00]Hello\n[00:02.00]World' });
  assert.equal(fromText.synced, true);
  assert.deepEqual(fromText.lines.map(l => l.text), ['Hello', 'World']);
  assert.equal(lyricsOf(null), null);
  assert.equal(lyricsOf({}), null);
  assert.equal(sidecarName('Jazz/01 So What.flac'), '01 So What.lrc');
});
