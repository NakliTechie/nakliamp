// Engine-side v1.x: speed on the gapless lane (P9), the mono stage after the chain (P11),
// and the output device (S6), on fake audio contexts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeContext, fakeBuffer, fakeParam, reaches } from './audio-fakes.mjs';
import { createGaplessLane, laneItem } from '../app/audio/gapless.mjs';
import { createNakliAmpEngine } from '../engine/nakliamp-engine.mjs';

function withRate(context) {
  const make = context.createBufferSource.bind(context);
  context.createBufferSource = () => { const node = make(); node.playbackRate = fakeParam(1); return node; };
  context.createChannelMerger = () => ({ kind: 'merger', outputs: new Set(), connect(target) { this.outputs.add(target); return target; }, disconnect() { this.outputs.clear(); } });
  return context;
}

test('the lane plays at the set rate and its clock counts buffer seconds', () => {
  const context = withRate(fakeContext());
  const lane = createGaplessLane({ context, destination: context.createGain(), setTimer: () => 0, clearTimer: () => {} });
  lane.load(laneItem(fakeBuffer(2, 48000 * 10, 48000)));
  lane.setRate(2);
  lane.play();
  const source = context.sources.at(-1);
  assert.equal(source.playbackRate.value, 2);
  const startedAt = source.started.when;
  context.currentTime = startedAt + 1;
  assert.ok(Math.abs(lane.position() - 2) < 1e-6, `position ${lane.position()}`);
  // Changing the rate while playing restarts at the same buffer position.
  lane.setRate(0.5);
  const restarted = context.sources.at(-1);
  assert.notEqual(restarted, source);
  assert.equal(restarted.playbackRate.value, 0.5);
  assert.ok(Math.abs(restarted.started.offset - 2) < 0.01, `offset ${restarted.started.offset}`);
  assert.equal(lane.setRate(9), 2, 'rates clamp to 2');
});

test('the gapless join is scheduled in context time at the new rate', () => {
  const context = withRate(fakeContext());
  const lane = createGaplessLane({ context, destination: context.createGain(), setTimer: () => 0, clearTimer: () => {} });
  lane.load(laneItem(fakeBuffer(2, 48000 * 10, 48000)));
  lane.setRate(2);
  lane.play();
  const startAt = context.sources.at(-1).started.when;
  lane.queue(laneItem(fakeBuffer(2, 48000 * 4, 48000)), { mode: 'gapless' });
  const plan = lane.nextScheduled();
  assert.ok(Math.abs(plan.nextStartAt - (startAt + 5)) < 1e-3, `next at ${plan.nextStartAt}, start ${startAt}`);
});

test('engine: the mono stage sits after the chain and reports its state', async () => {
  const contexts = [];
  const engine = createNakliAmpEngine({
    audioContextFactory: () => { const c = withRate(fakeContext({ decode: (buf, ctx) => ctx.createBuffer(2, 4800, 48000) })); contexts.push(c); return c; },
    softwareDecoders: [],
  });
  engine.setDsp({ gapless: 'always', mono: true });
  await engine.load(new File([new Uint8Array(64)], 'tone.wav', { type: 'audio/wav' }), { albumKey: 'a' }).catch(() => null);
  const state = engine.state();
  assert.equal(state.path, 'lane');
  {
    assert.equal(state.dsp.mono, 'on');
    const context = contexts.at(-1);
    assert.ok(reaches(context.gains[0], context.destination));
    engine.setDsp({ mono: false });
    assert.equal(engine.state().dsp.mono, 'off');
    const set = engine.setRate(1.5);
    assert.equal(set.rate, 1.5);
    assert.equal(engine.state().clock.rate, 1.5);
  }
});

test('engine: setRate clamps, and setSinkId moves contexts that support it', async () => {
  const sinks = [];
  const engine = createNakliAmpEngine({
    audioContextFactory: () => {
      const c = withRate(fakeContext({ decode: (buf, ctx) => ctx.createBuffer(2, 4800, 48000) }));
      c.sinkId = '';
      c.setSinkId = async id => { sinks.push(id); c.sinkId = id; };
      return c;
    },
  });
  assert.equal(engine.setRate(5).rate, 2);
  assert.equal(engine.setRate(0.1).rate, 0.5);
  assert.equal(engine.setRate('junk').rate, 1);
  engine.setDsp({ gapless: 'always' });
  await engine.load(new File([new Uint8Array(64)], 'tone.wav', { type: 'audio/wav' }), { albumKey: 'a' }).catch(() => null);
  const result = await engine.setSinkId('speaker-2');
  assert.equal(engine.state().path, 'lane');
  {
    assert.equal(result.supported, true);
    assert.ok(sinks.includes('speaker-2'));
    assert.equal(engine.state().dsp.sinkId, 'speaker-2');
  }
});
