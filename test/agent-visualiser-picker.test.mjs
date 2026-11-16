import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planPreviewTick, previewDelayMs, scaleInput, createPreviewGrid, createVisualiser,
  PREVIEW_FPS, PREVIEW_BUDGET_MS, PREVIEW_REDUCED_DELAY_MS,
} from '../app/visualiser/driver.mjs';
import { MODES } from '../app/visualiser/modes.mjs';
import { mergeSettings, DEFAULT_SETTINGS } from '../app/settings.mjs';

test('frame budget: all tiles before a measurement, then a wrapping slice that fits', () => {
  assert.deepEqual(planPreviewTick({ count: 4 }), { indices: [0, 1, 2, 3], cursor: 0 });
  assert.deepEqual(planPreviewTick({ count: 4, perTileMs: 1, budgetMs: 6 }), { indices: [0, 1, 2, 3], cursor: 0 });
  assert.deepEqual(planPreviewTick({ count: 29, cursor: 0, perTileMs: 2, budgetMs: 6 }), { indices: [0, 1, 2], cursor: 3 });
  assert.deepEqual(planPreviewTick({ count: 29, cursor: 27, perTileMs: 2, budgetMs: 6 }), { indices: [27, 28, 0], cursor: 1 });
  // A tile slower than the whole budget still draws one per tick, so every tile updates.
  assert.deepEqual(planPreviewTick({ count: 5, cursor: 4, perTileMs: 50, budgetMs: 6 }), { indices: [4], cursor: 0 });
  assert.deepEqual(planPreviewTick({ count: 0 }), { indices: [], cursor: 0 });
  assert.deepEqual(planPreviewTick({ count: 3, cursor: -1 }).indices, [2, 0, 1]);
});

test('preview rate: a few frames a second, one a second under reduced motion', () => {
  assert.equal(previewDelayMs({}), Math.round(1000 / PREVIEW_FPS));
  assert.ok(PREVIEW_FPS >= 2 && PREVIEW_FPS <= 10);
  assert.equal(previewDelayMs({ fps: 200 }), Math.round(1000 / 30));
  assert.equal(previewDelayMs({ reduced: true }), PREVIEW_REDUCED_DELAY_MS);
  assert.ok(PREVIEW_BUDGET_MS > 0 && PREVIEW_BUDGET_MS < 16);
});

test('volume link: spectrum scales toward 0, waveform toward the centre line', () => {
  const freq = Uint8Array.from([200, 100, 0]);
  const wave = Uint8Array.from([255, 128, 0]);
  scaleInput(freq, wave, 0.5);
  assert.deepEqual([...freq], [100, 50, 0]);
  assert.deepEqual([...wave], [192, 128, 64]);
  scaleInput(freq, wave, 1);
  scaleInput(freq, wave, Number.NaN);
  assert.deepEqual([...freq], [100, 50, 0]);
  scaleInput(freq, wave, 0);
  assert.deepEqual([...freq], [0, 0, 0]);
  assert.deepEqual([...wave], [128, 128, 128]);
  assert.equal(DEFAULT_SETTINGS.visualiserLinkVolume, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { visualiserLinkVolume: true }).visualiserLinkVolume, true);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { visualiserLinkVolume: 'yes' }).visualiserLinkVolume, false);
});

// A 2D context that records nothing; the modes only need the calls to exist.
function fakeContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 5 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}
const fakeCanvas = () => ({ width: 160, height: 80, clientWidth: 160, clientHeight: 80, getContext: () => fakeContext() });

function fakeAnalyser(level = 180) {
  return {
    frequencyBinCount: 64, fftSize: 128,
    getByteFrequencyData(a) { a.fill(level); },
    getByteTimeDomainData(a) { a.fill(200); },
  };
}

function manualTimers() {
  const queue = [];
  return {
    setTimeout(fn, ms) { queue.push({ fn, ms }); return queue.length; },
    clearTimeout() { queue.length = 0; },
    next() { const item = queue.shift(); item?.fn(); return item?.ms; },
    pending: () => queue.length,
  };
}

test('preview grid: draws only 2D modes, runs only while started, paused while hidden', () => {
  const tiles = MODES.map(m => ({ canvas: fakeCanvas(), modeId: m.id }));
  const timers = manualTimers();
  let hidden = false;
  let clock = 0;
  const grid = createPreviewGrid({
    tiles, getAnalyser: () => fakeAnalyser(), timers, hidden: () => hidden,
    now: () => (clock += 0.1),
  });
  const drawable = MODES.filter(m => m.draw).length;
  assert.equal(grid.tiles().length, drawable);
  assert.ok(!grid.tiles().includes('milkdrop') && !grid.tiles().includes('none'));
  assert.equal(grid.drawn(), 0);
  grid.start();
  assert.equal(grid.drawn(), drawable); // first tick: no measurement yet, every tile
  assert.equal(timers.next(), previewDelayMs({}));
  assert.ok(grid.drawn() > drawable);
  hidden = true;
  const before = grid.drawn();
  timers.next();
  assert.equal(grid.drawn(), before); // hidden tab: no drawing, still scheduled
  assert.equal(timers.pending(), 1);
  grid.stop();
  assert.equal(grid.running, false);
  assert.equal(timers.pending(), 0);
});

test('preview grid: an expensive tile spreads drawing across ticks', () => {
  const tiles = MODES.filter(m => m.draw).slice(0, 10).map(m => ({ canvas: fakeCanvas(), modeId: m.id }));
  const timers = manualTimers();
  let clock = 0;
  const grid = createPreviewGrid({ tiles, getAnalyser: () => fakeAnalyser(), timers, hidden: () => false, now: () => (clock += 40), budgetMs: 8 });
  grid.start();
  const first = grid.drawn();
  timers.next();
  const second = grid.drawn() - first;
  assert.equal(first, 10);
  assert.ok(second < 10 && second >= 1, `second tick drew ${second}`);
  grid.stop();
});

test('main driver: link to volume scales the buffers the mode draws from', () => {
  const frames = [];
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    let scale = 1;
    let freqSeen = null;
    let waveSeen = null;
    const analyser = {
      frequencyBinCount: 8, fftSize: 16,
      getByteFrequencyData(a) { a.fill(200); freqSeen = a; },
      getByteTimeDomainData(a) { a.fill(228); waveSeen = a; },
    };
    const vis = createVisualiser({ canvas: fakeCanvas(), getAnalyser: () => analyser, inputScale: () => scale });
    vis.setMode('bars');
    frames.shift()();
    assert.equal(freqSeen[0], 200);
    assert.equal(waveSeen[0], 228);
    scale = 0.25;
    frames.shift()();
    assert.equal(freqSeen[0], 50);
    assert.equal(waveSeen[0], 153);
    vis.stop();
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
