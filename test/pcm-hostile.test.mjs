// R3 in-house PCM decode, hostile input. Run: node --test test/pcm-hostile.test.mjs
//
// Every field these parsers read is a claim made by the file. `pcm.test.mjs`
// covers files that tell the truth; this covers files that do not, and the
// failures it guards are not ordinary decode failures:
//
//   - a declared channel count of 0 made the frame stride 0, so the decode
//     loop ran forever with nothing to allocate and no exit condition;
//   - a CAF chunk size read as a signed high word could be negative, sending
//     the chunk walk's cursor back where it started, forever;
//   - a 32-bit channel count sized the output array, so 84 bytes could ask
//     for four billion Float32Arrays.
//
// The first two hang the tab and the third kills it. Neither is catchable by
// the engine, so neither can be tested in-process: **every case below runs in
// a worker with a wall clock and a heap cap**, and the assertion is that the
// worker came back at all. A hang fails as a timeout, an OOM as a worker
// error, and only a named `PcmDecodeError` passes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(resolve(root, 'app/decode/pcm.mjs')).href;

// CommonJS on purpose: an eval'd worker is not a module, so the module under
// test is pulled in with a dynamic import rather than a static one.
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
import(workerData.url).then(({ decodePcm }) => {
  try {
    const decoded = decodePcm(new Uint8Array(workerData.bytes));
    parentPort.postMessage({ outcome: 'decoded', frames: decoded.frames });
  } catch (error) {
    parentPort.postMessage({ outcome: 'threw', name: error.name, code: error.code, message: error.message });
  }
}).catch(error => parentPort.postMessage({ outcome: 'broke', message: String(error) }));
`;

/** Decode `bytes` under a 4-second clock and a 256 MB heap. */
function decodeInWorker(bytes, timeoutMs = 4000) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { url: moduleUrl, bytes: [...bytes] },
      // Small enough that an unbounded allocation dies here rather than
      // taking the whole test run down with it.
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`decodePcm did not return within ${timeoutMs}ms — it hung.`));
    }, timeoutMs);
    const finish = fn => value => { clearTimeout(timer); worker.terminate(); fn(value); };
    worker.on('message', finish(resolvePromise));
    worker.on('error', finish(error => reject(new Error(`the worker died: ${error.message}`))));
    worker.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the worker exited with ${code} — an allocation killed it.`));
    });
  });
}

/** Assert this file is refused by name, without hanging or crashing. */
async function refuses(bytes, label) {
  const result = await decodeInWorker(bytes);
  assert.equal(result.outcome, 'threw', `${label}: expected a refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.name, 'PcmDecodeError', `${label}: threw a foreign ${result.name}`);
  assert.ok(String(result.code).startsWith('ERR_NAKLIAMP_PCM_'), `${label}: unnamed code ${result.code}`);
  assert.ok(result.message.length > 10, `${label}: the refusal did not explain itself`);
  return result;
}

// ------------------------------------------------------------ builders ----

const ascii = text => [...text].map(character => character.charCodeAt(0));
const be32 = value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const be16 = value => [(value >>> 8) & 0xff, value & 0xff];

/** The 80-bit extended float AIFF stores its sample rate in. */
function extended80(rate) {
  if (rate === 0) return new Array(10).fill(0);
  let exponent = 16383;
  let mantissa = rate;
  while (mantissa < 0x80000000) { mantissa *= 2; exponent -= 1; }
  while (mantissa >= 0x100000000) { mantissa /= 2; exponent += 1; }
  return [...be16(exponent), ...be32(Math.floor(mantissa)), 0, 0, 0, 0];
}

/** An AIFF whose COMM chunk declares whatever channel count is asked for. */
function aiffWithChannels(channels, { bits = 16, rate = 48000, frames = 8 } = {}) {
  const comm = [...be16(channels), ...be32(frames), ...be16(bits), ...extended80(rate)];
  const ssnd = [...be32(0), ...be32(0), ...new Array(16).fill(0)];
  const body = [
    ...ascii('AIFF'),
    ...ascii('COMM'), ...be32(comm.length), ...comm,
    ...ascii('SSND'), ...be32(ssnd.length), ...ssnd,
  ];
  return new Uint8Array([...ascii('FORM'), ...be32(body.length), ...body]);
}

/** A CAF with a description chunk built from raw field values. */
function caf({ channels = 1, bits = 16, rate = 48000, sizeHigh = 0, sizeLow = 32 } = {}) {
  const rateBytes = new Uint8Array(8);
  new DataView(rateBytes.buffer).setFloat64(0, rate);
  const desc = [
    ...rateBytes, ...ascii('lpcm'), ...be32(0),
    ...be32(4), ...be32(1), ...be32(channels), ...be32(bits),
  ];
  const data = [...be32(0), ...new Array(16).fill(0)];
  return new Uint8Array([
    ...ascii('caff'), ...be16(1), ...be16(0),
    ...ascii('desc'), ...be32(sizeHigh), ...be32(sizeLow), ...desc,
    ...ascii('data'), ...be32(0), ...be32(data.length), ...data,
  ]);
}

/** A 24-byte AU header plus `payload` bytes. */
function au({ channels = 1, encoding = 3, rate = 48000, dataOffset = 24, length = 16, payload = 16 } = {}) {
  return new Uint8Array([
    ...ascii('.snd'), ...be32(dataOffset), ...be32(length),
    ...be32(encoding), ...be32(rate), ...be32(channels),
    ...new Array(payload).fill(0),
  ]);
}

// --------------------------------------------------------------- tests ----

test('a zero channel count is refused instead of hanging the decoder', async () => {
  await refuses(aiffWithChannels(0), 'AIFF with 0 channels');
  await refuses(caf({ channels: 0 }), 'CAF with 0 channels');
  await refuses(au({ channels: 0, dataOffset: 24, length: 0xffffffff }), 'AU with 0 channels');
});

test('an absurd channel count is refused instead of being allocated', async () => {
  await refuses(caf({ channels: 0xffffffff }), 'CAF with 4.29 billion channels');
  await refuses(caf({ channels: 65 }), 'CAF one channel past the cap');
  await refuses(aiffWithChannels(0xffff), 'AIFF with 65535 channels');
});

test('a negative CAF chunk size cannot walk the cursor backwards', async () => {
  // high = 0xFFFFFFFF, low = 0xFFFFFFF4 read signed is -12, which misses the
  // to-end-of-file sentinel and leaves `cursor` exactly where it began.
  const file = caf({ sizeHigh: 0xffffffff, sizeLow: 0xfffffff4 });
  await refuses(file, 'CAF declaring a chunk of -12 bytes');
});

test('a chunk claiming more bytes than the file holds is named, not a RangeError', async () => {
  const truncatedComm = new Uint8Array([
    ...ascii('FORM'), ...be32(30), ...ascii('AIFF'),
    ...ascii('COMM'), ...be32(18), ...be16(2), ...be32(8), // then nothing
  ]);
  await refuses(truncatedComm, 'AIFF with a COMM chunk running past EOF');

  const truncatedSsnd = new Uint8Array([
    ...ascii('FORM'), ...be32(40), ...ascii('AIFF'),
    ...ascii('SSND'), ...be32(64), ...be32(0),
  ]);
  await refuses(truncatedSsnd, 'AIFF with an SSND chunk running past EOF');

  const truncatedDesc = new Uint8Array([
    ...ascii('caff'), ...be16(1), ...be16(0),
    ...ascii('desc'), ...be32(0), ...be32(32), 0, 0, 0, 0,
  ]);
  await refuses(truncatedDesc, 'CAF with a desc chunk running past EOF');

  const shortAu = new Uint8Array([...ascii('.snd'), ...be32(24), ...be32(16), 0, 0, 0, 0]);
  await refuses(shortAu, 'AU with a header cut off at 16 bytes');
});

test('a non-finite sample rate is refused', async () => {
  await refuses(caf({ rate: Number.POSITIVE_INFINITY }), 'CAF declaring an infinite rate');
  await refuses(caf({ rate: Number.NaN }), 'CAF declaring NaN');
  await refuses(caf({ rate: 0 }), 'CAF declaring a rate of zero');
  await refuses(caf({ rate: -48000 }), 'CAF declaring a negative rate');
  // An AIFF exponent of 0x7FFF is the extended-float encoding of infinity.
  const infinite = new Uint8Array(aiffWithChannels(2));
  infinite[28] = 0x7f; infinite[29] = 0xff;
  await refuses(infinite, 'AIFF declaring an infinite rate');
});

test('a declared data length far past the file is clamped, not trusted', async () => {
  // 0xFFFFFFFF is AU's "length unknown" sentinel, so this decodes; the point
  // is that it decodes to what the file actually holds and nothing more.
  const result = await decodeInWorker(au({ length: 0xffffffff, payload: 16 }));
  assert.equal(result.outcome, 'decoded', `expected a decode, got ${JSON.stringify(result)}`);
  assert.equal(result.frames, 8, `16 bytes of 16-bit mono is 8 frames, got ${result.frames}`);
});

test('a valid file still decodes through the same guards', async () => {
  const result = await decodeInWorker(aiffWithChannels(2, { bits: 16, frames: 4 }));
  assert.equal(result.outcome, 'decoded', `expected a decode, got ${JSON.stringify(result)}`);
  assert.equal(result.frames, 4, `16 bytes of 16-bit stereo is 4 frames, got ${result.frames}`);
});
