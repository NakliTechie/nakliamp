// The Rivulina hand-off: a file NakliOS sends joins the queue as a transient entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as host from '../app/host.mjs';
import { createQueue, QUEUE_STORAGE_KEY } from '../app/player/queue.mjs';
import { createTransientStore, receiveFiles, isTransientId } from '../app/player/transient.mjs';

function memoryStorage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

/** A stand-in for the NakliOS SDK's files API: it hands over one grant when `send` is called. */
function standInHost() {
  let opener = null;
  const released = [];
  globalThis.naklios = {
    capabilities: { hosted: true },
    files: {
      onOpen(fn) { opener = fn; },
      async read(token) { return { name: 'rivulina-mix.flac', type: 'audio/flac', bytes: new Uint8Array([102, 76, 97, 67, token.length]) }; },
      release(token) { released.push(token); },
    },
  };
  return { send: grant => opener(grant), released };
}

test('a file sent through host.onFiles is queued as a transient entry and becomes current', async () => {
  const fake = standInHost();
  const storage = memoryStorage();
  const queue = createQueue({ storage, isTransient: isTransientId });
  const store = createTransientStore();
  queue.set(['lib-1', 'lib-2'], 0);
  const changes = [];
  queue.onChange((snap, info) => changes.push({ current: snap.current, currentChanged: info.currentChanged }));

  host.onFiles(files => receiveFiles(files, { store, queue }));
  await fake.send({ token: 'tok-1', name: 'rivulina-mix.flac', type: 'audio/flac' });

  const snap = queue.snapshot();
  assert.equal(snap.length, 3);
  assert.ok(isTransientId(snap.current), `current is ${snap.current}`);
  assert.equal(snap.index, 2);
  const record = store.get(snap.current);
  assert.equal(record.transient, true);
  assert.equal(record.path, null);
  assert.equal(record.title, 'rivulina-mix');
  assert.equal(record.file.name, 'rivulina-mix.flac');
  assert.equal(record.file.size, 5);
  // The queue's listener is what loads and plays: it saw the current entry change.
  assert.ok(changes.some(change => change.currentChanged && change.current === snap.current));
  assert.deepEqual(fake.released, ['tok-1']);

  // The stored queue leaves the transient entry out: its File cannot survive a reload.
  const stored = JSON.parse(storage.getItem(QUEUE_STORAGE_KEY));
  assert.deepEqual(stored.entries.map(entry => entry.id), ['lib-1', 'lib-2']);
  assert.ok(stored.index >= 0 && stored.index < 2);
  const reloaded = createQueue({ storage, isTransient: isTransientId });
  assert.deepEqual(reloaded.snapshot().ids, ['lib-1', 'lib-2']);
  delete globalThis.naklios;
});

test('receiveFiles ignores things that are not files and queues several in order', () => {
  const queue = createQueue({ storage: null, isTransient: isTransientId });
  const store = createTransientStore();
  const files = [new File([new Uint8Array(1)], 'a.mp3'), 'not a file', new File([new Uint8Array(2)], 'b.mp3')];
  const added = receiveFiles(files, { store, queue });
  assert.equal(added.length, 2);
  assert.deepEqual(queue.snapshot().ids, added.map(record => record.id));
  assert.equal(queue.current(), added[0].id);
  assert.deepEqual(receiveFiles([], { store, queue }), []);
});
