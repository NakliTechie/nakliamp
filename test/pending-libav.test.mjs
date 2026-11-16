// The two wasm-tier verification gaps named in plan/pending.md, run through
// the real vendored libav build in Node.
//
// 1. Truncating read: a track whose container carries a second stream (cover
//    art) must decode whole. The read loop once ended at the first batch that
//    held no packets for the audio stream, which with cover art is the first
//    batch of all.
// 2. Freed handles: the wasm heap's allocated byte count returns to its
//    baseline after a run of decodes, successful and refused. This replaces
//    a soak that only showed the tier still worked afterwards.
//
// Run: node --test test/pending-libav.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { decodeLibav, libavInstance } from '../app/decode/libav.mjs';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url)).then(buffer => new Uint8Array(buffer));

// The ASF header GUID followed by nothing usable: sniffs as WMA, fails to demux.
const brokenWma = () => {
  const bytes = new Uint8Array(4096);
  bytes.set([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);
  return bytes;
};

/** Packets per stream index in each batch of a demux at `limit` bytes per batch. */
async function batchShapes(instance, data, limit, count) {
  const name = 'pending-shape.m4a';
  await instance.writeFile(name, data);
  const [format, streams] = await instance.ff_init_demuxer_file(name);
  const packet = await instance.av_packet_alloc();
  const shapes = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const [, batch] = await instance.ff_read_frame_multi(format, packet, { limit });
      shapes.push(Object.fromEntries(Object.entries(batch).map(([stream, list]) => [stream, list.length])));
    }
  } finally {
    await instance.av_packet_free_js(packet);
    await instance.avformat_close_input_js(format);
    await instance.unlink(name);
  }
  return { streams, shapes };
}

test('the second-stream fixture opens with a batch that holds only its cover art', async () => {
  const instance = await libavInstance();
  const { streams, shapes } = await batchShapes(instance, await fixture('audio-alac-cover.m4a'), 1, 2);
  const audio = streams.find(stream => stream.codec_type === instance.AVMEDIA_TYPE_AUDIO);
  const other = streams.find(stream => stream.codec_type !== instance.AVMEDIA_TYPE_AUDIO);
  assert.equal(streams.length, 2, 'the fixture must carry exactly two streams');
  assert.ok(audio && other, 'one audio stream and one other stream');
  // This is the batch that ended the old read loop with zero frames.
  assert.deepEqual(shapes[0], { [other.index]: 1 });
  assert.deepEqual(shapes[1], { [audio.index]: 1 });
});

test('a track with a second stream decodes whole, at every batch size', async () => {
  const plain = await decodeLibav(await fixture('audio-alac.m4a'));
  const cover = await fixture('audio-alac-cover.m4a');
  assert.equal(plain.frames, 88200, 'the one-stream ALAC fixture is two seconds at 44.1 kHz');
  for (const readLimit of [1, 4096, undefined]) {
    const decoded = await decodeLibav(cover, readLimit ? { readLimit } : {});
    assert.equal(decoded.frames, plain.frames, `readLimit ${readLimit ?? 'default'} decoded ${decoded.frames} frames`);
    assert.equal(decoded.sampleRate, plain.sampleRate);
    assert.equal(decoded.channels.length, plain.channels.length);
    for (let channel = 0; channel < plain.channels.length; channel += 1) {
      assert.deepEqual(decoded.channels[channel], plain.channels[channel], `channel ${channel} differs`);
    }
  }
});

test('the wasm heap returns to its baseline after 40 decodes, successful and refused', async () => {
  const instance = await libavInstance();
  const cover = await fixture('audio-alac-cover.m4a');
  const wavpack = await fixture('audio-wavpack.wv');

  // Warm up once per path: a codec's first open may build static tables that
  // live for the life of the module, and those are not a per-decode leak.
  await decodeLibav(cover);
  await decodeLibav(wavpack);
  await assert.rejects(decodeLibav(brokenWma()));

  const baseline = await instance.mallinfo_uordblks();
  let refused = 0;
  for (let round = 0; round < 10; round += 1) {
    await decodeLibav(cover, { readLimit: 4096 });
    await decodeLibav(wavpack);
    try { await decodeLibav(brokenWma()); } catch { refused += 1; }
    try { await decodeLibav(cover.subarray(0, 2048)); } catch { refused += 1; }
  }
  const after = await instance.mallinfo_uordblks();
  assert.equal(refused, 20, 'every malformed file is refused');
  assert.equal(after, baseline, `the wasm heap holds ${after - baseline} bytes more after 40 decodes`);

  // The count sees a single leaked handle, so an unchanged count means none leaked.
  const leaked = await instance.av_packet_alloc();
  const withLeak = await instance.mallinfo_uordblks();
  await instance.av_packet_free_js(leaked);
  assert.ok(withLeak > baseline, 'one unfreed packet raises the allocated byte count');
  assert.equal(await instance.mallinfo_uordblks(), baseline);
});
