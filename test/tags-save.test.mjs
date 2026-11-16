// saveTagsToHandle safe sequence with in-memory fakes of the File System
// Access and OPFS handles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags } from '../app/library/metadata.mjs';
import { saveTagsToHandle, restoreTagBackup, BACKUP_DIRECTORY, TagSaveError } from '../app/tags/save.mjs';
import { fixture, equalBytes } from './tags-helpers.mjs';

/** A fake FileSystemFileHandle: commits on close, bumps lastModified. */
function fakeFile(name, bytes, { lastModified = 1000, failWrite = false, permission = 'granted', onGetFile } = {}) {
  const state = { bytes, lastModified, writes: 0, getFileCalls: 0 };
  return {
    kind: 'file',
    name,
    state,
    async queryPermission() { return permission; },
    async requestPermission() { return permission; },
    async getFile() {
      state.getFileCalls += 1;
      onGetFile?.(state);
      return new File([state.bytes], name, { lastModified: state.lastModified });
    },
    async createWritable() {
      const chunks = [];
      return {
        async write(data) {
          if (failWrite) throw new Error('disk full');
          chunks.push(new Uint8Array(await new Blob([data]).arrayBuffer()));
        },
        async close() {
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const out = new Uint8Array(total);
          let cursor = 0;
          for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.length; }
          state.bytes = out;
          state.lastModified += 1;
          state.writes += 1;
        },
        async abort() {},
      };
    },
  };
}

function fakeDirectory() {
  const files = new Map();
  const directories = new Map();
  const log = [];
  const directory = {
    files,
    directories,
    log,
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!directories.has(name)) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        directories.set(name, fakeDirectory());
      }
      return directories.get(name);
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('missing', 'NotFoundError');
        files.set(name, fakeFile(name, new Uint8Array(0)));
        log.push(`create ${name}`);
      }
      return files.get(name);
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError');
      log.push(`remove ${name}`);
    },
  };
  return directory;
}

test('saveTagsToHandle writes, verifies and keeps the backup with a record (review N14)', async () => {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original);
  const root = fakeDirectory();
  const result = await saveTagsToHandle(handle, { title: 'Saved', rating: 5 }, { backupRoot: async () => root, expectedLastModified: 1000 });
  assert.equal(result.after.title, 'Saved');
  assert.equal(result.before.title, null);
  assert.equal(handle.state.writes, 1);
  assert.equal(result.lastModified, 1001);
  assert.equal((await readTags(new Blob([handle.state.bytes]))).title, 'Saved');
  const backups = root.directories.get(BACKUP_DIRECTORY);
  assert.deepEqual(backups.log, ['create song.flac'], 'backup made before write and kept, so the write can be undone');
  assert.ok(equalBytes(backups.files.get('song.flac').state.bytes, original));
  assert.equal(result.backup, 'song.flac');
  const record = JSON.parse(new TextDecoder().decode(backups.directories.get('index').files.get('song.flac.json').state.bytes));
  assert.equal(record.status, 'written');
});

test('saveTagsToHandle refuses when lastModified differs from the library record', async () => {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original, { lastModified: 2000 });
  const root = fakeDirectory();
  await assert.rejects(
    saveTagsToHandle(handle, { title: 'x' }, { backupRoot: async () => root, expectedLastModified: 1000 }),
    (error) => error instanceof TagSaveError && error.code === 'changed',
  );
  assert.equal(handle.state.writes, 0);
  assert.equal(root.directories.size, 0, 'no backup made');
});

test('saveTagsToHandle refuses when the file changes while the edit is prepared', async () => {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original, {
    onGetFile(state) { if (state.getFileCalls === 2) state.lastModified += 5; },
  });
  const root = fakeDirectory();
  await assert.rejects(
    saveTagsToHandle(handle, { title: 'x' }, { backupRoot: async () => root }),
    (error) => error.code === 'changed',
  );
  assert.equal(handle.state.writes, 0);
  assert.equal(root.directories.get(BACKUP_DIRECTORY).files.size, 0, 'unused backup removed');
});

test('saveTagsToHandle does not write when the backup cannot be made', async () => {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original);
  await assert.rejects(
    saveTagsToHandle(handle, { title: 'x' }, { backupRoot: async () => { throw new Error('no OPFS'); } }),
    (error) => error.code === 'backup-failed',
  );
  assert.equal(handle.state.writes, 0);
  assert.ok(equalBytes(handle.state.bytes, original));
});

test('saveTagsToHandle keeps the backup when the write fails', async () => {
  const original = await fixture('audio-flac.flac');
  const handle = fakeFile('song.flac', original, { failWrite: true });
  const root = fakeDirectory();
  await assert.rejects(
    saveTagsToHandle(handle, { title: 'x' }, { backupRoot: async () => root }),
    (error) => error.code === 'write-failed' && error.backup === 'song.flac',
  );
  assert.ok(equalBytes(handle.state.bytes, original), 'original untouched');
  assert.ok(root.directories.get(BACKUP_DIRECTORY).files.has('song.flac'));
});

test('a failed verify keeps the backup, and restoreTagBackup puts the original back', async () => {
  const original = await fixture('audio-mp3.mp3');
  const handle = fakeFile('song.mp3', original);
  const root = fakeDirectory();
  const lyingReader = async (blob) => ({ ...(await readTags(blob)), title: 'something else' });
  let failure;
  await assert.rejects(
    saveTagsToHandle(handle, { title: 'Wanted' }, { backupRoot: async () => root, readTags: lyingReader }),
    (error) => { failure = error; return error.code === 'verify-failed'; },
  );
  assert.deepEqual(failure.mismatched, ['title']);
  const backups = root.directories.get(BACKUP_DIRECTORY);
  assert.ok(equalBytes(backups.files.get(failure.backup).state.bytes, original), 'backup holds the original bytes');
  assert.ok(!equalBytes(handle.state.bytes, original), 'the new file was written');

  await restoreTagBackup(handle, failure.backup, { backupRoot: async () => root });
  assert.ok(equalBytes(handle.state.bytes, original), 'original restored');
  assert.equal(backups.files.size, 0);
});

test('a kept backup is not overwritten by the next save of a same-named file', async () => {
  const root = fakeDirectory();
  const backups = await root.getDirectoryHandle(BACKUP_DIRECTORY, { create: true });
  const stale = await backups.getFileHandle('song.flac', { create: true });
  stale.state.bytes = new Uint8Array([1, 2, 3]);
  const handle = fakeFile('song.flac', await fixture('audio-flac.flac'));
  await saveTagsToHandle(handle, { title: 'x' }, { backupRoot: async () => root });
  assert.deepEqual([...backups.files.keys()], ['song.flac', 'song.flac (2)']);
  assert.deepEqual([...backups.files.get('song.flac').state.bytes], [1, 2, 3]);
  assert.ok(backups.log.includes('create song.flac (2)'));
});

test('saveTagsToHandle refuses without permission and for unsupported formats', async () => {
  const root = fakeDirectory();
  const denied = fakeFile('song.flac', await fixture('audio-flac.flac'), { permission: 'denied' });
  await assert.rejects(saveTagsToHandle(denied, { title: 'x' }, { backupRoot: async () => root }), (error) => error.code === 'permission');
  const wav = fakeFile('song.wav', await fixture('audio-wav.wav'));
  await assert.rejects(saveTagsToHandle(wav, { title: 'x' }, { backupRoot: async () => root }), (error) => error.code === 'unsupported' && /WAV/.test(error.message));
  assert.equal(wav.state.writes, 0);
});
