// Regression tests for review findings N4, N41 (gapless lane gains), N21
// (headroom), N20 and N40 (PCM decoder) and N22 (libav frame collection).
// Review: plan/review-fable-2026-11-17.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGaplessLane, laneItem } from '../app/audio/gapless.mjs';
import { createChain, resolveTrackGain } from '../app/audio/chain.mjs';
import { decodePcm, pcmDecoder, streamPcm, streamsPcm, PCM_STREAM_MIN_BYTES } from '../app/decode/pcm.mjs';
import { readAllFrames } from '../app/decode/libav.mjs';
import { createNakliAmpEngine } from '../engine/nakliamp-engine.mjs';
import { fakeBuffer, fakeContext } from './audio-fakes.mjs';

// ---- An AudioParam with a real automation timeline --------------------------
//
// Follows the Web Audio rules that matter here: cancelScheduledValues(t)
// removes events at or after t and a curve still running at t; a value event
// inside a running curve's range, or a curve overlapping another event, throws
// NotSupportedError, as Chrome does.

function timelineParam(initial = 1) {
  let intrinsic = initial;
  const events = [];
  const notSupported = () => Object.assign(new Error('NotSupportedError: overlaps a curve'), { name: 'NotSupportedError' });
  const insideCurve = time => events.some(event => event.type === 'curve' && time >= event.time && time < event.end);
  const add = event => { events.push(event); events.sort((a, b) => a.time - b.time); };
  const param = {
    get value() { return intrinsic; },
    set value(v) { intrinsic = v; },
    setValueAtTime(value, time) { if (insideCurve(time)) throw notSupported(); add({ type: 'set', time, value }); },
    setTargetAtTime(target, time, constant) { if (insideCurve(time)) throw notSupported(); add({ type: 'target', time, target, constant }); },
    setValueCurveAtTime(curve, time, duration) {
      const end = time + duration;
      if (insideCurve(time) || events.some(event => event.time > time && event.time < end)) throw notSupported();
      add({ type: 'curve', time, end, curve: Array.from(curve) });
    },
    cancelScheduledValues(time) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.time >= time || (event.type === 'curve' && event.end > time)) events.splice(index, 1);
      }
    },
    /** The value at context time `t`. */
    at(t) {
      let value = intrinsic;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.time > t) break;
        const until = Math.min(t, events[index + 1]?.time ?? Infinity);
        if (event.type === 'set') value = event.value;
        else if (event.type === 'target') value = event.target + (value - event.target) * Math.exp(-(until - event.time) / event.constant);
        else if (until >= event.end) value = event.curve.at(-1);
        else {
          const position = ((until - event.time) / (event.end - event.time)) * (event.curve.length - 1);
          const low = Math.floor(position);
          value = event.curve[low] + (event.curve[Math.min(low + 1, event.curve.length - 1)] - event.curve[low]) * (position - low);
        }
      }
      return value;
    },
  };
  return param;
}

function timelineContext() {
  const context = fakeContext();
  const createGain = context.createGain.bind(context);
  context.createGain = () => { const node = createGain(); node.gain = timelineParam(1); return node; };
  return context;
}

/** A source's audible gain at time t: the product of every gain stage between it and the destination. */
function gainAt(source, destination, t) {
  let total = 1;
  let node = [...source.outputs][0];
  while (node && node !== destination) {
    total *= node.gain.at(t);
    node = [...node.outputs][0];
  }
  return total;
}

function crossfadeLane() {
  const context = timelineContext();
  const destination = context.createGain();
  const lane = createGaplessLane({ context, destination, setTimer: () => 0, clearTimer: () => {} });
  const item = (name, seconds, gainDb = 0) => ({ ...laneItem(fakeBuffer(2, seconds * 48000, 48000), {}), name, gainDb });
  return { context, destination, lane, item };
}

test('N4: preloading the next track during a fade-in keeps the incoming track audible', () => {
  const { context, destination, lane, item } = crossfadeLane();
  lane.load(item('a', 10));
  lane.play();
  lane.queue(item('b', 10), { mode: 'crossfade', fadeS: 4 });
  const b = context.sources[1];
  const bStart = b.started.when;
  context.currentTime = bStart + 0.5;
  lane.position();
  assert.equal(lane.current().name, 'b');
  // The shell preloads C at once, inside B's fade-in.
  lane.queue(item('c', 10), { mode: 'crossfade', fadeS: 4 });
  const c = context.sources[2];
  assert.ok(Math.abs(c.started.when - (bStart + 6)) < 1e-6, 'C starts 4 s before B ends');
  const midFadeIn = gainAt(b, destination, bStart + 2);
  assert.ok(Math.abs(midFadeIn - Math.sin(Math.PI / 4)) < 0.02, `B halfway through its fade-in is at ${midFadeIn}`);
  const solo = gainAt(b, destination, bStart + 5);
  assert.ok(Math.abs(solo - 1) < 1e-6, `B between its fade-in and fade-out is at ${solo}, not 1`);
  const fadingOut = gainAt(b, destination, bStart + 8);
  assert.ok(Math.abs(fadingOut - Math.cos(Math.PI / 4)) < 0.02, `B halfway through its fade-out is at ${fadingOut}`);
});

test('N4: replacing the queued next track does not jump the current fade-in to full', () => {
  const { context, destination, lane, item } = crossfadeLane();
  lane.load(item('a', 10));
  lane.play();
  lane.queue(item('b', 10), { mode: 'crossfade', fadeS: 4 });
  const b = context.sources[1];
  const bStart = b.started.when;
  context.currentTime = bStart + 0.5;
  lane.position();
  lane.queue(item('c', 10), { mode: 'crossfade', fadeS: 4 });
  lane.queue(item('d', 10), { mode: 'crossfade', fadeS: 4 });
  const midFadeIn = gainAt(b, destination, bStart + 2);
  assert.ok(Math.abs(midFadeIn - Math.sin(Math.PI / 4)) < 0.02, `B halfway through its fade-in is at ${midFadeIn}`);
  assert.ok(Math.abs(gainAt(b, destination, bStart + 8) - Math.cos(Math.PI / 4)) < 0.02, 'D still fades B out');
});

test('N41: a ReplayGain change during a fade-in is applied, not dropped', () => {
  const { context, destination, lane, item } = crossfadeLane();
  lane.load(item('a', 10));
  lane.play();
  lane.queue(item('b', 10), { mode: 'crossfade', fadeS: 4 });
  const b = context.sources[1];
  const bStart = b.started.when;
  context.currentTime = bStart + 1;
  lane.position();
  lane.setCurrentGainDb(-6);
  const settled = gainAt(b, destination, bStart + 5);
  assert.ok(Math.abs(settled - Math.pow(10, -6 / 20)) < 1e-3, `B after its fade-in is at ${settled}, not -6 dB`);
});

test('N41: a ReplayGain change while the next crossfade is scheduled is applied', () => {
  const { context, destination, lane, item } = crossfadeLane();
  lane.load(item('a', 10));
  lane.play();
  const a = context.sources[0];
  lane.queue(item('b', 10), { mode: 'crossfade', fadeS: 4 });
  context.currentTime = 1;
  lane.setCurrentGainDb(-6);
  assert.ok(Math.abs(gainAt(a, destination, 4) - Math.pow(10, -6 / 20)) < 1e-3, 'A is at -6 dB before its fade-out');
});

test('lane: a natural end is reported once; a stop from pause is not', () => {
  const context = fakeContext();
  const ends = [];
  const lane = createGaplessLane({ context, destination: context.createGain(), onEnded: item => ends.push(item.name), setTimer: () => 0, clearTimer: () => {} });
  lane.load({ ...laneItem(fakeBuffer(2, 48000, 48000), {}), name: 'a' });
  lane.play();
  const first = context.sources[0];
  lane.pause();
  assert.equal(first.onended, null, 'pause clears the stopped source handler');
  lane.play();
  context.currentTime = 2;
  context.sources[1].onended();
  assert.deepEqual(ends, ['a']);
});

// ---- Headroom (N21) -----------------------------------------------------------

test('N21: an EQ boost lowers the output stage by the largest band boost', () => {
  const context = fakeContext();
  const chain = createChain(context);
  chain.setEq({ enabled: true, preset: 'bass-boost' });
  assert.ok(Math.abs(chain.output.gain.value - Math.pow(10, -8 / 20)) < 1e-12, `output gain ${chain.output.gain.value}`);
  assert.equal(chain.preampDb(), -8);
  chain.setEq({ enabled: false });
  assert.equal(chain.output.gain.value, 1, 'flat EQ leaves unity');
});

test('N21: clipping prevention treats an unknown peak as full scale', () => {
  const gain = resolveTrackGain({ mode: 'track', preampDb: 0, preventClipping: true }, { replayGain: { trackGainDb: 9, trackPeak: null } });
  assert.equal(gain.gainDb, 0);
  assert.equal(gain.clipLimited, true);
  const quieter = resolveTrackGain({ mode: 'track', preventClipping: true }, { replayGain: { trackGainDb: -4, trackPeak: null } });
  assert.deepEqual([quieter.gainDb, quieter.clipLimited], [-4, false]);
  const off = resolveTrackGain({ mode: 'track', preventClipping: false }, { replayGain: { trackGainDb: 9, trackPeak: null } });
  assert.equal(off.gainDb, 9, 'the person turned clipping prevention off');
});

// ---- PCM decoder (N20, N40) ----------------------------------------------------

/** A 16-bit little-endian mono AU file of `frames` frames at `rate`. */
function au(frames, rate = 8000, encoding = 3) {
  const bytes = new Uint8Array(24 + frames * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0x2e, 0x73, 0x6e, 0x64]);
  view.setUint32(4, 24);
  view.setUint32(8, frames * 2);
  view.setUint32(12, encoding);
  view.setUint32(16, rate);
  view.setUint32(20, 1);
  for (let index = 0; index < frames; index += 1) view.setInt16(24 + index * 2, (index % 200) * 100);
  return bytes;
}

test('N40: a sample rate outside what an AudioBuffer accepts is refused by name', () => {
  assert.throws(() => decodePcm(au(16, 1)), error => error.code === 'ERR_NAKLIAMP_PCM_UNSUPPORTED' && /1 Hz/.test(error.message));
  assert.throws(() => decodePcm(au(16, 2_000_000)), error => error.code === 'ERR_NAKLIAMP_PCM_UNSUPPORTED');
  assert.equal(decodePcm(au(16, 8000)).frames, 16);
});

test('N20: a whole decode over the size limit is refused before it allocates', () => {
  assert.throws(
    () => decodePcm(au(1000), { maxDecodedBytes: 1000 }),
    error => error.code === 'ERR_NAKLIAMP_PCM_TOO_LARGE',
  );
  assert.equal(decodePcm(au(1000), { maxDecodedBytes: 4000 }).frames, 1000);
});

test('N20: large PCM files stream; small ones decode whole', () => {
  assert.equal(streamsPcm('aiff', PCM_STREAM_MIN_BYTES + 1), true);
  assert.equal(streamsPcm('aiff', PCM_STREAM_MIN_BYTES), false);
  assert.equal(streamsPcm('flac', PCM_STREAM_MIN_BYTES * 2), false);
  assert.equal(pcmDecoder.streams, streamsPcm);
  assert.equal(pcmDecoder.decode, decodePcm);
});

test('N20: the streamed reader returns the same samples as a whole decode, in slices, and seeks', async () => {
  const bytes = au(20_000, 8000);
  const whole = decodePcm(bytes);
  class CountingBlob extends Blob { slices = []; slice(start, end) { this.slices.push([start, end]); return super.slice(start, end); } }
  const blob = new CountingBlob([bytes]);
  const stream = await streamPcm(blob, { container: 'au' });
  assert.equal(stream.sampleRate, 8000);
  assert.equal(stream.channelCount, 1);
  assert.equal(stream.durationS, 2.5);
  const out = new Float32Array(whole.frames);
  let at = 0;
  for (let chunk = await stream.read(); chunk; chunk = await stream.read()) {
    assert.ok(chunk.frames <= 4000, 'about half a second per read');
    assert.ok(Math.abs(chunk.startS - at / 8000) < 1e-9);
    out.set(chunk.channels[0], at);
    at += chunk.frames;
  }
  assert.equal(at, whole.frames);
  assert.deepEqual(out, whole.channels[0]);
  assert.ok(blob.slices.every(([start, end]) => end - start <= 256 * 1024), 'never read whole');
  await stream.seek(2);
  const tail = await stream.read();
  assert.equal(tail.startS, 2);
  assert.deepEqual(tail.channels[0], whole.channels[0].subarray(16000, 20000));
  await stream.close();
  assert.equal(await stream.read(), null);
});

test('N20: the engine plays a streamed PCM file on the software route', async () => {
  const bytes = au(20_000, 8000);
  const contexts = [];
  const engine = createNakliAmpEngine({
    nativeAudioFactory: () => { throw Object.assign(new Error('no element'), { code: 'ERR_NAKLIAMP_NATIVE_UNSUPPORTED' }); },
    // Stream every size here, so a small fixture takes the large-file path.
    softwareDecoders: [{ ...pcmDecoder, streams: () => true }],
    audioContextFactory: () => { const context = fakeContext({ sampleRate: 48000 }); contexts.push(context); return context; },
  });
  const loaded = await engine.load(new File([bytes], 'long.au'));
  assert.equal(loaded.path, 'r3');
  assert.equal(engine.state().honesty.decode, 'software decode, streamed (in-house PCM)');
  await engine.play();
  const context = contexts.at(-1);
  assert.ok(context.sources.length >= 1, 'a chunk was scheduled');
  assert.equal(context.sources[0].buffer.sampleRate, 8000);
  engine.destroy();
});

// ---- libav frame collection (N22) ------------------------------------------------

test('N22: one batch that decodes to 300,000 frames is collected without a RangeError', async () => {
  const count = 300_000;
  const instance = {
    AVERROR_EOF: -541478725,
    ff_read_frame_multi: async () => [-541478725, { 0: [{}] }],
    ff_decode_multi: async () => Array.from({ length: count }, (_, index) => index),
  };
  const frames = await readAllFrames(instance, { format: 1, context: 2, packet: 3, frame: 4 }, 0, 1);
  assert.equal(frames.length, count);
  assert.equal(frames[count - 1], count - 1);
});
