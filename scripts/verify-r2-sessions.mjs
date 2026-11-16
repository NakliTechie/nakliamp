import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNakliAmpEngine } from '../engine/nakliamp-engine.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = await readFile(resolve(root, 'test/fixtures/audio-mp3.mp3'));
const mp3 = new File([bytes], 'audio-mp3.mp3', { type: 'audio/mpeg' });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class FakeAudio {
  constructor() {
    this.readyState = 0;
    this.duration = 1;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.volume = 1;
    this.muted = false;
    this.paused = true;
    this.listeners = new Map();
  }
  canPlayType() { return 'probably'; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  removeAttribute() {}
  load() {
    if (this.readyState >= 1) return;
    queueMicrotask(() => {
      this.readyState = 1;
      for (const listener of this.listeners.get('loadedmetadata') || []) listener();
    });
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

let leakedUrl = null;
const throwingFactoryPlayer = createNakliAmpEngine({
  forcePath: 'r2',
  nativeAudioFactory({ url }) {
    leakedUrl = url;
    throw new Error('factory sentinel');
  },
});
let factoryError = null;
try {
  await throwingFactoryPlayer.load(mp3);
} catch (error) {
  factoryError = error;
}
assert(factoryError?.message === 'factory sentinel', 'The native factory failure changed identity.');
assert(leakedUrl?.startsWith('blob:'), 'The factory did not receive an object URL.');
let leakedUrlFetchSucceeded = false;
try {
  const response = await fetch(leakedUrl);
  leakedUrlFetchSucceeded = response.ok;
} catch { /* fetch failure is the expected outcome */ }
assert(!leakedUrlFetchSucceeded, 'The failed R2 factory leaked a fetchable object URL.');

let canPlayThrowUrl = null;
const canPlayThrowPlayer = createNakliAmpEngine({
  forcePath: 'r2',
  nativeAudioFactory({ url }) {
    canPlayThrowUrl = url;
    const audio = new FakeAudio();
    audio.canPlayType = () => { throw new Error('canPlayType sentinel'); };
    return audio;
  },
});
let canPlayError = null;
try {
  await canPlayThrowPlayer.load(mp3);
} catch (error) {
  canPlayError = error;
}
assert(canPlayError?.message === 'canPlayType sentinel', 'The canPlayType failure changed identity.');
let canPlayThrowFetchSucceeded = false;
try {
  const response = await fetch(canPlayThrowUrl);
  canPlayThrowFetchSucceeded = response.ok;
} catch { /* fetch failure is the expected outcome */ }
assert(!canPlayThrowFetchSucceeded, 'The failed canPlayType check leaked a fetchable object URL.');

const racePlayer = createNakliAmpEngine({
  forcePath: 'r2',
  nativeAudioFactory: () => new FakeAudio(),
});
let rejectOlder;
const olderHandle = {
  getFile() {
    return new Promise((_, reject) => { rejectOlder = reject; });
  },
};
const olderLoad = racePlayer.load(olderHandle);
await new Promise(resolve => setTimeout(resolve, 0));
const newerMetadata = await racePlayer.load(mp3);
newerMetadata.audioTrack.codec = 'mutated-load-codec';
newerMetadata.tracks[0].codec = 'mutated-load-track-codec';
rejectOlder(new Error('older handle sentinel'));
let olderError = null;
try {
  await olderLoad;
} catch (error) {
  olderError = error;
}
assert(newerMetadata.path === 'r2', 'The newer R2 media did not load.');
assert(olderError?.code === 'ERR_NAKLIAMP_LOAD_SUPERSEDED', `Older failure code mismatch (${olderError?.code}).`);
assert(racePlayer.state().status === 'ready', `Older failure contaminated status (${racePlayer.state().status}).`);
assert(racePlayer.state().media.name === 'audio-mp3.mp3', 'Older failure replaced the newer media.');
const publicState = racePlayer.state();
publicState.track.codec = 'mutated-public-codec';
publicState.media.name = 'mutated-public-name';
assert(racePlayer.state().track.codec === 'mp3', 'Public R2 track state aliases engine metadata.');
assert(racePlayer.state().media.name === 'audio-mp3.mp3', 'Public R2 media state aliases engine metadata.');

throwingFactoryPlayer.destroy();
canPlayThrowPlayer.destroy();
racePlayer.destroy();

console.log('PASS — R2 sessions: exception-safe URL cleanup; stale rejection isolation; detached public state');
