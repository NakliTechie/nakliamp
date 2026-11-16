import test from 'node:test';
import assert from 'node:assert/strict';
import { createNakliAmpEngine } from '../engine/nakliamp-engine.mjs';
import { fakeBuffer, fakeContext, reaches } from './audio-fakes.mjs';

// Every fake "file" decodes to `seconds` of audio, read from its first byte.
const file = (name, seconds) => new File([new Uint8Array([seconds, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])], name);
const decode = (arrayBuffer, context) => fakeBuffer(2, new Uint8Array(arrayBuffer)[0] * context.sampleRate, context.sampleRate);

function setup() {
  const contexts = [];
  const engine = createNakliAmpEngine({
    audioContextFactory: () => {
      const context = fakeContext({ decode });
      contexts.push(context);
      return context;
    },
  });
  return { engine, contexts };
}

const album = (trackNo, extra = {}) => ({ albumKey: 'album-1', trackNo, discNo: 1, ...extra });

test('without setDsp the engine reports the chain off and never uses the lane', async () => {
  const { engine, contexts } = setup();
  assert.equal(engine.state().dsp.chain, 'off');
  assert.equal(engine.state().dsp.lane, 'normal');
  // No settings: load takes the normal ladder, which cannot play a fake file in Node.
  await assert.rejects(engine.load(file('a.mp3', 2), album(1)));
  assert.equal(contexts.length, 0, 'no lane context was made');
  engine.destroy();
});

test('album tracks play on the gapless lane through the chain and join on the exact frame', async () => {
  const { engine, contexts } = setup();
  const advanced = [];
  engine.on('track-advanced', detail => advanced.push(detail));
  engine.setDsp({
    eq: { enabled: true, preset: 'rock' },
    replayGain: { mode: 'auto', preampDb: 0, preventClipping: true },
    crossfadeS: 0,
    gapless: 'albums',
  });
  const loaded = await engine.load(file('one.flac', 3), album(1, {
    replayGain: { trackGainDb: -3, trackPeak: 0.5, albumGainDb: -5, albumPeak: 0.9 },
  }));
  assert.equal(loaded.path, 'lane');
  const context = contexts[0];
  let state = engine.state();
  assert.equal(state.path, 'lane');
  assert.equal(state.honesty.decode, 'gapless lane: decoded in full by the browser');
  assert.equal(state.honesty.gapless, true);
  assert.equal(state.dsp.chain, 'on');
  assert.equal(state.dsp.lane, 'gapless');
  assert.equal(state.media.duration, 3);

  await engine.play();
  const first = context.sources[0];
  assert.ok(reaches(first, context.destination), 'lane output reaches the destination');
  const firstFilter = [...context.gains].find(gain => [...gain.outputs].some(node => node.kind === 'biquad'));
  assert.ok(firstFilter, 'the chain input feeds the EQ filters');

  const result = await engine.preload(file('two.flac', 2), album(2, { replayGain: { trackGainDb: 1, trackPeak: 0.5, albumGainDb: -5, albumPeak: 0.9 } }));
  assert.deepEqual(result, { joined: true, mode: 'gapless' });
  const second = context.sources[1];
  assert.equal(second.started.when, first.started.when + 3);
  state = engine.state();
  assert.equal(state.dsp.gapless, true);
  assert.equal(state.dsp.gainSource, 'album', 'auto mode: the next track shares the album');
  assert.equal(state.dsp.gainDb, -5);

  context.currentTime = second.started.when + 0.5;
  state = engine.state();
  assert.equal(state.media.name, 'two.flac');
  assert.equal(state.media.duration, 2);
  assert.ok(Math.abs(state.clock.positionS - 0.5) < 1e-9);
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].join, 'gapless');
  engine.destroy();
});

test('a track from another album is not joined unless crossfade is on, then it crossfades', async () => {
  const { engine, contexts } = setup();
  engine.setDsp({ gapless: 'albums', crossfadeS: 0 });
  await engine.load(file('one.flac', 10), album(1));
  await engine.play();
  const other = { albumKey: 'album-2', trackNo: 1 };
  const refused = await engine.preload(file('x.flac', 10), other);
  assert.equal(refused.joined, false);
  assert.equal(contexts[0].sources.length, 1);

  engine.setDsp({ crossfadeS: 4 });
  // The pending item was not decoded, so setDsp starts a new preload.
  await new Promise(resolve => setTimeout(resolve, 20));
  const sources = contexts[0].sources;
  assert.equal(sources.length, 2);
  assert.ok(Math.abs(sources[1].started.when - (sources[0].started.when + 6)) < 1e-9);
  assert.equal(engine.state().dsp.next, 'crossfade');

  engine.setDsp({ crossfadeS: 0 });
  assert.equal(sources[1].stopped, true, 'turning crossfade off unschedules the next track');
  engine.destroy();
});

test('setTrackGain applies track gain with preamp and clipping prevention', async () => {
  const { engine } = setup();
  engine.setDsp({ gapless: 'always', replayGain: { mode: 'track', preampDb: 6, preventClipping: true } });
  await engine.load(file('one.flac', 2));
  const applied = engine.setTrackGain({ replayGain: { trackGainDb: 0, trackPeak: 0.8 } });
  assert.ok(Math.abs(applied.gainDb - -20 * Math.log10(0.8)) < 1e-12);
  assert.equal(applied.clipLimited, true);
  assert.equal(engine.state().dsp.clipLimited, true);
  const loudness = engine.setTrackGain({ replayGain: null, loudness: { integratedLufs: -12, truePeak: 0.3, gainDb: -6 } });
  assert.equal(loudness.source, 'loudness');
  assert.equal(loudness.gainDb, 0);
  engine.destroy();
});

test('a file neither the browser nor a NakliAmp decoder can decode falls back to the normal route', async () => {
  const engine = createNakliAmpEngine({ audioContextFactory: () => fakeContext({ decode: null }) });
  engine.setDsp({ gapless: 'always' });
  await assert.rejects(engine.load(file('odd.xyz', 2)));
  assert.equal(engine.state().dsp.laneSkipped, 'ERR_NAKLIAMP_LANE_DECODE');
  engine.destroy();
});

test('the lane falls back to an injected software decoder', async () => {
  const pcm = {
    name: 'test pcm',
    sniff: () => 'aiff',
    decode: () => ({ sampleRate: 44100, channels: [new Float32Array(44100), new Float32Array(44100)], frames: 44100 }),
  };
  const engine = createNakliAmpEngine({ audioContextFactory: () => fakeContext({ decode: null }), softwareDecoders: [pcm] });
  engine.setDsp({ gapless: 'always' });
  const loaded = await engine.load(file('a.aiff', 1));
  assert.equal(loaded.path, 'lane');
  assert.equal(engine.state().honesty.decode, 'gapless lane: decoded in full by test pcm');
  engine.destroy();
});

test('analyser taps the chain output on the lane', async () => {
  const { engine, contexts } = setup();
  engine.setDsp({ gapless: 'always' });
  await engine.load(file('a.flac', 1));
  const analyser = engine.analyser();
  assert.ok(analyser);
  const chainOutput = [...contexts[0].gains].find(gain => gain.outputs.has(contexts[0].destination));
  // In parallel, through the gain that undoes the volume (the tap reads pre-volume).
  const compensator = [...chainOutput.outputs].find(node => node.outputs?.has(analyser));
  assert.ok(compensator, 'analyser hangs off the chain output, in parallel, through the compensator');
  assert.equal(engine.analysers().length, 2);
  assert.equal(engine.state().dsp.analyserTap, 'pre-volume');
  engine.destroy();
});

test('the analyser reads before the volume stage at every volume', async () => {
  const { engine, contexts } = setup();
  engine.setDsp({ gapless: 'always' });
  await engine.load(file('a.flac', 1));
  const analyser = engine.analyser();
  const compensator = [...contexts[0].gains].find(gain => gain.outputs.has(analyser));
  assert.ok(compensator, 'no compensating gain in front of the analyser');
  engine.setVolume(0.25);
  assert.ok(Math.abs(compensator.gain.value - 4) < 1e-9, `compensation ${compensator.gain.value} at volume 0.25`);
  engine.setVolume(1);
  assert.ok(Math.abs(compensator.gain.value - 1) < 1e-9, `compensation ${compensator.gain.value} at full volume`);
  engine.setMuted(true);
  assert.equal(compensator.gain.value, 1, 'muted: nothing to undo, so the tap stays at unity');
  engine.destroy();
});
