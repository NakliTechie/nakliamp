// L13 several folders: path prefixes, the folder list, forget and rescan.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  libraryPath, splitLibraryPath, inFolder, recordsInFolder, fileHandleFor, createFolderLibrary, FolderError,
} from '../app/library/folders.mjs';

function fakeStore(initial = {}) {
  const meta = new Map(Object.entries(initial.meta ?? {}));
  let tracks = [...(initial.tracks ?? [])];
  let playlists = [...(initial.playlists ?? [])];
  const scans = [];
  return {
    scans,
    meta,
    get tracks() { return tracks; },
    deps: {
      getMeta: async (key, fallback = null) => (meta.has(key) ? meta.get(key) : fallback),
      setMeta: async (key, value) => { meta.set(key, value); },
      allTracks: async () => tracks,
      deleteTracks: async ids => { tracks = tracks.filter(track => !ids.includes(track.id)); return ids.length; },
      allPlaylists: async () => playlists,
      deletePlaylists: async paths => { playlists = playlists.filter(p => !paths.includes(p.path)); return paths.length; },
      scan: async (handle, options) => { scans.push([handle.name, options.folderId]); return { tracks: 0 }; },
    },
  };
}

const dir = (name, extra = {}) => ({ kind: 'directory', name, ...extra });

test('the primary folder keeps plain paths; others get //id/', () => {
  assert.equal(libraryPath(null, 'A/b.mp3'), 'A/b.mp3');
  assert.equal(libraryPath('f1', 'A/b.mp3'), '//f1/A/b.mp3');
  assert.deepEqual(splitLibraryPath('//f1/A/b.mp3'), { folderId: 'f1', relativePath: 'A/b.mp3' });
  assert.deepEqual(splitLibraryPath('A/b.mp3'), { folderId: null, relativePath: 'A/b.mp3' });
  assert.throws(() => libraryPath('../x', 'a'), FolderError);
  assert.equal(inFolder('A/b.mp3', null), true);
  assert.equal(inFolder('//f1/A/b.mp3', null), false);
  assert.equal(inFolder('//f1/A/b.mp3', 'f1'), true);
  assert.equal(inFolder('//f12/A/b.mp3', 'f1'), false);
  const records = [{ path: 'a' }, { path: '//f1/a' }, { path: '//f2/a' }];
  assert.deepEqual(recordsInFolder(records, 'f1').map(r => r.path), ['//f1/a']);
  assert.deepEqual(recordsInFolder(records).map(r => r.path), ['a']);
});

test('a library from before L13 loads its one legacy folder as primary', async () => {
  const legacy = dir('Music');
  const store = fakeStore({ meta: { rootHandle: legacy, rootName: 'Music' } });
  const folders = await createFolderLibrary(store.deps).load();
  assert.deepEqual(folders, [{ id: 'main', name: 'Music', handle: legacy, primary: true }]);
  assert.deepEqual(await createFolderLibrary(fakeStore().deps).load(), []);
});

test('adding folders: first is primary, then f1, f2; the same folder twice is one row', async () => {
  const store = fakeStore();
  const library = createFolderLibrary(store.deps);
  const music = dir('Music', { isSameEntry: async other => other.name === 'Music' });
  const first = await library.add(music);
  assert.equal(first.folder.primary, true);
  assert.equal(first.folder.id, 'main');
  assert.equal(store.meta.get('rootHandle'), music, 'legacy key keeps the primary handle');
  const second = await library.add(dir('Podcasts'));
  assert.equal(second.folder.id, 'f1');
  assert.equal(second.folder.primary, false);
  assert.equal((await library.add(dir('Music'))).added, false);
  assert.equal((await library.load()).length, 2);
  await assert.rejects(library.add({ kind: 'file', name: 'x' }), /Only a folder/);
});

test('forget removes only that folder\'s tracks and playlists; rescan passes its folder id', async () => {
  const store = fakeStore({
    tracks: [{ id: 'a', path: 'A/a.mp3' }, { id: 'b', path: '//f1/B/b.mp3' }],
    playlists: [{ path: 'mix.m3u8' }, { path: '//f1/p.m3u8' }],
  });
  const library = createFolderLibrary(store.deps);
  await library.add(dir('Music'));
  await library.add(dir('Podcasts'));
  await library.rescanAll();
  assert.deepEqual(store.scans, [['Music', null], ['Podcasts', 'f1']]);
  const result = await library.forget('f1');
  assert.deepEqual(result, { removedTracks: 1, removedPlaylists: 1 });
  assert.deepEqual(store.tracks.map(track => track.id), ['a']);
  assert.deepEqual((await library.load()).map(folder => folder.id), ['main']);
  await assert.rejects(library.forget('f9'), /No folder with id f9/);
  // Forgetting the primary clears the legacy key too.
  await library.forget('main');
  assert.equal(store.meta.get('rootHandle'), null);
});

test('rescan without a scan function is refused by name', async () => {
  const store = fakeStore();
  const library = createFolderLibrary({ ...store.deps, scan: null });
  await library.add(dir('Music'));
  await assert.rejects(library.rescan('main'), error => error.code === 'ERR_NAKLIAMP_FOLDER_NO_SCAN');
});

test('file handles resolve through the owning folder', async () => {
  const tree = name => ({
    kind: 'directory',
    name,
    getDirectoryHandle: async segment => tree(`${name}/${segment}`),
    getFileHandle: async segment => ({ kind: 'file', name: segment, where: `${name}/${segment}` }),
  });
  const folders = [{ id: 'main', primary: true, handle: tree('M') }, { id: 'f1', primary: false, handle: tree('P') }];
  assert.equal((await fileHandleFor(folders, 'A/b.mp3')).where, 'M/A/b.mp3');
  assert.equal((await fileHandleFor(folders, '//f1/C/d.mp3')).where, 'P/C/d.mp3');
  await assert.rejects(fileHandleFor(folders, '//f7/x.mp3'), error => error.code === 'ERR_NAKLIAMP_FOLDER_MISSING');
});
