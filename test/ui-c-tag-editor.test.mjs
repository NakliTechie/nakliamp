// Panel agent C: the tag editor's multiple-values merge, patch building, and the
// track.edit_tags handler (diff and run) with in-memory handle fakes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeFields, initialText, buildPatch, recordPatchFrom, manyFileLines, resultSummary, createEditTagsHandler, MULTIPLE,
} from '../app/ui/tag-editor.mjs';
import { readTags } from '../app/library/metadata.mjs';
import { fixture } from './tags-helpers.mjs';

test('mergeFields marks fields that differ as mixed and keeps shared values', () => {
  const merged = mergeFields([
    { title: 'A', artist: 'Band', album: 'LP', year: 1999, rating: 0, genre: '' },
    { title: 'B', artist: 'Band', album: 'LP', year: 1999, rating: null, genre: null },
  ]);
  assert.deepEqual(merged.title, { value: null, mixed: true });
  assert.deepEqual(merged.artist, { value: 'Band', mixed: false });
  assert.deepEqual(merged.year, { value: 1999, mixed: false });
  assert.deepEqual(merged.rating, { value: null, mixed: false }, 'no rating and 0 are the same');
  assert.deepEqual(merged.genre, { value: null, mixed: false }, 'empty text and null are the same');
  assert.equal(initialText(merged, 'title'), '');
  assert.equal(initialText(merged, 'year'), '1999');
  assert.equal(MULTIPLE, 'Multiple values');
});

test('buildPatch writes only touched fields and leaves mixed fields alone unless typed in', () => {
  const merged = mergeFields([
    { title: 'A', artist: 'Band', year: 1999, trackNo: 1, rating: 3 },
    { title: 'B', artist: 'Band', year: 1999, trackNo: 2, rating: 3 },
  ]);
  assert.deepEqual(buildPatch(merged, {}), { patch: {}, errors: [] });
  assert.deepEqual(buildPatch(merged, { title: '' }).patch, {}, 'a mixed field left empty is unchanged');
  assert.deepEqual(buildPatch(merged, { title: ' Same ' }).patch, { title: 'Same' });
  assert.deepEqual(buildPatch(merged, { artist: 'Band' }).patch, {}, 'the same value is no change');
  assert.deepEqual(buildPatch(merged, { artist: '' }).patch, { artist: null }, 'emptying a shared field removes it');
  assert.deepEqual(buildPatch(merged, { year: '2001', trackNo: '7' }).patch, { year: 2001, trackNo: 7 });
  assert.deepEqual(buildPatch(merged, { rating: '0' }).patch, { rating: 0 });
  assert.deepEqual(buildPatch(merged, { rating: '' }).patch, { rating: 0 }, 'clearing a shared rating removes it');
  const bad = buildPatch(merged, { year: '19x9', trackNo: '-1' });
  assert.deepEqual(bad.patch, {});
  assert.deepEqual(bad.errors.map(e => e.key), ['trackNo', 'year']);
});

test('recordPatchFrom and manyFileLines', () => {
  assert.deepEqual(recordPatchFrom({ title: 'X', rating: null, picture: {} }), { title: 'X', rating: 0 });
  const lines = manyFileLines({ artist: 'Band', year: null }, { fields: { artist: 3, year: 1 } });
  assert.deepEqual(lines, ['Artist: set to "Band" in 3 files', 'Year: set to removed in 1 file']);
  assert.equal(resultSummary([{ status: 'written' }, { status: 'written' }, { status: 'skipped' }]), '2 written, 1 skipped.');
  assert.equal(resultSummary([]), 'Nothing to write.');
});

// --------------------------------------------------------- handler fakes ----

function fakeFileHandle(name, bytes, { writable = true } = {}) {
  const state = { bytes, lastModified: 1000 };
  const handle = {
    kind: 'file', name, state,
    async queryPermission() { return 'granted'; },
    async getFile() { return new File([state.bytes], name, { lastModified: state.lastModified }); },
  };
  if (writable) {
    handle.createWritable = async () => {
      const chunks = [];
      return {
        async write(data) { chunks.push(new Uint8Array(await new Blob([data]).arrayBuffer())); },
        async close() { state.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()); state.lastModified += 1; },
        async abort() {},
      };
    };
  }
  return handle;
}

function fakeDirectory() {
  const files = new Map();
  const directories = new Map();
  return {
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!directories.has(name)) { if (!create) throw new Error('missing'); directories.set(name, fakeDirectory()); }
      return directories.get(name);
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) { if (!create) throw new Error('missing'); files.set(name, fakeFileHandle(name, new Uint8Array(0))); }
      return files.get(name);
    },
    async removeEntry(name) { files.delete(name); },
  };
}

async function setup({ writable = true } = {}) {
  const flac = await fixture('audio-flac.flac');
  const wav = await fixture('audio-wav.wav');
  const handles = { f: fakeFileHandle('song.flac', flac, { writable }), w: fakeFileHandle('take.wav', wav, { writable }) };
  const tracks = new Map([
    ['f', { id: 'f', name: 'song.flac', path: 'song.flac', lastModified: 1000, title: null }],
    ['w', { id: 'w', name: 'take.wav', path: 'take.wav', lastModified: 1000, title: null }],
  ]);
  const updates = [];
  const ctx = {
    queue: { current: () => 'f' },
    library: {
      getTrack: id => tracks.get(id) ?? null,
      fileFor: async track => handles[track.id].getFile(),
      handleFor: async track => handles[track.id],
      updateTrack: async (id, patch) => { updates.push([id, patch]); },
    },
  };
  const root = fakeDirectory();
  return { ctx, handles, updates, handler: createEditTagsHandler(ctx, { saveOptions: { backupRoot: async () => root } }) };
}

test('track.edit_tags diff lists the change and skips WAV by name', async () => {
  const { handler } = await setup();
  const input = { ids: ['f', 'w'], patch: { title: 'New' } };
  const diff = await handler.diff(input, {});
  assert.equal(diff.title, 'Edit tags of 2 files?');
  assert.equal(diff.summary, '1 of 2 files change.');
  assert.deepEqual(diff.lines, ['Title: set to "New" in 1 file']);
  assert.equal(diff.unchanged, false);
  assert.equal(diff.approveLabel, 'Write tags');
  const skipped = diff.files.filter(f => f.skipped);
  assert.deepEqual(skipped.map(f => f.name), ['take.wav']);
  assert.match(skipped[0].reason, /WAV/);
});

test('track.edit_tags run writes through the handle, verifies, and updates the index', async () => {
  const { handler, handles, updates } = await setup();
  const input = { ids: ['f', 'w'], patch: { title: 'New', rating: 4 } };
  const progress = [];
  await handler.diff(input, {});
  const outcome = await handler.run(input, { onProgress: (done, total) => progress.push(`${done}/${total}`) });
  assert.deepEqual(outcome.results.map(r => [r.id, r.status]), [['f', 'written'], ['w', 'skipped']]);
  assert.equal(outcome.summary, '1 written, 1 skipped.');
  assert.deepEqual(progress, ['1/2', '2/2']);
  assert.equal((await readTags(await handles.f.getFile())).title, 'New');
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 'f');
  assert.equal(updates[0][1].title, 'New');
  assert.equal(updates[0][1].rating, 4);
  assert.equal(updates[0][1].lastModified, 1001);
});

test('track.edit_tags without a writable handle offers an edited copy to download', async () => {
  const { handler, handles } = await setup({ writable: false });
  const input = { ids: ['f'], patch: { album: 'Copy' } };
  const diff = await handler.diff(input, {});
  assert.equal(diff.title, 'Edit tags of song.flac?');
  assert.deepEqual(diff.lines, ['Album: (empty) to "Copy"']);
  assert.equal(diff.approveLabel, 'Make edited copies');
  assert.ok(diff.notes.some(n => /cannot write/.test(n)));
  const outcome = await handler.run(input, {});
  assert.equal(outcome.results[0].status, 'download');
  assert.equal(JSON.parse(JSON.stringify(outcome.results[0])).make, undefined, 'the maker is not serialised for agents');
  const copy = await outcome.results[0].make();
  assert.equal((await readTags(copy)).album, 'Copy');
  assert.equal(handles.f.state.lastModified, 1000, 'the original file is untouched');
});

test('track.edit_tags with no ids edits the playing track, and cover art travels in the context', async () => {
  const { handler } = await setup();
  const input = { patch: {} };
  const picture = { mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) };
  const diff = await handler.diff(input, { picture });
  assert.equal(diff.title, 'Edit tags of song.flac?');
  assert.ok(diff.lines.some(line => line.startsWith('Cover art:')));
});
