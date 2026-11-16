import test from 'node:test';
import assert from 'node:assert/strict';
import { createChain, dbToGain, gainToDb, resolveTrackGain } from '../app/audio/chain.mjs';
import { EQ_BANDS_HZ, EQ_PRESETS, EQ_PRESET_IDS, EQ_Q, eqGains, normaliseCustom } from '../app/audio/eq-presets.mjs';
import { fakeContext } from './audio-fakes.mjs';

test('EQ band table is the contract table at Q 1.4', () => {
  assert.deepEqual(EQ_BANDS_HZ, [70, 180, 320, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
  assert.equal(EQ_Q, 1.4);
});

test('presets: the ten contract names plus custom, ten values each inside -12..12', () => {
  assert.deepEqual(EQ_PRESET_IDS, ['flat', 'rock', 'pop', 'jazz', 'classical', 'bass-boost', 'treble-boost', 'vocal', 'electronic', 'acoustic', 'custom']);
  for (const [id, preset] of Object.entries(EQ_PRESETS)) {
    assert.equal(preset.gains.length, 10, id);
    for (const value of preset.gains) assert.ok(value >= -12 && value <= 12, `${id} ${value}`);
  }
  // cliamp's table, verbatim.
  assert.deepEqual([...EQ_PRESETS.rock.gains], [5, 4, 2, -1, -2, 2, 4, 5, 5, 5]);
  assert.deepEqual([...EQ_PRESETS['bass-boost'].gains], [8, 6, 4, 2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...EQ_PRESETS.acoustic.gains], [3, 3, 2, 0, 1, 2, 3, 3, 2, 1]);
});

test('eqGains: disabled is flat, unknown preset is flat, custom is clamped', () => {
  assert.deepEqual(eqGains({ enabled: false, preset: 'rock' }), Array.from({ length: 10 }).fill(0));
  assert.deepEqual(eqGains({ enabled: true, preset: 'nonsense' }), Array.from({ length: 10 }).fill(0));
  assert.deepEqual(eqGains({ enabled: true, preset: 'pop' }), [-1, 2, 4, 5, 4, 1, -1, -1, 1, 2]);
  assert.deepEqual(eqGains({ enabled: true, preset: 'custom', custom: [20, -20, 'x', 3] }), [12, -12, 0, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(normaliseCustom(null), Array.from({ length: 10 }).fill(0));
});

test('dB conversions', () => {
  assert.ok(Math.abs(dbToGain(-6) - 0.501187) < 1e-6);
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(gainToDb(0.5) - -6.0206) < 1e-4);
  assert.equal(gainToDb(0), -Infinity);
});

test('chain is input -> ten peaking filters in band order -> output -> destination', () => {
  const context = fakeContext();
  const chain = createChain(context);
  assert.equal(chain.eq.length, 10);
  assert.ok(chain.input.outputs.has(chain.eq[0]));
  chain.eq.forEach((filter, index) => {
    assert.equal(filter.type, 'peaking');
    assert.equal(filter.frequency.value, EQ_BANDS_HZ[index]);
    assert.equal(filter.Q.value, 1.4);
    assert.equal(filter.gain.value, 0);
    const next = index < 9 ? chain.eq[index + 1] : chain.output;
    assert.deepEqual([...filter.outputs], [next]);
  });
  assert.deepEqual([...chain.output.outputs], [context.destination]);
});

test('chain moves EQ and gain with setTargetAtTime, never a jump', () => {
  const context = fakeContext();
  context.currentTime = 2;
  const chain = createChain(context);
  const applied = chain.setEq({ enabled: true, preset: 'rock' });
  assert.deepEqual(applied, [5, 4, 2, -1, -2, 2, 4, 5, 5, 5]);
  const call = chain.eq[0].gain.calls.find(entry => entry[0] === 'target');
  assert.deepEqual(call.slice(0, 3), ['target', 5, 2]);
  assert.ok(call[3] > 0 && call[3] <= 0.05);
  chain.setGainDb(-6);
  assert.ok(Math.abs(chain.input.gain.value - dbToGain(-6)) < 1e-12);
  assert.equal(chain.input.gain.calls.at(-1)[0], 'target');
  assert.equal(chain.gainDb(), -6);
  chain.setEq({ enabled: false, preset: 'rock' });
  assert.deepEqual(chain.bandGains(), Array.from({ length: 10 }).fill(0));
  chain.dispose();
  assert.equal(chain.output.outputs.size, 0);
});

const rg = { trackGainDb: -3, trackPeak: 0.5, albumGainDb: -5, albumPeak: 0.9 };

test('ReplayGain modes: off, track, album, auto', () => {
  assert.deepEqual(resolveTrackGain({ mode: 'off' }, { replayGain: rg }), { gainDb: 0, source: 'off', peak: null, clipLimited: false });
  assert.equal(resolveTrackGain({ mode: 'track' }, { replayGain: rg }).gainDb, -3);
  assert.equal(resolveTrackGain({ mode: 'album' }, { replayGain: rg }).gainDb, -5);
  assert.equal(resolveTrackGain({ mode: 'auto' }, { replayGain: rg }, { albumContext: false }).source, 'track');
  assert.equal(resolveTrackGain({ mode: 'auto' }, { replayGain: rg }, { albumContext: true }).source, 'album');
});

test('ReplayGain fallbacks: album mode with only track gain, then computed loudness, then unity', () => {
  assert.equal(resolveTrackGain({ mode: 'album' }, { replayGain: { trackGainDb: -2, trackPeak: null } }).gainDb, -2);
  const loud = resolveTrackGain({ mode: 'track' }, { replayGain: null, loudness: { integratedLufs: -10, truePeak: 0.5, gainDb: -8 } });
  assert.deepEqual([loud.gainDb, loud.source], [-8, 'loudness']);
  assert.equal(resolveTrackGain({ mode: 'track' }, {}).source, 'none');
});

test('preamp adds, clipping prevention caps at the peak', () => {
  const plain = resolveTrackGain({ mode: 'track', preampDb: 2, preventClipping: false }, { replayGain: { trackGainDb: 6, trackPeak: 0.8 } });
  assert.equal(plain.gainDb, 8);
  assert.equal(plain.clipLimited, false);
  const capped = resolveTrackGain({ mode: 'track', preampDb: 2, preventClipping: true }, { replayGain: { trackGainDb: 6, trackPeak: 0.8 } });
  assert.ok(Math.abs(capped.gainDb - -20 * Math.log10(0.8)) < 1e-12);
  assert.ok(capped.gainDb * 1 < 2, 'peak 0.8 allows +1.94 dB at most');
  assert.equal(capped.clipLimited, true);
  const under = resolveTrackGain({ mode: 'track', preventClipping: true }, { replayGain: { trackGainDb: -6, trackPeak: 0.99 } });
  assert.equal(under.gainDb, -6);
  assert.equal(under.clipLimited, false);
});
