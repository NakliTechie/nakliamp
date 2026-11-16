// V5: the classic skin face bridge, tested against a fake Webamp store.
//
// The fake store copies the parts of Webamp 2.3.1 the bridge relies on (see
// plan/v1-build/v5-webamp-spike.md): middleware order thunk -> mediaMiddleware ->
// emitter -> custom middlewares, mediaMiddleware calling the media object after
// next(action), and the playlist, media and equalizer reducer fields the bridge reads.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebampBridge, planMoves, entryUrl, keyFromUrl, webampToDb, dbToWebamp, webampTrack,
  analyserProxy, skinFileProblem, curveOf, WEBAMP_BANDS_HZ,
} from '../app/ui/webamp-face.mjs';
import { createQueue } from '../app/player/queue.mjs';
import { mergeSettings, DEFAULT_SETTINGS } from '../app/settings.mjs';

// ------------------------------------------------------------ fakes ----

// The reducer fields the bridge reads (webamp js/reducers/{playlist,media,equalizer}.ts).
const withPl = (s, pl) => ({ ...s, playlist: { ...s.playlist, ...pl } });
const withMedia = (s, m) => ({ ...s, media: { ...s.media, ...m } });
const withEq = (s, e) => ({ ...s, equalizer: { ...s.equalizer, ...e } });
const REDUCERS = {
  ADD_TRACK_FROM_URL: (s, a) => withPl(s, { trackOrder: [...s.playlist.trackOrder, a.id], tracks: { ...s.playlist.tracks, [a.id]: { url: a.url } } }),
  REMOVE_ALL_TRACKS: s => withPl(s, { trackOrder: [], currentTrack: null, tracks: {} }),
  REMOVE_TRACKS: (s, a) => withPl(s, { trackOrder: s.playlist.trackOrder.filter(id => !a.ids.includes(id)) }),
  SET_TRACK_ORDER: (s, a) => withPl(s, { trackOrder: a.trackOrder }),
  PLAY_TRACK: (s, a) => withPl(s, { currentTrack: a.id }),
  BUFFER_TRACK: (s, a) => withPl(s, { currentTrack: a.id }),
  PLAY: s => withMedia(s, { status: 'PLAYING' }),
  IS_PLAYING: s => withMedia(s, { status: 'PLAYING' }),
  PAUSE: s => withMedia(s, { status: 'PAUSED' }),
  SET_VOLUME: (s, a) => withMedia(s, { volume: a.volume }),
  TOGGLE_REPEAT: s => withMedia(s, { repeat: !s.media.repeat }),
  TOGGLE_SHUFFLE: s => withMedia(s, { shuffle: !s.media.shuffle }),
  SET_BAND_VALUE: (s, a) => withEq(s, { sliders: { ...s.equalizer.sliders, [a.band]: a.value } }),
  SET_EQ_ON: s => withEq(s, { on: true }),
  SET_EQ_OFF: s => withEq(s, { on: false }),
};

// What mediaMiddleware calls on the media object after each action.
const loadTrack = (media, a, s, autoPlay) => {
  const url = s.playlist.tracks[a.id]?.url;
  if (url != null) media.loadFromUrl(url, autoPlay);
};
const MEDIA_CALLS = {
  PLAY: m => m.play(),
  PAUSE: m => m.pause(),
  STOP: m => m.stop(),
  SET_VOLUME: (m, a, s) => m.setVolume(s.media.volume),
  SEEK_TO_PERCENT_COMPLETE: (m, a) => m.seekToPercentComplete(a.percent),
  PLAY_TRACK: (m, a, s) => loadTrack(m, a, s, true),
  BUFFER_TRACK: (m, a, s) => loadTrack(m, a, s, false),
  SET_BAND_VALUE: (m, a) => (a.band === 'preamp' ? m.setPreamp(a.value) : m.setEqBand(a.band, a.value)),
  SET_EQ_OFF: m => m.disableEq(),
  SET_EQ_ON: m => m.enableEq(),
};

const applyMoves = (list, moves) => { const w = list.slice(); for (const m of moves) w.splice(m.to, 0, ...w.splice(m.from, 1)); return w; };

function fakeWebamp(bridge) {
  const media = new bridge.MediaClass();
  let state = {
    playlist: { trackOrder: [], currentTrack: null, tracks: {} },
    media: { volume: 78, shuffle: false, repeat: false, status: 'STOPPED' },
    equalizer: { on: true, sliders: Object.fromEntries([...WEBAMP_BANDS_HZ, 'preamp'].map(b => [b, 50])) },
  };
  let nextId = 100;
  const reducer = (s, a) => (REDUCERS[a.type] ? REDUCERS[a.type](s, a) : s);
  const store = { getState: () => state };
  const base = action => { state = reducer(state, action); return action; };
  const custom = bridge.middleware(store)(base);
  // mediaMiddleware (webamp js/mediaMiddleware.ts:58-109): next first, then the media call.
  const mediaMw = action => {
    const result = custom(action);
    MEDIA_CALLS[action.type]?.(media, action, state);
    return result;
  };
  store.dispatch = mediaMw;
  // Construction pushes Webamp's defaults into the media object (mediaMiddleware.ts:13-15).
  media.setVolume(78); media.setBalance(0); media.setPreamp(50);
  media.on('fileLoaded', () => { store.dispatch({ type: 'SET_MEDIA', length: media.duration() }); });
  return {
    store, media,
    appendTracks(tracks) {
      for (const t of tracks) {
        assert.ok(t.metaData && Number.isFinite(t.duration), 'tracks carry tags and duration so Webamp never fetches');
        store.dispatch({ type: 'ADD_TRACK_FROM_URL', url: t.url, id: nextId++ });
      }
    },
    addForeign(url) { const id = nextId++; store.dispatch({ type: 'ADD_TRACK_FROM_URL', url, id }); store.dispatch({ type: 'PLAY_TRACK', id }); return id; },
  };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

function fakeCtx() {
  const calls = [];
  const toasts = [];
  const engineListeners = new Map();
  const engine = {
    s: { path: 'r2', media: { duration: 200 }, clock: { positionS: 12, playing: false, volume: 0.5 } },
    state() { return structuredClone(this.s); },
    analyser: () => null,
    on(type, fn) { if (!engineListeners.has(type)) engineListeners.set(type, new Set()); engineListeners.get(type).add(fn); return () => engineListeners.get(type).delete(fn); },
  };
  const queue = createQueue({ storage: memoryStorage(), random: () => 0.3 });
  let settings = mergeSettings(DEFAULT_SETTINGS, {});
  const settingsFns = new Set();
  const tracks = new Map([1, 2, 3, 4].map(id => [id, { id, title: `Song ${id}`, artist: 'A', album: 'B', durationS: 100 + id }]));
  const ctx = {
    engine, queue, calls, toasts, engineListeners,
    settings: {
      get: () => settings,
      set: patch => { settings = mergeSettings(settings, patch); for (const fn of settingsFns) fn(settings); return settings; },
      on: fn => { settingsFns.add(fn); return () => settingsFns.delete(fn); },
    },
    library: { getTrack: id => tracks.get(id) ?? null },
    run: async (name, input) => {
      calls.push([name, input]);
      if (name === 'player.play') engine.s.clock.playing = true;
      if (name === 'player.pause') engine.s.clock.playing = false;
      if (name === 'player.volume') engine.s.clock.volume = input.level;
      if (name === 'queue.shuffle') queue.setShuffle(input.mode);
      if (name === 'queue.repeat') queue.setRepeat(input.mode);
      if (name === 'eq.enable') ctx.settings.set({ eq: { enabled: input.enabled } });
      return {};
    },
    toast: text => toasts.push(text),
  };
  return ctx;
}

function harness() {
  const ctx = fakeCtx();
  const timers = [];
  const pendingLater = [];
  let clock = 0;
  const bridge = createWebampBridge(ctx, {
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => { timers.length = 0; },
    later: fn => pendingLater.push(fn),
    now: () => clock,
  });
  const webamp = fakeWebamp(bridge);
  return { ctx, bridge, webamp, timers, pendingLater, advance: ms => { clock += ms; }, runLater: () => { while (pendingLater.length) pendingLater.shift()(); } };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const faceKeys = (h) => h.webamp.store.getState().playlist.trackOrder.map(id => h.bridge.keyForId(id));

// ------------------------------------------------------------- pure ----

test('entry URLs round-trip keys and reject other URLs', () => {
  assert.equal(keyFromUrl(entryUrl(17)), '17');
  assert.equal(keyFromUrl(entryUrl('a b/c')), 'a b/c');
  assert.equal(keyFromUrl('blob:https://x/1'), null);
  assert.equal(keyFromUrl(undefined), null);
});

test('slider values map to the ±12 dB scale Webamp uses', () => {
  assert.equal(webampToDb(50), 0);
  assert.equal(webampToDb(0), -12);
  assert.equal(webampToDb(100), 12);
  assert.equal(webampToDb(150), 12);
  assert.equal(dbToWebamp(0), 50);
  assert.equal(dbToWebamp(-12), 0);
  assert.equal(dbToWebamp(6), 75);
  for (const v of [0, 25, 50, 75, 100]) assert.equal(dbToWebamp(webampToDb(v)), v);
});

test('planMoves turns one order into another with splice moves', () => {
  const cases = [[[1, 2, 3, 4], [4, 3, 2, 1]], [[1, 2, 3], [2, 3, 1]], [[1, 2, 3], [1, 2, 3]], [['a', 'b', 'c', 'd', 'e'], ['c', 'a', 'e', 'b', 'd']]];
  for (const [from, to] of cases) assert.deepEqual(applyMoves(from.map(String), planMoves(from, to)), to.map(String));
  assert.deepEqual(planMoves([1, 2, 3], [1, 2, 3]), []);
  assert.equal(planMoves([1, 2], [1, 3]), null);
  assert.equal(planMoves([1, 2], [1]), null);
});

test('webampTrack gives tags and a duration, with fallbacks', () => {
  const t = webampTrack(5, { title: 'T', artist: 'A', album: 'B', durationS: 61.5 });
  assert.deepEqual(t, { url: entryUrl(5), duration: 61.5, defaultName: 'T', metaData: { artist: 'A', title: 'T', album: 'B' } });
  const unknown = webampTrack(6, null);
  assert.equal(unknown.duration, 0);
  assert.equal(unknown.metaData.title, 'Unknown track');
});

test('skinFileProblem accepts .wsz and .zip only, under the size cap', () => {
  assert.equal(skinFileProblem({ name: 'Base.WSZ', size: 1000 }), null);
  assert.equal(skinFileProblem({ name: 'x.zip', size: 1000 }), null);
  assert.match(skinFileProblem({ name: 'x.mp3', size: 1000 }), /\.wsz/);
  assert.match(skinFileProblem({ name: 'x.wsz', size: 64 * 1024 * 1024 }), /32 MB/);
  assert.match(skinFileProblem(null), /No file/);
});

test('analyserProxy reads the current engine analyser and keeps its own fftSize', () => {
  let node = null;
  const proxy = analyserProxy({ analyser: () => node });
  proxy.fftSize = 1024;
  assert.equal(proxy.frequencyBinCount, 512);
  const out = new Uint8Array(4);
  proxy.getByteTimeDomainData(out);
  assert.deepEqual([...out], [128, 128, 128, 128]);
  node = { fftSize: 2, frequencyBinCount: 1, getByteTimeDomainData: a => a.set([10, 20]), getByteFrequencyData: a => a.set([99]) };
  proxy.getByteTimeDomainData(out);
  assert.deepEqual([...out], [10, 20, 128, 128]);
  proxy.getByteFrequencyData(out);
  assert.deepEqual([...out], [99, 0, 0, 0]);
  assert.equal(node.fftSize, 2, 'the engine analyser is never resized');
});

// ----------------------------------------------------------- bridge ----

test('construction defaults never reach NakliAmp; attach projects queue, current entry, volume and EQ', () => {
  const h = harness();
  assert.deepEqual(h.ctx.calls, [], 'Webamp default volume 78 must not change NakliAmp volume');
  h.ctx.queue.set([1, 2, 3], 1);
  h.ctx.settings.set({ eq: { enabled: true, preset: 'custom', custom: [6, 0, 0, 0, 0, 0, 0, 0, 0, -12] } });
  h.bridge.attach(h.webamp);
  const s = h.webamp.store.getState();
  assert.deepEqual(faceKeys(h), h.ctx.queue.snapshot().keys.map(String));
  assert.equal(h.bridge.keyForId(s.playlist.currentTrack), String(h.ctx.queue.snapshot().keys[1]));
  assert.equal(s.media.volume, 50);
  assert.equal(s.equalizer.sliders[60], 75);
  assert.equal(s.equalizer.sliders[16000], 0);
  assert.equal(s.equalizer.on, true);
  assert.deepEqual(h.ctx.calls, [], 'projection causes no commands');
  assert.equal(h.timers.length, 1);
});

test('face transport goes through NakliAmp commands', async () => {
  const h = harness();
  h.ctx.queue.set([1, 2, 3], 0);
  h.bridge.attach(h.webamp);
  h.webamp.store.dispatch({ type: 'PLAY' });
  h.webamp.store.dispatch({ type: 'PAUSE' });
  h.webamp.store.dispatch({ type: 'SEEK_TO_PERCENT_COMPLETE', percent: 40 });
  h.webamp.store.dispatch({ type: 'SET_VOLUME', volume: 30 });
  await flush();
  assert.deepEqual(h.ctx.calls, [
    ['player.play', {}], ['player.pause', {}], ['player.seek', { percent: 40 }], ['player.volume', { level: 0.3 }],
  ]);
});

test('picking an entry in the face jumps the NakliAmp queue', async () => {
  const h = harness();
  h.ctx.queue.set([1, 2, 3], 0);
  h.bridge.attach(h.webamp);
  const third = h.bridge.idForKey(h.ctx.queue.snapshot().keys[2]);
  h.webamp.store.dispatch({ type: 'PLAY_TRACK', id: third });
  await flush();
  assert.equal(h.ctx.queue.snapshot().index, 2);
  assert.deepEqual(h.ctx.calls, [['player.play', {}]]);
});

test('NakliAmp moving on (gapless advance, queue edits) shows in the face without commands', () => {
  const h = harness();
  h.ctx.queue.set([1, 2, 3], 0);
  h.bridge.attach(h.webamp);
  h.ctx.engine.s.clock.playing = true;
  h.ctx.queue.next();
  h.bridge.tick();
  const s = h.webamp.store.getState();
  assert.equal(h.bridge.keyForId(s.playlist.currentTrack), String(h.ctx.queue.snapshot().keys[1]));
  assert.equal(s.media.status, 'PLAYING');
  h.ctx.queue.add([4]);
  assert.deepEqual(faceKeys(h), h.ctx.queue.snapshot().keys.map(String));
  h.ctx.engine.s.clock.playing = false;
  h.bridge.tick();
  assert.equal(h.webamp.store.getState().media.status, 'PAUSED');
  assert.deepEqual(h.ctx.calls, []);
});

test('removing and reordering in the face edits the NakliAmp queue', () => {
  const h = harness();
  h.ctx.queue.set([1, 2, 3, 4], 0);
  h.bridge.attach(h.webamp);
  const keys = h.ctx.queue.snapshot().keys;
  const id = k => h.bridge.idForKey(k);
  h.webamp.store.dispatch({ type: 'REMOVE_TRACKS', ids: [id(keys[1])] });
  assert.deepEqual(h.ctx.queue.snapshot().ids, [1, 3, 4]);
  h.webamp.store.dispatch({ type: 'SET_TRACK_ORDER', trackOrder: [id(keys[3]), id(keys[0]), id(keys[2])] });
  assert.deepEqual(h.ctx.queue.snapshot().ids, [4, 1, 3]);
  assert.deepEqual(faceKeys(h), h.ctx.queue.snapshot().keys.map(String));
  h.webamp.store.dispatch({ type: 'REMOVE_ALL_TRACKS' });
  assert.equal(h.ctx.queue.snapshot().length, 0);
});

test('EQ sliders write NakliAmp settings once per drag, keep the other bands, and the switch maps to eq.enable', async () => {
  const h = harness();
  h.ctx.settings.set({ eq: { enabled: false, preset: 'rock' } });
  h.bridge.attach(h.webamp);
  const rock = curveOf(h.ctx.settings.get().eq);
  h.webamp.store.dispatch({ type: 'SET_BAND_VALUE', band: 600, value: 25 });
  h.webamp.store.dispatch({ type: 'SET_BAND_VALUE', band: 600, value: 75 });
  h.webamp.store.dispatch({ type: 'SET_BAND_VALUE', band: 'preamp', value: 90 });
  assert.equal(h.pendingLater.length, 1, 'one flush per burst');
  h.runLater();
  const eq = h.ctx.settings.get().eq;
  assert.equal(eq.preset, 'custom');
  assert.equal(eq.enabled, false, 'moving a slider does not switch the EQ on');
  assert.deepEqual(eq.custom, rock.map((db, i) => (i === 3 ? 6 : db)));
  h.webamp.store.dispatch({ type: 'SET_EQ_ON' });
  await flush();
  assert.deepEqual(h.ctx.calls.at(-1), ['eq.enable', { enabled: true }]);
  assert.equal(h.ctx.settings.get().eq.enabled, true);
});

test('shuffle stays NakliAmp\'s and repeat mirrors both ways', async () => {
  const h = harness();
  h.ctx.queue.set([1, 2, 3], 0);
  h.bridge.attach(h.webamp);
  h.webamp.store.dispatch({ type: 'TOGGLE_SHUFFLE' });
  await flush();
  assert.equal(h.ctx.queue.snapshot().shuffle, 'tracks');
  assert.equal(h.webamp.store.getState().media.shuffle, false, 'Webamp never picks its own random next');
  h.webamp.store.dispatch({ type: 'TOGGLE_REPEAT' });
  await flush();
  assert.equal(h.ctx.queue.snapshot().repeat, 'all');
  h.ctx.queue.setRepeat('off');
  assert.equal(h.webamp.store.getState().media.repeat, false);
});

test('files opened inside the face are refused and never reach the media object', async () => {
  const h = harness();
  h.ctx.queue.set([1, 2], 0);
  h.bridge.attach(h.webamp);
  h.webamp.addForeign('blob:https://example.test/abc');
  await flush();
  assert.deepEqual(faceKeys(h), h.ctx.queue.snapshot().keys.map(String));
  assert.deepEqual(h.ctx.calls, []);
  assert.equal(h.ctx.toasts.length, 1);
});

test('volume from the face is not overwritten by a projection mid-drag', async () => {
  const h = harness();
  h.bridge.attach(h.webamp);
  h.webamp.store.dispatch({ type: 'SET_VOLUME', volume: 90 });
  h.ctx.engine.s.clock.volume = 0.2;
  h.bridge.tick();
  assert.equal(h.webamp.store.getState().media.volume, 90);
  h.advance(1000);
  h.bridge.tick();
  assert.equal(h.webamp.store.getState().media.volume, 20);
});

test('fileLoaded fires once per loaded track, and detach stops everything', () => {
  const h = harness();
  h.ctx.queue.set([1, 2], 0);
  let loaded = 0;
  h.webamp.media.on('fileLoaded', () => { loaded += 1; });
  let ticks = 0;
  h.webamp.media.on('timeupdate', () => { ticks += 1; });
  h.bridge.attach(h.webamp);
  h.bridge.tick();
  h.bridge.tick();
  assert.equal(loaded, 1);
  assert.equal(ticks, 2);
  assert.equal(h.webamp.media.timeElapsed(), 12);
  assert.equal(h.webamp.media.duration(), 200);
  h.bridge.detach();
  assert.equal(h.timers.length, 0);
  for (const set of h.ctx.engineListeners.values()) assert.equal(set.size, 0);
  h.ctx.queue.add([3]);
  assert.equal(h.webamp.store.getState().playlist.trackOrder.length, 2, 'no projection after detach');
});
