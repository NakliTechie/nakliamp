// The cliamp modes added for v1.1. Run: node --test test/visualiser-cliamp.test.mjs
//
// Every mode is drawn against a fake 2D context that records each call and each
// style change, so the tests can check three things without a GPU or a canvas:
// a mode survives silence, full scale and a mono frame; it is deterministic for
// a fixed seed; and it never reaches for Math.random.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MODE_IDS, modeById, drawFrame } from '../app/visualiser/modes.mjs';

const ADDED = [
  'rain', 'retro', 'binary', 'sakura', 'firework', 'bubbles', 'logo', 'terrain',
  'heartbeat', 'butterfly', 'ascii', 'firefly', 'mosaic', 'sand', 'geyser',
];

// Modes whose picture depends on the seed (Retro, Heartbeat and Ascii do not).
const SEEDED = ['rain', 'binary', 'sakura', 'firework', 'bubbles', 'logo', 'terrain', 'butterfly', 'firefly', 'mosaic', 'sand', 'geyser'];

const PALETTE = Object.freeze({
  background: null, accent: '#e0a24a', warm: '#d98c5f', hot: '#f2d08a',
  good: '#8fbf7f', muted: '#9d9180', dim: 'rgba(0,0,0,0.2)', text: '#efe8da', petal: '#e9a6b4',
});

const round = value => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : value);
const moved = ridge => ridge.filter(value => value > 0).length;

/** A 2D context that logs calls and style assignments, rounded so logs compare. */
function fakeContext() {
  const log = [];
  const context = { log, saves: 0, restores: 0 };
  for (const name of [
    'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill',
    'arc', 'quadraticCurveTo', 'fillText', 'closePath',
  ]) context[name] = (...args) => { log.push([name, ...args.map(round)]); };
  for (const name of ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'font']) {
    let value = name === 'globalAlpha' || name === 'lineWidth' ? 1 : '';
    Object.defineProperty(context, name, {
      get: () => value,
      set: next => { value = next; log.push([name, typeof next === 'object' ? 'gradient' : round(next)]); },
    });
  }
  context.save = () => { context.saves += 1; };
  context.restore = () => { context.restores += 1; };
  context.createLinearGradient = () => ({ addColorStop() {} });
  context.measureText = () => ({ width: 8 });
  return context;
}

const freqBuffer = new Uint8Array(1024);
const waveBuffer = new Uint8Array(2048);

/** A moving, music-like signal for frame `k`: a decaying spectrum that pulses. */
function signal(k) {
  const beat = k % 12 < 2 ? 1 : 0.45;
  for (let index = 0; index < freqBuffer.length; index += 1) {
    freqBuffer[index] = Math.max(0, Math.round((230 - index / 5) * beat * (0.7 + 0.3 * Math.abs(Math.sin(k * 0.3 + index * 0.02)))));
  }
  for (let index = 0; index < waveBuffer.length; index += 1) {
    waveBuffer[index] = 128 + Math.round(90 * beat * Math.sin(index / 24 + k));
  }
  return { freq: freqBuffer, wave: waveBuffer };
}

function run(mode, { frames = 40, seed = 7, reduced = false, width = 640, height = 200, data = signal } = {}) {
  const context = fakeContext();
  const memory = {};
  for (let k = 0; k < frames; k += 1) {
    const { freq, wave } = data(k);
    drawFrame(mode, { context, width, height, freq, wave, freqLeft: freq, freqRight: freq, palette: PALETTE, memory, seed, reduced });
  }
  return { context, memory };
}

test('all fifteen missing cliamp modes are registered, with Milkdrop and None last', () => {
  for (const id of ADDED) {
    assert.ok(MODE_IDS.includes(id), `${id} is not registered`);
    assert.equal(typeof modeById(id).draw, 'function', `${id} has no draw function`);
  }
  assert.deepEqual(MODE_IDS.slice(-2), ['milkdrop', 'none']);
  assert.equal(MODES.filter(mode => mode.draw).length, 29, 'cliamp has 29 drawn modes plus None');
});

test('every drawn mode survives silence, full scale and a mono frame', () => {
  const silentFreq = new Uint8Array(1024);
  const silentWave = new Uint8Array(2048).fill(128);
  const fullFreq = new Uint8Array(1024).fill(255);
  const fullWave = new Uint8Array(2048);
  for (let index = 0; index < fullWave.length; index += 1) fullWave[index] = index % 2 ? 255 : 0;
  const cases = {
    silence: () => ({ freq: silentFreq, wave: silentWave }),
    'full scale': () => ({ freq: fullFreq, wave: fullWave }),
    mono: signal,
  };
  for (const mode of MODES.filter(candidate => candidate.draw)) {
    for (const [name, data] of Object.entries(cases)) {
      let result;
      assert.doesNotThrow(() => { result = run(mode, { frames: 60, data }); }, `${mode.id} threw on ${name}`);
      assert.equal(result.context.saves, result.context.restores, `${mode.id} unbalanced save/restore on ${name}`);
      assert.equal(result.context.globalAlpha, 1, `${mode.id} left globalAlpha changed on ${name}`);
      for (const entry of result.context.log) {
        for (const value of entry.slice(1)) {
          assert.ok(typeof value !== 'number' || Number.isFinite(value), `${mode.id} drew a non-finite value on ${name}: ${entry}`);
        }
      }
    }
  }
});

test('every added mode paints on a loud frame', () => {
  for (const id of ADDED) {
    const { context } = run(modeById(id), { frames: 30 });
    const painted = context.log.filter(([name]) => ['fillRect', 'fillText', 'fill', 'stroke'].includes(name));
    assert.ok(painted.length > 0, `${id} drew nothing`);
  }
});

test('every drawn mode is deterministic for a fixed seed', () => {
  for (const mode of MODES.filter(candidate => candidate.draw)) {
    const first = run(mode, { seed: 1234 }).context.log;
    const second = run(mode, { seed: 1234 }).context.log;
    assert.deepEqual(second, first, `${mode.id} drew differently for the same seed`);
  }
});

test('the seeded modes change with the seed', () => {
  for (const id of SEEDED) {
    const first = run(modeById(id), { seed: 1 }).context.log;
    const second = run(modeById(id), { seed: 2 }).context.log;
    assert.notDeepEqual(second, first, `${id} ignores the seed`);
  }
});

test('no drawn mode calls Math.random', t => {
  t.mock.method(Math, 'random', () => { throw new Error('Math.random called'); });
  for (const mode of MODES.filter(candidate => candidate.draw)) {
    assert.doesNotThrow(() => run(mode, { frames: 20 }), `${mode.id} called Math.random`);
  }
});

test('reduced motion slows the added modes but does not stop them', () => {
  for (const id of ADDED) {
    const normal = run(modeById(id), { frames: 20 });
    const reduced = run(modeById(id), { frames: 20, reduced: true });
    const painted = reduced.context.log.filter(([name]) => ['fillRect', 'fillText', 'fill', 'stroke'].includes(name));
    assert.ok(painted.length > 0, `${id} drew nothing under reduced motion`);
    if (normal.memory.clock !== undefined) {
      assert.ok(reduced.memory.clock > 0 && reduced.memory.clock < normal.memory.clock, `${id} clock did not slow`);
    }
  }
  // Two modes whose state moves by a scroll rather than a clock.
  const terrainNormal = run(modeById('terrain'), { frames: 2 }).memory.ridge;
  const terrainReduced = run(modeById('terrain'), { frames: 2, reduced: true }).memory.ridge;
  assert.ok(moved(terrainReduced) > 0 && moved(terrainReduced) < moved(terrainNormal), 'terrain did not slow');
});

test('stateful modes keep their buffers between frames instead of reallocating', () => {
  const buffers = { terrain: 'ridge', heartbeat: 'trace', mosaic: 'glow', sand: 'grid', geyser: 'particles', binary: 'offsets' };
  for (const [id, key] of Object.entries(buffers)) {
    const mode = modeById(id);
    const context = fakeContext();
    const memory = {};
    const draw = k => {
      const { freq, wave } = signal(k);
      drawFrame(mode, { context, width: 640, height: 200, freq, wave, palette: PALETTE, memory, seed: 3 });
    };
    draw(0);
    const buffer = memory[key];
    assert.ok(ArrayBuffer.isView(buffer), `${id} keeps no ${key} buffer`);
    for (let k = 1; k < 10; k += 1) draw(k);
    assert.equal(memory[key], buffer, `${id} reallocated ${key}`);
  }
});

test('Sand drains when the pile passes half the panel', () => {
  const full = new Uint8Array(1024).fill(255);
  const { memory } = run(modeById('sand'), { frames: 900, width: 120, height: 60, data: () => ({ freq: full, wave: waveBuffer }) });
  assert.ok(memory.grains <= memory.grid.length * 0.5 + 12, `the pile holds ${memory.grains} of ${memory.grid.length}`);
});

test('Heartbeat is a flat line in silence and spikes on a bass hit', () => {
  const silent = new Uint8Array(1024);
  const flat = new Uint8Array(2048).fill(128);
  const quiet = run(modeById('heartbeat'), { frames: 30, data: () => ({ freq: silent, wave: flat }) });
  assert.ok(quiet.memory.trace.every(value => value === 0), 'silence drew a pulse');
  const loud = new Uint8Array(1024).fill(240);
  const beat = run(modeById('heartbeat'), {
    frames: 30, data: k => ({ freq: k < 10 ? silent : loud, wave: flat }),
  });
  assert.ok(Math.max(...beat.memory.trace) > 0.5, 'a bass hit drew no spike');
});
