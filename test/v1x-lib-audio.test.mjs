// S7 Winamp .eqf, S5 volume in dB, P11 mono stage.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEqf, writeEqf, exportCurrentEq, eqfToSettings, eqfByteToDb, dbToEqfByte, EQF_HEADER, EqfFormatError } from '../app/audio/eqf.mjs';
import {
  positionToDb, dbToPosition, dbToGain, gainToDb, positionToGain, gainToPosition, stepDb, formatDb, clampFloor,
  createMonoStage, MONO_GRAPH, DEFAULT_FLOOR_DB,
} from '../app/audio/volume.mjs';
import { EQ_PRESETS } from '../app/audio/eq-presets.mjs';

function eqfBytes(entries) {
  const head = [...EQF_HEADER].map(c => c.charCodeAt(0)).concat([0x1a, 0x21, 0x2d, 0x2d]);
  const body = [];
  for (const { name, bands, preamp } of entries) {
    const field = Array.from({ length: 257 }, () => 0);
    [...name].forEach((c, i) => { field[i] = c.charCodeAt(0); });
    body.push(...field, ...bands, preamp);
  }
  return new Uint8Array([...head, ...body]);
}

test('band bytes map 0, 31, 63 to +12, 0, -12 dB and back', () => {
  assert.equal(eqfByteToDb(0), 12);
  assert.equal(eqfByteToDb(31), 0);
  assert.equal(eqfByteToDb(63), -12);
  assert.equal(eqfByteToDb(47), -6);
  assert.equal(dbToEqfByte(12), 0);
  assert.equal(dbToEqfByte(0), 31);
  assert.equal(dbToEqfByte(-12), 63);
  assert.equal(dbToEqfByte(40), 0, 'clamped');
  for (let byte = 0; byte <= 63; byte += 1) assert.equal(dbToEqfByte(eqfByteToDb(byte)), byte);
});

test('a two-preset library parses with names, gains and preamp', () => {
  const bytes = eqfBytes([
    { name: 'Rock', bands: [0, 8, 16, 24, 31, 31, 40, 47, 55, 63], preamp: 31 },
    { name: '', bands: Array.from({ length: 10 }, () => 31), preamp: 0 },
  ]);
  const [rock, second] = parseEqf(bytes.buffer);
  assert.equal(rock.name, 'Rock');
  assert.equal(rock.gains.length, 10);
  assert.equal(rock.gains[0], 12);
  assert.equal(rock.gains[9], -12);
  assert.equal(rock.preampDb, 0);
  assert.equal(second.name, 'Preset 2');
  assert.equal(second.preampDb, 12);
  assert.deepEqual(eqfToSettings(rock).patch, { eq: { enabled: true, preset: 'custom', custom: rock.gains } });
});

test('bad files are refused by name', () => {
  assert.throws(() => parseEqf(new TextEncoder().encode('Not an EQ file at all, sorry.')), EqfFormatError);
  const headerOnly = eqfBytes([]);
  assert.throws(() => parseEqf(headerOnly), /no complete preset/);
  assert.throws(() => writeEqf([]), /no preset/);
});

test('export then import round-trips the current curve within one byte step', () => {
  const eq = { enabled: false, preset: 'rock', custom: [] };
  const bytes = exportCurrentEq(eq, { name: 'Mine é' });
  assert.equal(bytes.length, 31 + 268);
  const [back] = parseEqf(bytes);
  assert.equal(back.name, 'Mine é');
  EQ_PRESETS.rock.gains.forEach((db, band) => assert.ok(Math.abs(back.gains[band] - db) <= 0.4, `band ${band}`));
  assert.equal(parseEqf(writeEqf([{ name: '日本', gains: [], preampDb: 0 }]))[0].name, '??');
});

test('volume: position maps linearly in dB from the floor; 0 is mute', () => {
  assert.equal(DEFAULT_FLOOR_DB, -50);
  assert.equal(positionToDb(0), -Infinity);
  assert.equal(positionToDb(1), 0);
  assert.equal(positionToDb(0.5), -25);
  assert.equal(positionToDb(0.5, -90), -45);
  assert.equal(dbToPosition(-25), 0.5);
  assert.equal(dbToPosition(-Infinity), 0);
  assert.ok(dbToPosition(-80) > 0, 'below the floor but audible stays above mute');
  assert.equal(dbToPosition(3), 1);
  assert.equal(clampFloor(-200), -90);
  assert.equal(clampFloor(0), -1);
  assert.equal(clampFloor('x'), -50);
});

test('volume: gain is 10^(dB/20) and round-trips through position', () => {
  assert.equal(dbToGain(-Infinity), 0);
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-20) - 0.1) < 1e-12);
  assert.equal(gainToDb(0), -Infinity);
  assert.ok(Math.abs(gainToDb(0.5) - -6.0206) < 1e-4);
  assert.equal(positionToGain(0), 0);
  assert.ok(Math.abs(gainToPosition(positionToGain(0.37)) - 0.37) < 1e-12);
  assert.equal(gainToPosition(0), 0);
});

test('volume: steps land on the floor from mute and mute below it', () => {
  assert.equal(stepDb(-Infinity, 2), -50);
  assert.equal(stepDb(-Infinity, -2), -Infinity);
  assert.equal(stepDb(-49, -2), -Infinity);
  assert.equal(stepDb(-10, 2), -8);
  assert.equal(stepDb(-1, 2), 0);
  assert.equal(stepDb(-3.33, 1), -2.3);
  assert.equal(formatDb(-Infinity), 'Muted');
  assert.equal(formatDb(-12.54), '-12.5 dB');
  assert.equal(formatDb(-0.01), '0.0 dB');
});

function monoContext() {
  const edges = [];
  const node = kind => ({
    kind,
    gain: { value: 1, calls: [], setTargetAtTime(v, t, c) { this.calls.push([v, t, c]); this.value = v; } },
    connect(target, output = 0, input = 0) { edges.push([this, target, output, input]); return target; },
  });
  return {
    edges,
    currentTime: 3,
    createGain: () => node('gain'),
    createChannelMerger: inputs => ({ ...node('merger'), inputs }),
  };
}

test('mono stage: downmix node is one channel, explicit, speakers, feeding both merger inputs', () => {
  const context = monoContext();
  const stage = createMonoStage(context);
  const { stereo, mono, merger } = stage.nodes;
  assert.equal(mono.channelCount, 1);
  assert.equal(mono.channelCountMode, 'explicit');
  assert.equal(mono.channelInterpretation, 'speakers');
  assert.equal(merger.inputs, 2);
  const into = target => context.edges.filter(([, to]) => to === target).map(([from, , out, input]) => [from, out, input]);
  assert.deepEqual(into(merger), [[mono, 0, 0], [mono, 0, 1]]);
  assert.deepEqual(into(stage.output).map(([from]) => from), [stereo, merger]);
  assert.equal(stereo.gain.value, 1);
  assert.equal(mono.gain.value, 0);
  assert.equal(MONO_GRAPH.edges.length, 6);
});

test('mono stage: switching ramps the two gains and ignores a repeat', () => {
  const context = monoContext();
  const stage = createMonoStage(context);
  stage.setMono(true);
  assert.equal(stage.mono(), true);
  assert.deepEqual(stage.nodes.stereo.gain.calls, [[0, 3, 0.02]]);
  assert.deepEqual(stage.nodes.mono.gain.calls, [[1, 3, 0.02]]);
  stage.setMono(true);
  assert.equal(stage.nodes.mono.gain.calls.length, 1);
  const on = createMonoStage(monoContext(), { mono: true });
  assert.equal(on.nodes.stereo.gain.value, 0);
  assert.equal(on.nodes.mono.gain.value, 1);
});
