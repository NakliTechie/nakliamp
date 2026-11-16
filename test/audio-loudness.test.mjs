import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoudnessMeter, createLoudnessScanner, defaultLoudnessKey, kWeightingCoefficients,
  loudnessToGainDb, measureLoudness,
} from '../app/audio/loudness.mjs';

function sine({ seconds, sampleRate = 48000, frequency = 997, amplitude, channels = 2, phase = 0 }) {
  const frames = Math.round(seconds * sampleRate);
  const plane = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) plane[index] = amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate + phase);
  return Array.from({ length: channels }, () => plane.slice());
}
const dbfs = db => Math.pow(10, db / 20);
const concat = (...parts) => parts[0].map((_, channel) => {
  const total = parts.reduce((sum, part) => sum + part[channel].length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part[channel], offset); offset += part[channel].length; }
  return out;
});

test('K-weighting coefficients at 48 kHz match the values printed in BS.1770-4', () => {
  const { shelf, highPass } = kWeightingCoefficients(48000);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} vs ${expected}`);
  close(shelf.b[0], 1.53512485958697);
  close(shelf.b[1], -2.69169618940638);
  close(shelf.b[2], 1.19839281085285);
  close(shelf.a[0], -1.69065929318241);
  close(shelf.a[1], 0.73248077421585);
  close(highPass.a[0], -1.99004745483398);
  close(highPass.a[1], 0.99007225036621);
});

// Derivation: a sine of peak amplitude A has mean square A^2/2 (-3.01 dB). The
// K-weighting gain at 997 Hz is about +0.69 dB, which the -0.691 constant
// cancels. Two channels at weight 1 add +3.01 dB. So a stereo sine at A dBFS
// peak reads A LUFS, and a mono one reads A - 3.01 LUFS. EBU Tech 3341 case 1
// (stereo 1 kHz at -23 dBFS reads -23.0 LUFS) is the same statement.
test('stereo 997 Hz sine at -23 dBFS peak reads -23 LUFS at 48 kHz', () => {
  const result = measureLoudness(sine({ seconds: 5, amplitude: dbfs(-23) }), 48000);
  assert.ok(Math.abs(result.integratedLufs - -23) < 0.5, String(result.integratedLufs));
  assert.ok(Math.abs(result.integratedLufs - -23) < 0.1, `tighter than the 0.5 LU bar: ${result.integratedLufs}`);
});

test('stereo sine at -20 dBFS reads -20 LUFS at 44.1 kHz', () => {
  const result = measureLoudness(sine({ seconds: 4, sampleRate: 44100, amplitude: dbfs(-20) }), 44100);
  assert.ok(Math.abs(result.integratedLufs - -20) < 0.5, String(result.integratedLufs));
});

test('mono sine reads 3 LU under the same stereo sine', () => {
  const result = measureLoudness(sine({ seconds: 4, amplitude: dbfs(-20), channels: 1 }), 48000);
  assert.ok(Math.abs(result.integratedLufs - -23.01) < 0.5, String(result.integratedLufs));
});

test('silence is gated out by the absolute gate', () => {
  const tone = sine({ seconds: 3, amplitude: dbfs(-23) });
  const quiet = [new Float32Array(48000 * 3), new Float32Array(48000 * 3)];
  const result = measureLoudness(concat(quiet, tone, quiet), 48000);
  assert.ok(Math.abs(result.integratedLufs - -23) < 0.5, String(result.integratedLufs));
  const silent = measureLoudness([new Float32Array(48000), new Float32Array(48000)], 48000);
  assert.equal(silent.integratedLufs, -Infinity);
  assert.equal(loudnessToGainDb(silent.integratedLufs), null);
});

test('quiet passages 13 LU down are removed by the relative gate (EBU 3341 case 3 shape)', () => {
  const quiet = sine({ seconds: 2, amplitude: dbfs(-36) });
  const loud = sine({ seconds: 6, amplitude: dbfs(-23) });
  const result = measureLoudness(concat(quiet, loud, quiet), 48000);
  assert.ok(Math.abs(result.integratedLufs - -23) < 0.5, String(result.integratedLufs));
});

test('chunked input through the incremental meter matches one-shot', () => {
  const planes = sine({ seconds: 3, amplitude: dbfs(-18), frequency: 440 });
  const oneShot = measureLoudness(planes, 48000);
  const meter = createLoudnessMeter({ sampleRate: 48000, channels: 2 });
  for (let start = 0; start < planes[0].length; start += 7001) meter.push(planes.map(plane => plane.subarray(start, start + 7001)));
  const chunked = meter.result();
  assert.ok(Math.abs(chunked.integratedLufs - oneShot.integratedLufs) < 1e-9);
  assert.equal(chunked.truePeak, oneShot.truePeak);
});

test('true peak finds an inter-sample peak the samples miss', () => {
  // fs/4 with a 45 degree phase: every sample sits at 0.707 of the peak.
  const planes = sine({ seconds: 1, frequency: 12000, amplitude: 0.5, phase: Math.PI / 4 });
  const result = measureLoudness(planes, 48000);
  assert.ok(Math.abs(result.samplePeak - 0.5 * Math.SQRT1_2) < 1e-4, String(result.samplePeak));
  assert.ok(Math.abs(result.truePeak - 0.5) < 0.02, String(result.truePeak));
  assert.ok(Math.abs(result.truePeakDb - -6.02) < 0.35);
});

test('gain is -18 minus integrated loudness', () => {
  assert.equal(loudnessToGainDb(-23), 5);
  assert.equal(loudnessToGainDb(-9), -9);
});

test('measureLoudness accepts an AudioBuffer-like object', () => {
  const planes = sine({ seconds: 2, amplitude: dbfs(-23) });
  const buffer = { sampleRate: 48000, numberOfChannels: 2, getChannelData: index => planes[index] };
  const result = measureLoudness(buffer);
  assert.ok(Math.abs(result.integratedLufs - -23) < 0.5);
});

test('scanner measures uncached tracks, skips cached ones, stores the contract shape', async () => {
  const cache = new Map();
  const tracks = [
    { path: 'a.flac', size: 1, lastModified: 1 },
    { path: 'b.flac', size: 2, lastModified: 2 },
  ];
  cache.set(defaultLoudnessKey(tracks[1]), { integratedLufs: -10, truePeak: 1, gainDb: -8, computedAt: 0 });
  let decodes = 0;
  const scanner = createLoudnessScanner({
    decode: async () => { decodes += 1; return { planes: sine({ seconds: 2, amplitude: dbfs(-23) }), sampleRate: 48000 }; },
    getLoudness: async key => cache.get(key) ?? null,
    putLoudness: async (key, value) => { cache.set(key, value); },
    yieldFn: () => Promise.resolve(),
    now: () => 1234,
  });
  scanner.enqueue(tracks);
  const final = await scanner.idle();
  assert.equal(decodes, 1);
  assert.equal(final.done, 1);
  assert.equal(final.skipped, 1);
  const value = cache.get('a.flac\u001f1\u001f1');
  assert.deepEqual(Object.keys(value).sort(), ['computedAt', 'gainDb', 'integratedLufs', 'truePeak']);
  assert.ok(Math.abs(value.gainDb - 5) < 0.5);
  assert.equal(value.computedAt, 1234);
});

test('scanner waits while playback is busy and stops on cancel', async () => {
  let busy = true;
  let ticks = 0;
  const stored = [];
  const scanner = createLoudnessScanner({
    decode: async () => ({ planes: sine({ seconds: 1, amplitude: 0.1 }), sampleRate: 48000 }),
    getLoudness: async () => null,
    putLoudness: async key => { stored.push(key); },
    isBusy: () => busy,
    yieldFn: () => {
      ticks += 1;
      if (ticks === 5) busy = false;
      return Promise.resolve();
    },
  });
  scanner.enqueue([{ path: 'x', size: 1, lastModified: 1 }]);
  await scanner.idle();
  assert.ok(ticks >= 5, 'yielded while busy');
  assert.deepEqual(stored, ['x\u001f1\u001f1']);

  const blocked = createLoudnessScanner({
    decode: async () => ({ planes: sine({ seconds: 1, amplitude: 0.1 }), sampleRate: 48000 }),
    getLoudness: async () => null,
    putLoudness: async key => { stored.push(key); },
    isBusy: () => true,
    yieldFn: () => new Promise(resolve => setTimeout(resolve, 1)),
  });
  blocked.enqueue([{ path: 'y', size: 1, lastModified: 1 }]);
  blocked.cancel();
  const final = await blocked.idle();
  assert.equal(final.cancelled, true);
  assert.equal(stored.length, 1);
});

test('scanner records a decode failure and carries on', async () => {
  const scanner = createLoudnessScanner({
    decode: async track => { if (track.path === 'bad') throw new Error('nope'); return { planes: sine({ seconds: 1, amplitude: 0.1 }), sampleRate: 48000 }; },
    getLoudness: async () => null,
    putLoudness: async () => {},
    yieldFn: () => Promise.resolve(),
  });
  const events = [];
  scanner.onProgress(event => events.push(event.type));
  scanner.enqueue([{ path: 'bad', size: 1, lastModified: 1 }, { path: 'good', size: 1, lastModified: 1 }]);
  const final = await scanner.idle();
  assert.equal(final.failed, 1);
  assert.equal(final.done, 1);
  assert.ok(events.includes('failed') && events.includes('measured'));
});
