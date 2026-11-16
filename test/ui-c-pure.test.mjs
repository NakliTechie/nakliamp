// Panel agent C: pure parts of the dialog, sound, inspector, lyrics, AI and keymap panels.
import test from 'node:test';
import assert from 'node:assert/strict';

import { trapTarget, confirmSections } from '../app/ui/dialog.mjs';
import {
  sliderToDb, formatDb, formatHz, shortHz, shortDb, displayedCurve, editBand, presetLabel, crossfadeText, loudnessStatusText,
} from '../app/ui/sound-panel.mjs';
import { inspectorSections, formatBytes, formatDuration, RUNG_LABELS } from '../app/ui/inspector.mjs';
import { activeLineIndex, splitTrackPath, findSidecar, sourceText } from '../app/ui/lyrics.mjs';
import { pathWording, previewRows, playlistName } from '../app/ui/ai-dialog.mjs';
import { filterKeymap } from '../app/ui/keymap.mjs';
import { keymapRows } from '../app/commands/run.mjs';
import { GROUP_LABELS } from '../app/commands/commands.mjs';
import { parseLrc } from '../app/library/lyrics.mjs';
import { EQ_PRESETS } from '../app/audio/eq-presets.mjs';
import { PATHS } from '../app/ai/playlist.mjs';

// ---------------------------------------------------------------- dialog ----

test('trapTarget wraps Tab at both ends and leaves the middle to the browser', () => {
  const a = {}; const b = {}; const c = {};
  assert.equal(trapTarget([a, b, c], c, false), a);
  assert.equal(trapTarget([a, b, c], a, true), c);
  assert.equal(trapTarget([a, b, c], b, false), null);
  assert.equal(trapTarget([a, b, c], b, true), null);
  assert.equal(trapTarget([a, b, c], {}, false), a, 'focus outside the list goes to the first');
  assert.equal(trapTarget([], a, false), 'container');
});

test('confirmSections lists changes, notes and skipped files by name', () => {
  const sections = confirmSections({
    summary: '2 of 3 files change.',
    lines: ['Artist: set to "X" in 2 files', 'Upgrade note'],
    notes: ['Upgrade note'],
    files: [{ name: 'a.mp3', lines: ['Title: (empty) to "A"'] }, { name: 'b.wav', skipped: true, reason: 'Tag editing is not available for WAV files yet.' }],
  });
  assert.deepEqual(sections.map(s => s.kind), ['summary', 'change', 'note', 'change', 'note']);
  assert.deepEqual(sections[1].lines, ['Artist: set to "X" in 2 files'], 'notes are not repeated as changes');
  assert.equal(sections[3].heading, 'a.mp3');
  assert.deepEqual(sections[4].lines, ['b.wav: Tag editing is not available for WAV files yet.']);
  assert.deepEqual(confirmSections(null), []);
  assert.deepEqual(confirmSections('one line')[0].lines, ['one line']);
});

// ----------------------------------------------------------------- sound ----

test('sliderToDb clamps to -12..12 and rounds to 0.5 dB', () => {
  assert.equal(sliderToDb('3.26'), 3.5);
  assert.equal(sliderToDb('3.24'), 3);
  assert.equal(sliderToDb(40), 12);
  assert.equal(sliderToDb(-40), -12);
  assert.equal(sliderToDb('nonsense'), 0);
  assert.equal(sliderToDb('-0.2'), -0);
});

test('formatDb and formatHz read naturally', () => {
  assert.equal(formatDb(3), '+3 dB');
  assert.equal(formatDb(-4.5), '−4.5 dB');
  assert.equal(formatDb(0), '0 dB');
  assert.equal(formatHz(70), '70 Hz');
  assert.equal(formatHz(1000), '1 kHz');
  assert.equal(formatHz(12000), '12 kHz');
  assert.deepEqual([70, 1000, 12000].map(shortHz), ['70', '1k', '12k'], 'short band labels fit ten columns at 360 px');
  assert.equal(shortDb(-4.5), '\u22124.5');
  assert.equal(shortDb(0), '0');
});

test('displayedCurve shows the preset, the custom curve, or flat for an unknown preset', () => {
  assert.deepEqual(displayedCurve({ preset: 'rock' }), [...EQ_PRESETS.rock.gains]);
  assert.deepEqual(displayedCurve({ preset: 'custom', custom: [1, 2, 99] }), [1, 2, 12, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(displayedCurve({ preset: 'gone' }), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('editBand turns the shown preset into a custom curve with one band moved, and turns the EQ on', () => {
  const next = editBand({ enabled: false, preset: 'rock', custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, 2, '7.3');
  assert.equal(next.preset, 'custom');
  assert.equal(next.enabled, true);
  const expected = [...EQ_PRESETS.rock.gains];
  expected[2] = 7.5;
  assert.deepEqual(next.custom, expected);
});

test('sound labels: preset names, crossfade, loudness scan status', () => {
  assert.equal(presetLabel('bass-boost'), 'Bass boost');
  assert.equal(presetLabel('custom'), 'Custom');
  assert.equal(crossfadeText(0), 'Off');
  assert.equal(crossfadeText(6), '6 s');
  assert.match(loudnessStatusText('off', null), /^Off/);
  assert.equal(loudnessStatusText('idle', { state: 'running', done: 3, total: 10 }), 'Measuring loudness. 3 of 10 measured.');
  assert.match(loudnessStatusText('idle', 'paused'), /^Paused/);
});

// ------------------------------------------------------------- inspector ----

const track = {
  id: 't1', path: 'Jazz/KoB/01 So What.flac', name: '01 So What.flac', size: 52_428_800, lastModified: 1_700_000_000_000,
  container: 'flac', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', albumArtist: 'Miles Davis',
  trackNo: 1, trackTotal: 5, discNo: null, discTotal: null, year: 1959, genre: 'Jazz', durationS: 545.2, sampleRate: 44100,
  channels: 2, hasLyrics: false, artKey: 'k', playCount: 3, lastPlayedAt: 0, bookmarked: 1, addedAt: 1_700_000_000_000, rating: 4,
  replayGain: { trackGainDb: -3.21, trackPeak: 0.98765, albumGainDb: null, albumPeak: null },
};

test('inspectorSections shows every field, with "Not set" for empty ones', () => {
  const sections = inspectorSections(track, { loudness: { integratedLufs: -14.04, truePeak: -0.5, gainDb: -3.96 } });
  assert.deepEqual(sections.map(s => s.title), ['Tags', 'File', 'Loudness', 'Listening']);
  const all = Object.fromEntries(sections.flatMap(s => s.rows.map(r => [r.label, r.value])));
  assert.equal(all.Track, '1 of 5');
  assert.equal(all.Disc, 'Not set');
  assert.equal(all.Path, 'Jazz/KoB/01 So What.flac');
  assert.equal(all.Format, 'FLAC');
  assert.equal(all.Channels, 'Stereo');
  assert.equal(all.Duration, '9:05');
  assert.equal(all['Track gain'], '−3.21 dB, peak 0.9877');
  assert.equal(all['Album gain'], 'Not set');
  assert.equal(all['Measured loudness'], '-14 LUFS, true peak -0.5 dBTP, gain −3.96 dB');
  assert.equal(all.Rating, '4 of 5 stars');
  assert.equal(all['Last played'], 'Never');
  assert.equal(all.Favourite, 'Yes');
});

test('inspectorSections adds the rung and sound chain for the playing track', () => {
  const engine = {
    path: 'r1', track: { codec: 'flac' }, honesty: { decode: 'AudioDecoder', output: 'AudioWorklet · Web Audio' },
    dsp: { chain: 'on', gainDb: -3.2, gainSource: 'track', clipLimited: false, eq: { enabled: true, preset: 'rock' }, crossfading: false, gapless: true },
  };
  const playing = inspectorSections(track, { engine }).at(-1);
  assert.equal(playing.title, 'Playing now');
  const rows = Object.fromEntries(playing.rows.map(r => [r.label, r.value]));
  assert.equal(rows.Rung, RUNG_LABELS.r1);
  assert.equal(rows['Sound chain'], 'On');
  assert.equal(rows['Gain applied'], '−3.2 dB (track)');
  assert.equal(rows.Equaliser, 'On, rock');
  assert.equal(rows['Next track'], 'Gapless');
  assert.deepEqual(inspectorSections(null), []);
});

test('formatBytes and formatDuration', () => {
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(52_428_800), '50.0 MB (52,428,800 bytes)');
  assert.equal(formatBytes(-1), null);
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(0), null);
});

// ---------------------------------------------------------------- lyrics ----

test('activeLineIndex follows synced lyrics and ignores plain ones', () => {
  const synced = { ...parseLrc('[00:01.00]one\n[00:05.50]two\n[00:09.00]three'), source: 'lrc' };
  assert.equal(activeLineIndex(synced, 0.5), -1);
  assert.equal(activeLineIndex(synced, 1), 0);
  assert.equal(activeLineIndex(synced, 5.49), 0);
  assert.equal(activeLineIndex(synced, 5.5), 1);
  assert.equal(activeLineIndex(synced, 400), 2);
  assert.equal(activeLineIndex(synced, NaN), -1);
  const plain = { ...parseLrc('one\ntwo'), source: 'embedded' };
  assert.equal(activeLineIndex(plain, 3), -1);
  assert.equal(activeLineIndex(null, 3), -1);
  assert.equal(sourceText(synced), 'Synced lyrics from the .lrc file beside the track');
  assert.equal(sourceText(plain), 'Lyrics embedded in the file');
});

test('splitTrackPath and findSidecar walk the folder handle', async () => {
  assert.deepEqual(splitTrackPath('A/B/song.mp3'), { directories: ['A', 'B'], name: 'song.mp3' });
  assert.deepEqual(splitTrackPath('song.mp3'), { directories: [], name: 'song.mp3' });
  const lrc = new Blob(['[00:01.00]hi']);
  const dir = (children, files) => ({
    async getDirectoryHandle(name) { if (!children[name]) throw new Error('missing'); return children[name]; },
    async getFileHandle(name) { if (!files[name]) throw new Error('missing'); return { getFile: async () => files[name] }; },
  });
  const root = dir({ A: dir({}, { 'song.LRC': lrc }) }, {});
  assert.equal(await findSidecar(root, { path: 'A/song.mp3' }), lrc, 'falls back to the upper-case extension');
  assert.equal(await findSidecar(root, { path: 'Z/song.mp3' }), null);
  assert.equal(await findSidecar(null, { path: 'A/song.mp3' }), null);
});

// -------------------------------------------------------------------- AI ----

test('pathWording names the path that ran in plain words', () => {
  assert.equal(pathWording({ path: PATHS.model, candidateCount: 300, widened: [] }), 'Picked by the NakliOS model from 300 matching tracks.');
  assert.equal(pathWording({ path: PATHS.filter, candidateCount: 40, widened: [], hadModel: false }), 'No model here: matched by tags and search.');
  assert.equal(pathWording({ path: PATHS.filter, candidateCount: 0, widened: [] }), 'Nothing in the library matched that description.');
  assert.equal(pathWording({ path: PATHS.retry, candidateCount: 1, widened: [] }), 'Picked by the NakliOS model from 1 matching track, on its second try.');
  assert.equal(
    pathWording({ path: PATHS.failed, candidateCount: 12, error: 'timed out.', widened: ['genre-neighbours'] }),
    'The NakliOS model did not give a usable answer (timed out), so these are matched by tags and search. Few tracks matched, so the search widened to neighbouring genres.',
  );
  assert.equal(pathWording(null), '');
});

test('previewRows keeps order and drops ids the library lost; playlistName is file-safe', () => {
  const lib = new Map([['a', { title: 'A', artist: 'X' }], ['c', { name: 'c.mp3', albumArtist: 'Y', album: 'Z' }]]);
  assert.deepEqual(previewRows(['c', 'b', 'a'], id => lib.get(id)), [
    { id: 'c', title: 'c.mp3', artist: 'Y', album: 'Z' },
    { id: 'a', title: 'A', artist: 'X', album: '' },
  ]);
  assert.equal(playlistName('Rainy: day / mix?', ''), 'Rainy day mix');
  assert.equal(playlistName('', 'quiet piano'), 'quiet piano');
  assert.equal(playlistName('', ''), 'AI playlist');
});

// ---------------------------------------------------------------- keymap ----

test('filterKeymap matches actions, groups and keys, and drops empty groups', () => {
  const groups = keymapRows({ mac: false, groupLabels: GROUP_LABELS });
  assert.ok(groups.length > 3);
  assert.equal(filterKeymap(groups, ''), groups);
  const lyrics = filterKeymap(groups, 'lyrics');
  assert.equal(lyrics.length, 1);
  assert.deepEqual(lyrics[0].rows.map(r => r.keys[0]), ['Y']);
  const sound = filterKeymap(groups, 'sound');
  assert.ok(sound.every(g => g.groupLabel === 'Sound'));
  assert.ok(sound[0].rows.length >= 1);
  assert.deepEqual(filterKeymap(groups, 'zzzz-nothing'), []);
});
