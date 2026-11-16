// The engine's streamed R3 route, with the real libav build and a fake AudioContext.
//
// A generated five-minute stereo DSD64 file (about 212 MB) loads on R3
// without being read whole, schedules a bounded few seconds of 48 kHz PCM
// back to back, seeks near the end, refuses the gapless lane, and gives every
// libav handle back on track change and destroy.
//
// Run: node --test test/pending-dsd-engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createNakliAmpEngine } from '../engine/nakliamp-engine.mjs';
import { libavDecoder, libavInstance } from '../app/decode/libav.mjs';
import { openStreamCount, whenStreamsClosed } from '../app/decode/libav-stream.mjs';
import { fakeContext } from './audio-fakes.mjs';
import { makeLongDsf } from './pending-dsd-make.mjs';

const RATE = 48000;
const mono = await readFile(new URL('./fixtures/audio-dsd.dsf', import.meta.url)).then(buffer => new Uint8Array(buffer));

/** A File that counts whole-file reads; slices are plain Blobs and are not counted. */
class CountingFile extends File {
  wholeReads = 0;
  arrayBuffer() { this.wholeReads += 1; return super.arrayBuffer(); }
}

function setup() {
  const contexts = [];
  const engine = createNakliAmpEngine({
    nativeAudioFactory: () => { throw Object.assign(new Error('no element in Node'), { code: 'ERR_NAKLIAMP_NATIVE_UNSUPPORTED' }); },
    audioContextFactory: () => { const context = fakeContext({ sampleRate: RATE }); contexts.push(context); return context; },
    softwareDecoders: [libavDecoder],
  });
  return { engine, contexts };
}

/** Wait until `check` holds, polling; the pump runs on its own timer. */
async function until(check, label, timeoutMs = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const live = context => context.sources.filter(source => !source.stopped);
const scheduledSeconds = context => live(context).reduce((sum, source) => sum + source.buffer.length / RATE, 0);

test('a five-minute DSD64 track plays streamed on R3 with a bounded buffer, seeks and frees every handle', async () => {
  const instance = await libavInstance();
  const long = makeLongDsf(mono, 300);
  const file = new CountingFile(long.parts, 'long.dsf');
  const { engine, contexts } = setup();

  // Warm-up load: codec tables built on first use are not a per-track leak.
  await engine.load(new File([mono], 'short.dsf'));
  engine.destroy();
  await whenStreamsClosed();
  const baseline = await instance.mallinfo_uordblks();

  const loaded = await engine.load(file);
  assert.equal(loaded.path, 'r3');
  assert.ok(Math.abs(loaded.duration - long.seconds) < 1e-9);
  assert.equal(file.wholeReads, 0, 'the 212 MB file was never read whole');
  const state = engine.state();
  assert.equal(state.honesty.decode, 'software decode, streamed (libav wasm)');
  assert.equal(state.track.sampleRate, RATE, 'DSD leaves libav at the context rate, not 352.8 kHz');
  assert.equal(state.track.channels, 2);

  const context = contexts.at(-1);
  await engine.play();
  assert.ok(live(context).length >= 1, 'play resolves with audio scheduled');
  await until(() => scheduledSeconds(context) >= 3, 'three seconds scheduled');
  await new Promise(resolve => setTimeout(resolve, 600));
  // The bound: at most STREAM_AHEAD_S (3 s) ahead plus one chunk of about 0.5 s.
  assert.ok(scheduledSeconds(context) < 3.7, `${scheduledSeconds(context)} s scheduled ahead`);
  const starts = live(context).map(source => [source.started.when, source.buffer.length / RATE]);
  for (let index = 1; index < starts.length; index += 1) {
    const [when, length] = starts[index - 1];
    assert.ok(Math.abs(when + length - starts[index][0]) < 1e-9, `chunk ${index} starts where chunk ${index - 1} ends`);
  }

  // The clock follows the context.
  context.currentTime = starts[0][0] + 1.5;
  assert.ok(Math.abs(engine.state().clock.positionS - 1.5) < 1e-6, `position ${engine.state().clock.positionS}`);

  // Seek near the end while playing: old sources stop, new ones start at the target.
  const before = context.sources.length;
  await engine.seek(297.25);
  assert.ok(context.sources.slice(0, before).every(source => source.stopped), 'every earlier source stopped');
  assert.ok(Math.abs(engine.state().clock.positionS - 297.25) < 1e-6, `after seek ${engine.state().clock.positionS}`);

  // Pause keeps the place; play resumes there. The clock never runs past the
  // audio already scheduled, so wait for the pump to fill past the half second.
  await until(() => scheduledSeconds(context) >= 2, 'refilled after the seek');
  context.currentTime = live(context)[0].started.when + 0.5;
  engine.pause();
  const paused = engine.state().clock.positionS;
  assert.ok(Math.abs(paused - 297.75) < 1e-6, `paused at ${paused}`);
  await engine.play();
  assert.ok(Math.abs(engine.state().clock.positionS - paused) < 1e-6);

  // Track change frees the stream; destroy frees the rest.
  assert.equal(openStreamCount(), 1);
  await engine.load(new File([mono], 'short.dsf'));
  engine.destroy();
  await whenStreamsClosed();
  assert.equal(openStreamCount(), 0);
  assert.equal(await instance.mallinfo_uordblks(), baseline, 'the wasm heap returns to baseline after track change and destroy');
});

test('a streamed file skips the gapless lane without being read whole', async () => {
  const file = new CountingFile([mono], 'short.dsf');
  const { engine } = setup();
  engine.setDsp({ gapless: 'always' });
  const loaded = await engine.load(file, { albumKey: 'a', trackNo: 1, discNo: 1 });
  assert.equal(loaded.path, 'r3');
  assert.equal(engine.state().dsp.laneSkipped, 'ERR_NAKLIAMP_LANE_STREAMED');
  assert.equal(file.wholeReads, 0);
  engine.destroy();
  await whenStreamsClosed();
});
