// Regression tests for review findings N5, N17, N18, N19 and N40 (engine),
// and the `ended` event the shell needs for N3. Review: plan/review-fable-2026-11-17.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNakliAmpEngine } from '../engine/nakliamp-engine.mjs';
import { fakeBuffer, fakeContext } from './audio-fakes.mjs';

const file = (name, seconds) => new File([new Uint8Array([seconds, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])], name);
const noNative = () => { throw Object.assign(new Error('no element in Node'), { code: 'ERR_NAKLIAMP_NATIVE_UNSUPPORTED' }); };

/** A software decoder that decodes every file to `seconds` of stereo at `rate`. */
const pcm = (seconds = 1, rate = 44100) => ({
  name: 'test pcm',
  sniff: () => 'aiff',
  decode: () => ({ sampleRate: rate, channels: [new Float32Array(seconds * rate), new Float32Array(seconds * rate)], frames: seconds * rate }),
});

/** The engine on the software rung (R3), with every context recorded. */
function softwareEngine(decoder = pcm()) {
  const contexts = [];
  const engine = createNakliAmpEngine({
    nativeAudioFactory: noNative,
    softwareDecoders: [decoder],
    audioContextFactory: () => {
      const context = fakeContext({ decode: null });
      // AudioBuffer accepts 3,000 to 768,000 Hz in browsers; the fake does not check.
      const make = context.createBuffer;
      context.createBuffer = (channels, length, rate) => {
        if (rate < 3000 || rate > 768000) throw Object.assign(new Error(`rate ${rate} not supported`), { name: 'NotSupportedError' });
        return make(channels, length, rate);
      };
      contexts.push(context);
      return context;
    },
  });
  return { engine, contexts };
}

const lastSource = context => context.sources.at(-1);

test('N5: a software-route track that ends reports ended at its duration, not paused at 0', async () => {
  const { engine, contexts } = softwareEngine();
  const ended = [];
  engine.on('ended', detail => ended.push(detail));
  const loaded = await engine.load(file('a.aiff', 1));
  assert.equal(loaded.path, 'r3');
  await engine.play();
  const context = contexts.at(-1);
  context.currentTime = 1;
  lastSource(context).onended();
  const state = engine.state();
  assert.equal(state.status, 'playing', 'the track ended; the person did not pause it');
  assert.equal(state.clock.playing, false);
  assert.equal(state.clock.ended, true);
  assert.equal(state.clock.positionS, 1, 'position holds at the duration');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].path, 'r3');
  // Play again starts from the top.
  await engine.play();
  assert.equal(lastSource(context).started.offset, 0);
  assert.equal(engine.state().clock.ended, false);
  engine.destroy();
});

test('N18: a source stopped by a seek cannot end the track or flip it to paused', async () => {
  const { engine, contexts } = softwareEngine(pcm(4));
  const ended = [];
  engine.on('ended', detail => ended.push(detail));
  await engine.load(file('a.aiff', 4));
  await engine.play();
  const context = contexts.at(-1);
  const first = lastSource(context);
  const handler = first.onended;
  await engine.seek(2);
  assert.notEqual(lastSource(context), first, 'the seek built a new source');
  // Chrome may still fire `ended` on the stopped source.
  handler?.();
  first.onended?.();
  const state = engine.state();
  assert.equal(state.status, 'playing');
  assert.equal(state.clock.playing, true);
  assert.equal(ended.length, 0);
  engine.destroy();
});

test('N19: mute holds across a track change on the software route', async () => {
  const { engine, contexts } = softwareEngine();
  await engine.load(file('a.aiff', 1));
  engine.setMuted(true);
  engine.setVolume(0.5);
  await engine.load(file('b.aiff', 1));
  const state = engine.state();
  assert.equal(state.clock.muted, true);
  assert.equal(state.clock.volume, 0.5);
  const gain = contexts.at(-1).gains[0];
  assert.equal(gain.gain.value, 0, 'the new track is silent while muted');
  engine.destroy();
});

test('N19: mute holds across a track change on the native element route', async () => {
  const elements = [];
  const element = () => {
    const listeners = new Map();
    const audio = {
      readyState: 1, duration: 3, currentTime: 0, volume: 1, muted: false, paused: true, ended: false,
      canPlayType: () => 'maybe',
      play: async () => { audio.paused = false; },
      pause: () => { audio.paused = true; },
      addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      removeEventListener: () => {},
      removeAttribute: () => {},
      load: () => {},
      fire: type => (listeners.get(type) ?? []).forEach(fn => fn()),
    };
    elements.push(audio);
    return audio;
  };
  const engine = createNakliAmpEngine({ nativeAudioFactory: element, audioContextFactory: () => fakeContext({ decode: null }) });
  const ended = [];
  engine.on('ended', detail => ended.push(detail));
  const loaded = await engine.load(file('a.mp3', 3));
  assert.equal(loaded.path, 'r2');
  engine.setMuted(true);
  await engine.load(file('b.mp3', 3));
  assert.equal(elements.at(-1).muted, true, 'the new element starts muted');
  assert.equal(engine.state().clock.muted, true);
  // N3: the element's own ended event reaches the engine's `ended` event.
  await engine.play();
  elements.at(-1).currentTime = 3;
  elements.at(-1).ended = true;
  elements.at(-1).fire('ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].path, 'r2');
  assert.equal(engine.state().clock.ended, true);
  engine.destroy();
});

test('N40: a sample rate the AudioContext refuses closes that context', async () => {
  const { engine, contexts } = softwareEngine(pcm(1, 1));
  await assert.rejects(engine.load(file('a.aiff', 1)));
  assert.ok(contexts.length >= 1);
  assert.ok(contexts.every(context => context.state === 'closed'), `context states: ${contexts.map(c => c.state)}`);
  engine.destroy();
});

/** The engine on the gapless lane, with each decode held until released. */
function laneEngine() {
  const contexts = [];
  const gates = [];
  let gated = false;
  const decode = async (arrayBuffer, context) => {
    if (gated) await new Promise(resolve => gates.push(resolve));
    return fakeBuffer(2, new Uint8Array(arrayBuffer)[0] * context.sampleRate, context.sampleRate);
  };
  const engine = createNakliAmpEngine({
    audioContextFactory: () => { const context = fakeContext({ decode }); contexts.push(context); return context; },
  });
  return { engine, contexts, gates, gate: on => { gated = on; } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('N17: a preload still decoding when the next track is loaded does not start that track twice', async () => {
  const { engine, contexts, gates, gate } = laneEngine();
  const advanced = [];
  engine.on('track-advanced', detail => advanced.push(detail.name));
  engine.setDsp({ gapless: 'always' });
  await engine.load(file('a.flac', 2), { albumKey: 'x', trackNo: 1 });
  await engine.play();
  gate(true);
  const preloading = engine.preload(file('b.flac', 2), { albumKey: 'x', trackNo: 2 });
  await settle();
  // A ends before B finished decoding; the shell loads B itself.
  contexts[0].currentTime = 3;
  const loading = engine.load(file('b.flac', 2), { albumKey: 'x', trackNo: 2 });
  await settle();
  while (gates.length) { gates.shift()(); await settle(); }
  const result = await preloading;
  await loading;
  engine.state();
  assert.equal(result.joined, false, `the stale preload joined: ${JSON.stringify(result)}`);
  assert.deepEqual(advanced, [], 'the engine never advanced by itself');
  assert.equal(engine.state().media.name, 'b.flac');
  engine.destroy();
});

test('N3: the lane reports ended from its source callback and from the watch timer', async () => {
  const { engine, contexts } = laneEngine();
  engine.setDsp({ gapless: 'always' });
  const ended = [];
  engine.on('ended', detail => ended.push(detail));
  await engine.load(file('a.flac', 2));
  await engine.play();
  const context = contexts[0];
  context.currentTime = 5;
  // No source callback: the watch timer finds the end on its own.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ended.length, 1, 'the watch timer reported the end');
  assert.equal(ended[0].path, 'lane');
  assert.equal(engine.state().clock.ended, true);
  // The source callback for the same track does not report it twice.
  lastSource(context).onended?.();
  assert.equal(ended.length, 1);
  engine.destroy();
});

test('N3: the lane source callback reports the end without any polling', async () => {
  const { engine, contexts } = laneEngine();
  engine.setDsp({ gapless: 'always' });
  const ended = [];
  engine.on('ended', detail => ended.push(detail));
  await engine.load(file('a.flac', 2));
  await engine.play();
  contexts[0].currentTime = 2.1;
  lastSource(contexts[0]).onended();
  assert.equal(ended.length, 1);
  engine.destroy();
});
