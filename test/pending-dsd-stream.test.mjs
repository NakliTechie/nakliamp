// Streamed DSD decode (plan/pending.md: "DSD decodes but is impractical at length").
//
// Runs the real vendored libav build in Node:
// 1. DSF header parsing, seek arithmetic and tail-header rewrite (pure).
// 2. A generated five-minute stereo DSD64 file (about 212 MB) streams at
//    48 kHz in half-second chunks, with no input bound and no whole read.
// 3. Seek lands on the exact target, near the start and near the end.
// 4. Every libav handle is freed: the wasm heap returns to its baseline after
//    open, read, seek and close, and after a refused open.
// 5. A non-DSD container streams to the same samples as its whole-file decode.
//
// Run: node --test test/pending-dsd-stream.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { decodeLibav, libavInstance, streamLibav, libavDecoder } from '../app/decode/libav.mjs';
import {
  parseDsf, dsfSeekPoint, dsfTailHeader, shouldStream, openStreamCount, whenStreamsClosed, STREAM_MIN_BYTES,
} from '../app/decode/libav-stream.mjs';
import { makeLongDsf } from './pending-dsd-make.mjs';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url)).then(buffer => new Uint8Array(buffer));
const RATE = 48000;

test('the DSF header of the fixture parses to its known layout', async () => {
  const info = parseDsf(await fixture('audio-dsd.dsf'));
  assert.equal(info.channels, 1);
  assert.equal(info.dsdRate, 2822400);
  assert.equal(info.pcmRate, 352800);
  assert.equal(info.blockSize, 4096);
  assert.equal(info.headerBytes, 92);
  assert.equal(info.dataBytes, 87 * 4096);
  assert.equal(info.sampleCount, 2850816);
  assert.equal(parseDsf(new Uint8Array(200)), null, 'not a DSF');
});

test('DSF seek arithmetic lands on the block group at or before the target', async () => {
  const long = makeLongDsf(await fixture('audio-dsd.dsf'), 300);
  const info = parseDsf(long.parts[0]);
  assert.equal(info.channels, 2);
  const groupS = (4096 * 8) / 2822400; // 11.61 ms
  const point = dsfSeekPoint(info, 123.4567);
  assert.equal(point.index, Math.floor(123.4567 / groupS));
  assert.ok(point.seconds <= 123.4567 && 123.4567 - point.seconds < groupS);
  assert.equal(point.byteOffset, 92 + point.index * 4096 * 2);
  assert.equal(dsfSeekPoint(info, -5).index, 0);
  assert.equal(dsfSeekPoint(info, 1e9).index, long.groups - 1, 'a seek past the end clamps to the last group');

  const tail = parseDsf(dsfTailHeader(long.parts[0], info, point));
  assert.equal(tail.dataBytes, info.dataBytes - point.index * 4096 * 2);
  assert.equal(tail.sampleCount, info.sampleCount - point.index * 4096 * 8);
  assert.equal(tail.headerBytes, info.headerBytes);
});

test('DSD always streams; other containers stream above 64 MB', () => {
  assert.equal(shouldStream('dsd', 1000), true);
  assert.equal(shouldStream('wavpack', STREAM_MIN_BYTES), false);
  assert.equal(shouldStream('wavpack', STREAM_MIN_BYTES + 1), true);
  assert.equal(libavDecoder.streams, shouldStream);
  assert.equal(libavDecoder.stream, streamLibav);
});

test('a five-minute stereo DSD64 file streams at 48 kHz, seeks exactly and frees every handle', async () => {
  const instance = await libavInstance();
  const long = makeLongDsf(await fixture('audio-dsd.dsf'), 300);
  const blob = new Blob(long.parts);
  assert.ok(blob.size > 200 * 1024 * 1024, `the generated file is ${blob.size} bytes`);

  // Warm-up: the decoder and resampler build static tables on first use.
  const warm = await streamLibav(blob, { container: 'dsd', outputRate: RATE });
  await warm.read();
  await warm.close();
  const baseline = await instance.mallinfo_uordblks();

  const stream = await streamLibav(blob, { container: 'dsd', outputRate: RATE });
  assert.equal(stream.sampleRate, RATE);
  assert.equal(stream.channelCount, 2);
  assert.ok(Math.abs(stream.durationS - long.seconds) < 1e-9);
  // The compressed side of the memory bound: half a second of input per read.
  assert.equal(stream.readLimit(), Math.round((blob.size / long.seconds) * 0.5));

  let expectedS = 0;
  for (let index = 0; index < 6; index += 1) {
    const chunk = await stream.read();
    assert.equal(chunk.channels.length, 2);
    assert.ok(chunk.frames > 0.4 * RATE && chunk.frames < 0.6 * RATE, `chunk ${index} holds ${chunk.frames} frames`);
    assert.ok(Math.abs(chunk.startS - expectedS) < 1e-3, `chunk ${index} starts at ${chunk.startS}, expected ${expectedS}`);
    expectedS = chunk.startS + chunk.frames / RATE;
    assert.ok(chunk.channels[0].some(sample => Math.abs(sample) > 0.1), 'the left channel carries signal');
    assert.notDeepEqual(chunk.channels[0].subarray(0, 512), chunk.channels[1].subarray(0, 512), 'the channels differ');
  }

  for (const target of [295.003, 12.25, 0.5]) {
    await stream.seek(target);
    const chunk = await stream.read();
    assert.ok(Math.abs(chunk.startS - target) < 1 / RATE, `seek to ${target} landed at ${chunk.startS}`);
  }

  await stream.seek(296);
  let last = null;
  for (let chunk = await stream.read(); chunk; chunk = await stream.read()) last = chunk;
  const endS = last.startS + last.frames / RATE;
  assert.ok(Math.abs(endS - long.seconds) < 0.01, `the stream ended at ${endS}, the file lasts ${long.seconds}`);
  assert.equal(await stream.read(), null, 'reads after the end return null');

  assert.ok(await instance.mallinfo_uordblks() > baseline, 'an open stream holds wasm memory');
  await stream.close();
  await whenStreamsClosed();
  assert.equal(openStreamCount(), 0);
  assert.equal(await instance.mallinfo_uordblks(), baseline, 'the wasm heap returns to baseline after close');
});

test('a refused stream frees its handles and names the failure', async () => {
  const instance = await libavInstance();
  const broken = new Uint8Array(4096);
  broken.set([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]); // ASF GUID, no stream
  await assert.rejects(streamLibav(new Blob([broken]), { container: 'wma', outputRate: RATE }));
  const baseline = await instance.mallinfo_uordblks();
  for (let round = 0; round < 10; round += 1) {
    await assert.rejects(
      streamLibav(new Blob([broken]), { container: 'wma', outputRate: RATE }),
      error => error.name === 'LibavDecodeError' && error.code.startsWith('ERR_NAKLIAMP_LIBAV_'),
    );
    await assert.rejects(
      streamLibav(new Blob([broken.subarray(0, 64)]), { container: 'dsd', outputRate: RATE }),
      error => error.code === 'ERR_NAKLIAMP_LIBAV_FAILED',
    );
  }
  assert.equal(openStreamCount(), 0);
  assert.equal(await instance.mallinfo_uordblks(), baseline, 'refused opens leak nothing');
});

test('a non-DSD container streams to the same samples as its whole-file decode, and seeks', async () => {
  const bytes = await fixture('audio-wavpack.wv');
  const whole = await decodeLibav(bytes);
  const stream = await streamLibav(new Blob([bytes]), { container: 'wavpack', outputRate: whole.sampleRate });
  const parts = [];
  for (let chunk = await stream.read(); chunk; chunk = await stream.read()) parts.push(chunk);
  const frames = parts.reduce((sum, chunk) => sum + chunk.frames, 0);
  assert.equal(frames, whole.frames, 'same frame count at the source rate');
  let offset = 0;
  for (const chunk of parts) {
    for (let channel = 0; channel < whole.channels.length; channel += 1) {
      assert.deepEqual(chunk.channels[channel], whole.channels[channel].subarray(offset, offset + chunk.frames));
    }
    offset += chunk.frames;
  }

  await stream.seek(3.2);
  const chunk = await stream.read();
  assert.ok(Math.abs(chunk.startS - 3.2) < 1 / whole.sampleRate, `seek to 3.2 landed at ${chunk.startS}`);
  const at = Math.round(3.2 * whole.sampleRate);
  assert.deepEqual(chunk.channels[0].subarray(0, 256), whole.channels[0].subarray(at, at + 256), 'samples after the seek match');
  await stream.close();
});
