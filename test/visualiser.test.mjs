// Visualiser mode tests. Run: node --test test/visualiser.test.mjs
//
// Modes are pure draw functions, so they are testable against a recording
// context that captures calls instead of pixels. That catches the failures that
// matter here: a mode that draws nothing, a mode that leaves canvas state
// changed for the next one, and a mode that throws on a degenerate frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MODE_IDS, modeById, drawFrame, spectrumBars, spectrumBand } from '../app/visualiser/modes.mjs';

/** A 2D context that records what it was asked to do. */
function recordingContext() {
  const calls = [];
  const record = name => (...args) => { calls.push({ name, args }); };
  const context = {
    calls,
    saves: 0,
    restores: 0,
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    save() { this.saves += 1; calls.push({ name: 'save', args: [] }); },
    restore() { this.restores += 1; calls.push({ name: 'restore', args: [] }); },
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 8 }),
  };
  for (const name of [
    'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo',
    'stroke', 'fill', 'arc', 'quadraticCurveTo', 'fillText', 'closePath',
  ]) context[name] = record(name);
  return context;
}

function frame(overrides = {}) {
  const freq = new Uint8Array(1024);
  for (let index = 0; index < freq.length; index += 1) freq[index] = Math.max(0, 200 - index / 6);
  const wave = new Uint8Array(2048);
  for (let index = 0; index < wave.length; index += 1) wave[index] = 128 + Math.round(90 * Math.sin(index / 24));
  return {
    context: recordingContext(),
    width: 640,
    height: 200,
    freq,
    wave,
    palette: {
      background: null, accent: '#e0a24a', warm: '#d98c5f', hot: '#f2d08a',
      good: '#8fbf7f', muted: '#9d9180', dim: 'rgba(0,0,0,0.2)', text: '#efe8da',
    },
    memory: {},
    ...overrides,
  };
}

const drawing = MODES.filter(mode => mode.draw);

test('the registry is well formed and ids are unique', () => {
  assert.ok(MODES.length >= 12, `only ${MODES.length} modes registered`);
  assert.equal(new Set(MODE_IDS).size, MODE_IDS.length, 'duplicate mode id');
  for (const mode of MODES) {
    assert.ok(mode.id && mode.label, 'a mode is missing an id or label');
    assert.ok(mode.draw === null || typeof mode.draw === 'function', `${mode.id} has a bad draw`);
  }
  assert.ok(MODES.some(mode => mode.id === 'none' && mode.draw === null), 'None must be a real registered mode');
});

test('modeById falls back rather than returning undefined', () => {
  assert.equal(modeById('bars').id, 'bars');
  assert.equal(modeById('does-not-exist').id, MODES[0].id);
  assert.equal(modeById(undefined).id, MODES[0].id);
});

test('every drawing mode paints something', () => {
  for (const mode of drawing) {
    const state = frame();
    assert.equal(drawFrame(mode, state), true, `${mode.id} reported nothing drawn`);
    const painted = state.context.calls.filter(call => call.name !== 'clearRect' && call.name !== 'save' && call.name !== 'restore');
    assert.ok(painted.length > 0, `${mode.id} issued no drawing calls`);
  }
});

test('the None mode draws nothing and says so', () => {
  const state = frame();
  assert.equal(drawFrame(modeById('none'), state), false);
  assert.equal(state.context.calls.length, 0, 'None touched the canvas');
});

test('every mode balances save and restore', () => {
  for (const mode of drawing) {
    const state = frame();
    drawFrame(mode, state);
    assert.equal(state.context.saves, state.context.restores, `${mode.id} left the context stack unbalanced`);
  }
});

test('no mode leaves globalAlpha changed for the next one', () => {
  for (const mode of drawing) {
    const state = frame();
    drawFrame(mode, state);
    assert.equal(state.context.globalAlpha, 1, `${mode.id} left globalAlpha at ${state.context.globalAlpha}`);
  }
});

test('every mode survives silence, a tiny canvas and empty data', () => {
  const degenerate = [
    { freq: new Uint8Array(1024), wave: new Uint8Array(2048).fill(128) },
    { width: 1, height: 1 },
    { width: 0, height: 0 },
    { freq: new Uint8Array(0), wave: new Uint8Array(0) },
    { freq: new Uint8Array(1024).fill(255), wave: new Uint8Array(2048).fill(255) },
  ];
  for (const mode of drawing) {
    for (const [index, overrides] of degenerate.entries()) {
      assert.doesNotThrow(
        () => drawFrame(mode, frame(overrides)),
        `${mode.id} threw on degenerate frame ${index}`,
      );
    }
  }
});

test('a mode keeps its state in memory, not in module scope', () => {
  // Two independent frames must not see each other's peaks or particles.
  for (const mode of drawing) {
    const first = frame();
    const second = frame();
    drawFrame(mode, first);
    drawFrame(mode, second);
    assert.deepEqual(
      Object.keys(first.memory).sort(),
      Object.keys(second.memory).sort(),
      `${mode.id} stored state inconsistently`,
    );
  }
});

test('spectrum banding is logarithmic and bounded', () => {
  const freq = new Uint8Array(1024).fill(128);
  const values = spectrumBars(freq, 32);
  assert.equal(values.length, 32);
  for (const value of values) {
    assert.ok(value >= 0 && value <= 1, `band value ${value} out of range`);
  }
  assert.equal(spectrumBand(freq, 0, 0), 0, 'an empty band must be zero, not NaN');
  assert.ok(Number.isFinite(spectrumBand(new Uint8Array(0), 0, 10)));
});

test('Stereo draws its two sides from its two channels', () => {
  // The old mode split one summed spectrum in half and called the halves left
  // and right, so the "left channel" was the bass of both channels. Feeding it
  // a loud left and a silent right must now be visible in what it draws.
  const loud = new Uint8Array(1024).fill(220);
  const silent = new Uint8Array(1024).fill(0);
  const context = recordingContext();
  drawFrame(modeById('stereo'), frame({ context, freqLeft: loud, freqRight: silent }));

  const rects = context.calls.filter(call => call.name === 'fillRect' && call.args[3] > 0);
  const leftSide = rects.filter(call => call.args[0] < 320);
  const rightSide = rects.filter(call => call.args[0] >= 320);
  assert.ok(leftSide.length > 8, `the loud channel drew ${leftSide.length} bars`);
  assert.equal(rightSide.length, 0, `the silent channel drew ${rightSide.length} bars`);

  // And swapping the channels swaps the sides, rather than the picture being
  // decided by which half of one array the bins came from.
  const swapped = recordingContext();
  drawFrame(modeById('stereo'), frame({ context: swapped, freqLeft: silent, freqRight: loud }));
  const swappedRects = swapped.calls.filter(call => call.name === 'fillRect' && call.args[3] > 0);
  assert.equal(swappedRects.filter(call => call.args[0] < 320).length, 0);
  assert.ok(swappedRects.filter(call => call.args[0] >= 320).length > 8);
});
