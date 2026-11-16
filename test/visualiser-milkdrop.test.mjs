// Milkdrop (parity row V3). Run: node --test test/visualiser-milkdrop.test.mjs
//
// Butterchurn needs WebGL 2 and WebAssembly; nothing here touches either. The
// pure parts (registry, preset rotation, support check, preset parsing) are
// tested directly, and the lifetime parts run against a fake Butterchurn that
// records what it was asked to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MODES, MODE_IDS, modeById, isAnimated } from '../app/visualiser/modes.mjs';
import {
  checkSupport, isSupported, createPresetCycler, parsePresetJson, createMilkdrop,
  DEFAULT_BLEND_S, REDUCED_MOTION_INTERVAL_FACTOR,
} from '../app/visualiser/milkdrop.mjs';
import { createVisualiser } from '../app/visualiser/driver.mjs';
import { PRESETS } from '../vendor/butterchurn/presets-3.0.0-beta.4.mjs';

const root = new URL('../', import.meta.url);

// ----------------------------------------------------------- fakes ----

function fakeCanvas() {
  const context = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : () => {}),
    set: (target, name, value) => { target[name] = value; return true; },
  });
  return { clientWidth: 320, clientHeight: 120, width: 320, height: 120, getContext: () => context };
}

function fakeScheduler() {
  const log = { frames: [], timeouts: [] };
  let nextId = 0;
  const saved = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.requestAnimationFrame = callback => { const id = (nextId += 1); log.frames.push({ id, callback }); return id; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = callback => { const id = (nextId += 1); log.timeouts.push({ id, callback }); return id; };
  globalThis.clearTimeout = () => {};
  log.restore = () => Object.assign(globalThis, saved);
  return log;
}

function clock(start = 1000) {
  let time = start;
  const now = () => time;
  now.advance = ms => { time += ms; };
  return now;
}

/** A Butterchurn stand-in that records calls and never needs a GPU. */
function fakeButterchurn({ failNames = [] } = {}) {
  const log = { created: [], loads: [], connects: [], disconnects: [], sizes: [], renders: [], lost: 0 };
  const Butterchurn = {
    createVisualizer(audioContext, canvas, opts) {
      log.created.push({ audioContext, canvas, opts });
      return {
        connectAudio: node => log.connects.push(node),
        disconnectAudio: node => log.disconnects.push(node),
        async loadPreset(preset, blend) {
          if (failNames.includes(preset.__name)) throw new Error(`cannot compile ${preset.__name}`);
          log.loads.push({ name: preset.__name, blend });
        },
        setRendererSize: (width, height) => log.sizes.push([width, height]),
        render: opts => log.renders.push(opts),
        loseGLContext: () => { log.lost += 1; },
      };
    },
  };
  return { Butterchurn, log };
}

const fakePresets = names => names.map(name => ({ name, preset: { __name: name, baseVals: {}, shapes: [], waves: [], init_eqs_eel: '' } }));
const okSupport = () => ({ ok: true });
const flush = () => new Promise(resolve => setImmediate(resolve));

// -------------------------------------------------------- registry ----

test('Milkdrop is registered after the 29 drawn modes and before None', () => {
  assert.ok(MODE_IDS.includes('milkdrop'));
  const index = MODE_IDS.indexOf('milkdrop');
  assert.equal(MODES[index].label, 'Milkdrop');
  assert.equal(MODES.slice(0, index).filter(mode => mode.draw).length, 29, 'the 29 drawn modes come first');
  assert.equal(MODE_IDS[index - 1], 'stereo');
  assert.equal(MODE_IDS[index + 1], 'none');
  assert.equal(isAnimated(modeById('milkdrop')), true);
  assert.equal(isAnimated(modeById('none')), false);
  assert.equal(isAnimated(modeById('bars')), true);
});

// --------------------------------------------------- preset cycler ----

test('the preset cycler changes only after a full interval, on an injected clock', () => {
  const now = clock();
  const cycler = createPresetCycler({ count: 3, intervalMs: 20000, now });
  assert.equal(cycler.index, 0);
  assert.equal(cycler.due(), false);
  now.advance(19999);
  assert.equal(cycler.due(), false);
  now.advance(1);
  assert.equal(cycler.due(), true);
  assert.equal(cycler.advance(), 1);
  assert.equal(cycler.due(), false, 'advancing restarts the interval');
  assert.equal(cycler.advance(), 2);
  assert.equal(cycler.advance(), 0, 'wraps forward');
  assert.equal(cycler.advance(-1), 2, 'wraps backward');
  now.advance(15000);
  cycler.hold();
  now.advance(15000);
  assert.equal(cycler.due(), false, 'hold restarts the interval without moving');
});

test('the cycler reads its interval live and never rotates a single preset', () => {
  const now = clock();
  let reduced = false;
  const cycler = createPresetCycler({ count: 2, intervalMs: () => 1000 * (reduced ? 3 : 1), now });
  reduced = true;
  now.advance(1000);
  assert.equal(cycler.due(), false, 'reduced motion lengthened the interval');
  now.advance(2000);
  assert.equal(cycler.due(), true);

  const single = createPresetCycler({ count: 1, intervalMs: 10, now });
  now.advance(100000);
  assert.equal(single.due(), false);
  assert.throws(() => createPresetCycler({ count: -1, intervalMs: 10, now }), TypeError);
});

// --------------------------------------------------------- support ----

test('a canvas without WebGL 2 is refused by name', () => {
  const noGl = checkSupport({ createCanvas: () => ({ getContext: () => null }), wasm: { Module: function Module() {} } });
  assert.equal(noGl.ok, false);
  assert.match(noGl.reason, /WebGL 2/);
  assert.equal(isSupported({ createCanvas: () => ({ getContext: () => null }) }), false);

  const throwing = checkSupport({ createCanvas: () => { throw new Error('no canvas'); } });
  assert.match(throwing.reason, /WebGL 2/);

  const absent = checkSupport({ createCanvas: () => null });
  assert.match(absent.reason, /WebGL 2/);
});

test('missing or policy-blocked WebAssembly is refused by name', () => {
  let lost = 0;
  const gl = { getExtension: () => ({ loseContext: () => { lost += 1; } }) };
  const canvas = () => ({ getContext: kind => (kind === 'webgl2' ? gl : null) });

  assert.match(checkSupport({ createCanvas: canvas, wasm: null }).reason, /WebAssembly/);
  const blocked = checkSupport({
    createCanvas: canvas,
    wasm: { Module: function Module() { throw new Error('Refused to compile'); } },
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /security policy/);

  assert.deepEqual(checkSupport({ createCanvas: canvas, wasm: { Module: function Module() {} } }), { ok: true });
  assert.ok(lost >= 3, 'the probe WebGL context was not released');
});

test('createMilkdrop throws the support reason and loads nothing', () => {
  let loaded = false;
  assert.throws(() => createMilkdrop({
    canvas: fakeCanvas(),
    audioContext: {},
    sourceNode: {},
    support: () => ({ ok: false, reason: 'Milkdrop needs WebGL 2, which this browser or device does not provide.' }),
    loadButterchurn: async () => { loaded = true; },
  }), /WebGL 2/);
  assert.equal(loaded, false);
});

// --------------------------------------------------------- presets ----

test('preset files from disk are checked before Butterchurn sees them', () => {
  assert.throws(() => parsePresetJson('{not json'), /not valid JSON/);
  assert.throws(() => parsePresetJson('{"a":1}'), /not a Butterchurn preset/);
  assert.throws(() => parsePresetJson(JSON.stringify({ baseVals: {}, shapes: [], waves: [], init_eqs_str: '' })), /older Butterchurn 2 format/);
  const preset = parsePresetJson(JSON.stringify(PRESETS[0].preset));
  assert.ok(preset.baseVals);
});

test('the vendored preset set is ten Butterchurn 3 presets', () => {
  assert.equal(PRESETS.length, 10);
  assert.equal(new Set(PRESETS.map(entry => entry.name)).size, 10);
  for (const { name, preset } of PRESETS) {
    assert.doesNotThrow(() => parsePresetJson(preset), name);
  }
});

test('the single-file builder will inline Butterchurn and leave its source unrewritten', async () => {
  // Same pattern as scripts/build-single-file.mjs SPECIFIER.
  const SPECIFIER = /(?:from\s*|import\s*|new\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
  const milkdrop = await readFile(new URL('app/visualiser/milkdrop.mjs', root), 'utf8');
  const found = [...milkdrop.matchAll(SPECIFIER)].map(match => match[2]);
  assert.deepEqual(found.sort(), [
    '../../vendor/butterchurn/butterchurn-3.0.0-beta.5.min.mjs',
    '../../vendor/butterchurn/presets-3.0.0-beta.4.mjs',
  ]);
  for (const file of ['butterchurn-3.0.0-beta.5.min.mjs', 'presets-3.0.0-beta.4.mjs']) {
    const source = await readFile(new URL(`vendor/butterchurn/${file}`, root), 'utf8');
    assert.equal([...source.matchAll(SPECIFIER)].length, 0, `${file} holds a relative specifier the loader would rewrite`);
  }
  const vendored = await readFile(new URL('vendor/butterchurn/butterchurn-3.0.0-beta.5.min.mjs', root), 'utf8');
  assert.equal(/new Function/.test(vendored), true, 'sanity: the JS preset path exists');
  assert.match(milkdrop, /onlyUseWASM: true/, 'presets must compile to WebAssembly, never through new Function');
});

// ------------------------------------------------ milkdrop lifetime ----

test('Milkdrop taps the source, shows the first preset without a blend, and rotates on the clock', async () => {
  const { Butterchurn, log } = fakeButterchurn();
  const now = clock();
  const context = {};
  const source = { context };
  const milkdrop = createMilkdrop({
    canvas: fakeCanvas(), audioContext: context, sourceNode: source,
    intervalS: 10, now, support: okSupport,
    loadButterchurn: async () => Butterchurn,
    loadPresets: async () => fakePresets(['a', 'b', 'c']),
  });
  assert.equal(milkdrop.render({ width: 320, height: 120, elapsedS: 0.016 }), false, 'rendered before loading');
  await milkdrop.ready;
  assert.equal(log.created[0].opts.onlyUseWASM, true);
  assert.deepEqual(log.connects, [source]);
  assert.deepEqual(log.loads, [{ name: 'a', blend: 0 }]);
  assert.equal(milkdrop.presetName(), 'a');

  assert.equal(milkdrop.render({ width: 320, height: 120, elapsedS: 0.016 }), true);
  assert.deepEqual(log.sizes, [], 'resized when nothing changed');
  milkdrop.render({ width: 640, height: 240, elapsedS: 0.016 });
  assert.deepEqual(log.sizes, [[640, 240]]);
  assert.deepEqual(log.renders.at(-1), { elapsedTime: 0.016 });

  now.advance(10000);
  milkdrop.render({ width: 640, height: 240, elapsedS: 0.016 });
  await flush();
  assert.deepEqual(log.loads.at(-1), { name: 'b', blend: DEFAULT_BLEND_S });
  assert.equal(milkdrop.presetName(), 'b');

  assert.equal(await milkdrop.nextPreset(-1), 'a');
});

test('Milkdrop moves its tap between analysers and never crosses contexts', async () => {
  const { Butterchurn, log } = fakeButterchurn();
  const context = {};
  const first = { context };
  const second = { context };
  const milkdrop = createMilkdrop({
    canvas: fakeCanvas(), audioContext: context, sourceNode: first, support: okSupport,
    loadButterchurn: async () => Butterchurn, loadPresets: async () => fakePresets(['a']),
  });
  await milkdrop.ready;
  assert.equal(milkdrop.setSource(first), true);
  assert.equal(log.connects.length, 1, 'reconnected the same node');
  milkdrop.setSource(second);
  assert.deepEqual(log.disconnects, [first]);
  assert.deepEqual(log.connects, [first, second]);
  assert.equal(milkdrop.setSource({ context: {} }), false, 'accepted a node from another AudioContext');
  milkdrop.pause();
  assert.deepEqual(log.disconnects, [first, second]);
  milkdrop.destroy();
  assert.equal(log.lost, 1);
  assert.equal(milkdrop.render({ width: 1, height: 1 }), false);
});

test('a preset that fails to compile is skipped; a preset file from disk holds the rotation', async () => {
  const { Butterchurn, log } = fakeButterchurn({ failNames: ['a'] });
  const now = clock();
  const milkdrop = createMilkdrop({
    canvas: fakeCanvas(), audioContext: {}, sourceNode: {}, intervalS: 10, now, support: okSupport,
    loadButterchurn: async () => Butterchurn, loadPresets: async () => fakePresets(['a', 'b']),
  });
  await milkdrop.ready;
  assert.equal(milkdrop.presetName(), 'b');

  now.advance(9000);
  const fromDisk = { __name: 'disk', baseVals: {}, shapes: [], waves: [], init_eqs_eel: '' };
  assert.equal(await milkdrop.loadPresetJson(JSON.stringify(fromDisk), 'My preset'), 'My preset');
  now.advance(9000);
  milkdrop.render({ width: 320, height: 120 });
  await flush();
  assert.equal(log.loads.at(-1).name, 'disk', 'rotation replaced the loaded preset before its interval');
  await assert.rejects(milkdrop.loadPresetJson('{"init_eqs_str":""}'), /not a Butterchurn preset/);
});

test('when every preset fails, ready rejects', async () => {
  const { Butterchurn } = fakeButterchurn({ failNames: ['a', 'b'] });
  const milkdrop = createMilkdrop({
    canvas: fakeCanvas(), audioContext: {}, sourceNode: {}, support: okSupport,
    loadButterchurn: async () => Butterchurn, loadPresets: async () => fakePresets(['a', 'b']),
  });
  await assert.rejects(milkdrop.ready, /cannot compile/);
});

// ------------------------------------------------- driver behaviour ----

function fakeMilkdropFactory() {
  const log = { created: 0, renders: [], sources: [], pauses: 0, destroyed: 0 };
  let rejectReady;
  const factory = ({ audioContext }) => {
    log.created += 1;
    return {
      audioContext,
      ready: new Promise((resolve, reject) => { rejectReady = reject; }),
      setSource: node => { log.sources.push(node); return true; },
      render: opts => log.renders.push(opts),
      pause: () => { log.pauses += 1; },
      destroy: () => { log.destroyed += 1; },
      presetName: () => 'a', presetNames: () => ['a'],
      nextPreset: async () => 'b', loadPresetJson: async () => 'disk',
    };
  };
  log.reject = error => rejectReady(error);
  return { factory, log };
}

test('v cycles from Stereo into Milkdrop, which renders through its own path', () => {
  const scheduler = fakeScheduler();
  try {
    const { factory, log } = fakeMilkdropFactory();
    const analyser = { context: {} };
    const visualiser = createVisualiser({
      canvas: fakeCanvas(), getAnalyser: () => analyser,
      milkdropFactory: factory, milkdropSupport: okSupport, now: clock(),
    });
    visualiser.setMode('stereo');
    assert.equal(visualiser.cycle(1), 'milkdrop');
    assert.ok(visualiser.modes().some(mode => mode.id === 'milkdrop' && mode.label === 'Milkdrop'));
    assert.equal(visualiser.running, true);
    assert.equal(visualiser.milkdrop(), null, 'controls exist before Milkdrop ran');

    scheduler.frames.at(-1).callback();
    assert.equal(log.created, 1);
    assert.deepEqual(log.sources, [analyser]);
    assert.equal(log.renders.length, 1);
    assert.equal(log.renders[0].width, 320);
    assert.equal(visualiser.milkdrop().presetName(), 'a');

    scheduler.frames.at(-1).callback();
    assert.equal(log.created, 1, 'a second instance was made for the same context');

    assert.equal(visualiser.cycle(1), 'none');
    assert.ok(log.pauses >= 1, 'leaving Milkdrop kept the audio tap connected');
  } finally {
    scheduler.restore();
  }
});

test('an unsupported browser is refused on selection and lands on None', () => {
  const scheduler = fakeScheduler();
  try {
    const errors = [];
    let probes = 0;
    let created = 0;
    const visualiser = createVisualiser({
      canvas: fakeCanvas(), getAnalyser: () => ({ context: {} }),
      onError: error => errors.push(error.message),
      milkdropFactory: () => { created += 1; },
      milkdropSupport: () => { probes += 1; return { ok: false, reason: 'Milkdrop needs WebGL 2, which this browser or device does not provide.' }; },
    });
    visualiser.setMode('bars');
    assert.equal(visualiser.setMode('milkdrop'), 'none');
    assert.equal(visualiser.mode(), 'none');
    assert.equal(visualiser.running, false);
    assert.match(errors[0], /WebGL 2/);
    assert.equal(created, 0);
    visualiser.setMode('milkdrop');
    assert.equal(probes, 1, 'the WebGL probe ran again');
  } finally {
    scheduler.restore();
  }
});

test('a Milkdrop load failure falls back to None and drops the instance', async () => {
  const scheduler = fakeScheduler();
  try {
    const { factory, log } = fakeMilkdropFactory();
    const errors = [];
    const visualiser = createVisualiser({
      canvas: fakeCanvas(), getAnalyser: () => ({ context: {} }),
      onError: error => errors.push(error.message),
      milkdropFactory: factory, milkdropSupport: okSupport, now: clock(),
    });
    visualiser.setMode('milkdrop');
    scheduler.frames.at(-1).callback();
    log.reject(new Error("Milkdrop needs WebAssembly to run preset equations, and this page's security policy blocks it."));
    await flush();
    assert.equal(visualiser.mode(), 'none');
    assert.equal(log.destroyed, 1);
    assert.match(errors[0], /security policy/);
    assert.equal(visualiser.milkdrop(), null);
  } finally {
    scheduler.restore();
  }
});

test('reduced motion slows Milkdrop rather than stopping it', () => {
  const scheduler = fakeScheduler();
  try {
    const { factory, log } = fakeMilkdropFactory();
    const visualiser = createVisualiser({
      canvas: fakeCanvas(), getAnalyser: () => ({ context: {} }), reducedMotion: () => true,
      milkdropFactory: factory, milkdropSupport: okSupport, now: clock(),
    });
    visualiser.setMode('milkdrop');
    assert.equal(scheduler.timeouts.length, 1, 'reduced motion should schedule by timeout');
    scheduler.timeouts.at(-1).callback();
    assert.equal(log.renders.length, 1);
    assert.equal(log.renders[0].elapsedS, 1 / 30);
    assert.equal(scheduler.timeouts.length, 2, 'Milkdrop stopped under reduced motion');
    assert.ok(REDUCED_MOTION_INTERVAL_FACTOR > 1);
  } finally {
    scheduler.restore();
  }
});

test('with no analyser, Milkdrop is paused and nothing is created', () => {
  const scheduler = fakeScheduler();
  try {
    const { factory, log } = fakeMilkdropFactory();
    const visualiser = createVisualiser({
      canvas: fakeCanvas(), getAnalyser: () => null,
      milkdropFactory: factory, milkdropSupport: okSupport, now: clock(),
    });
    visualiser.setMode('milkdrop');
    scheduler.frames.at(-1).callback();
    assert.equal(log.created, 0);
    assert.equal(visualiser.running, true, 'Milkdrop gave up while waiting for playback');
  } finally {
    scheduler.restore();
  }
});
