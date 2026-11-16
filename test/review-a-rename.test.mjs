// Review 2026-11-17: N14 (undo and the backup list in the tag editor), N23 (playlists and
// sidecars follow a rename) and N37 (no rename without a collision check).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditTagsHandler, tagBackupRows, backupLine } from '../app/ui/tag-editor.mjs';
import { planRename, planPlaylistRenames, sidecarRenames, renameOnDisk } from '../app/library/rename.mjs';
import { parsePlaylist } from '../app/library/playlist.mjs';
import { readTags } from '../app/library/metadata.mjs';
import { fixture, equalBytes } from './tags-helpers.mjs';
import { fakeFile, fakeDirectory } from './review-a-fakes.mjs';

async function editor() {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original);
  const track = { id: 'f', name: 'song.flac', path: 'Rock/song.flac', lastModified: 1000, title: null };
  const updates = [];
  const ctx = {
    library: {
      getTrack: (id) => (id === 'f' ? track : null),
      findByPath: (path) => (path === track.path ? track : null),
      fileFor: async () => handle.getFile(),
      handleFor: async () => handle,
      updateTrack: async (id, patch) => { updates.push([id, patch]); },
    },
  };
  const root = fakeDirectory();
  const saveOptions = { backupRoot: async () => root };
  return { ctx, handle, original, saveOptions, handler: createEditTagsHandler(ctx, { saveOptions }) };
}

test('N14: a written tag edit offers undo, and the backup list restores it by track path', async () => {
  const { ctx, handle, original, saveOptions, handler } = await editor();
  const input = { ids: ['f'], patch: { album: 'Wrong Album' } };
  await handler.diff(input, {});
  const { results } = await handler.run(input, {});
  assert.equal(results[0].status, 'written');
  assert.equal(typeof results[0].restore, 'function', 'a good write can be undone');
  assert.equal((await readTags(await handle.getFile())).album, 'Wrong Album');

  const rows = await tagBackupRows(ctx, saveOptions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'Rock/song.flac');
  assert.match(rows[0].line, /^Rock\/song\.flac: original before a tag edit, saved /);
  await rows[0].restore();
  assert.ok(equalBytes(handle.state.bytes, original), 'restored from the list');
  assert.deepEqual(await tagBackupRows(ctx, saveOptions), []);
});

test('N14: backupLine says when a backup is the only good copy', () => {
  assert.match(backupLine({ path: 'a.mp3', status: 'failed', savedAt: null, size: 2048 }), /only good copy, saved an earlier session, 2 KB$/);
});

test('N23: playlists that name a renamed file are rewritten to the new name; other formats are reported', () => {
  const rows = planRename([
    { id: 1, path: 'Rock/01 old.mp3', title: 'New Name', trackNo: 1 },
    { id: 2, path: 'Rock/keep.mp3', title: 'keep' },
  ], '%title%');
  const m3u = parsePlaylist('#EXTM3U\n#EXTALB:Rock\n#EXTINF:10,A\n../Rock/01 old.mp3\n#EXTINF:5,K\n../Rock/keep.mp3\n', 'Lists/mix.m3u8');
  const pls = parsePlaylist('[playlist]\nFile1=Rock/01 old.mp3\nNumberOfEntries=1\n', 'old.pls');
  const untouched = parsePlaylist('#EXTM3U\nother.mp3\n', 'other.m3u8');
  const plan = planPlaylistRenames(rows, [m3u, pls, untouched]);
  assert.equal(plan.updates.length, 1);
  const again = parsePlaylist(plan.updates[0].text, 'Lists/mix.m3u8');
  assert.deepEqual(again.entries.map((entry) => entry.path), ['Rock/New Name.mp3', 'Rock/keep.mp3']);
  assert.deepEqual(again.header, ['#EXTALB:Rock'], 'other lines kept');
  assert.equal(plan.refused.length, 1);
  assert.deepEqual(plan.lines, [
    'Playlist Lists/mix.m3u8: 1 entry updated to the new names.',
    'Playlist old.pls (PLS): 1 entry names an old file; NakliAmp does not rewrite this format, so fix it by hand.',
  ]);
});

test('N23: a same-named .lrc follows the rename; a .cue is reported', () => {
  const row = { status: 'rename', from: '01 old.mp3', to: 'New Name.mp3', path: 'Rock/01 old.mp3' };
  assert.deepEqual(sidecarRenames(row, ['01 old.mp3', '01 old.LRC', '01 old.cue', 'cover.jpg']), {
    renames: [{ from: '01 old.LRC', to: 'New Name.LRC' }],
    cueSheets: ['01 old.cue'],
  });
});

test('N37: renameOnDisk refuses without the folder handle, because move may replace another file', async () => {
  const moved = [];
  const handle = { name: 'a.mp3', move: async (name) => { moved.push(name); } };
  await assert.rejects(renameOnDisk(handle, 'b.mp3'), (error) => error.code === 'ERR_NAKLIAMP_RENAME_UNCHECKED');
  assert.deepEqual(moved, []);
});
