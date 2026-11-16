// The agent-face gaps closed on 2026-11-17: spectrum.get, queue.play, history.clear,
// playlist.rename, playlist.remove, the snapshot's playlist name and if_revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logBandEdges, spectrumBands, readSpectrum, DEFAULT_BANDS } from '../app/agent/spectrum.mjs';
import { createQueue, revisionConflict } from '../app/player/queue.mjs';
import { bindCommands } from '../app/commands/run.mjs';
import { COMMANDS, commandByName, ERROR_CODES } from '../app/commands/commands.mjs';
import { buildSnapshot, diffSnapshots, channelRefusal } from '../app/agent/events.mjs';
import { buildCommandRequest, commandMenu } from '../app/ai/command-bar.mjs';

test('spectrum: log band edges run from 20 Hz to 20 kHz, evenly on a log scale', () => {
  const edges = logBandEdges(32);
  assert.equal(edges.length, 33);
  assert.ok(Math.abs(edges[0] - 20) < 1e-9 && Math.abs(edges[32] - 20000) < 1e-6);
  const ratios = edges.slice(1).map((v, i) => v / edges[i]);
  for (const r of ratios) assert.ok(Math.abs(r - ratios[0]) < 1e-9);
  assert.throws(() => logBandEdges(0), RangeError);
  assert.throws(() => logBandEdges(4, 100, 50), RangeError);
});

test('spectrum: bins fold into 32 bands, 0 to 1, a tone lands in the band that holds it', () => {
  const sampleRate = 48000;
  const bins = new Uint8Array(1024); // fftSize 2048: 23.4 Hz per bin
  const hzPerBin = sampleRate / 2 / bins.length;
  bins[Math.round(1000 / hzPerBin)] = 255; // a 1 kHz tone at full level
  const { bands, edgesHz } = spectrumBands(bins, sampleRate, DEFAULT_BANDS);
  assert.equal(bands.length, 32);
  assert.ok(bands.every(v => v >= 0 && v <= 1));
  const hit = bands.indexOf(1);
  assert.ok(hit >= 0, 'no band at full level');
  assert.ok(edgesHz[hit] <= 1000 && edgesHz[hit + 1] >= 1000, `1 kHz landed in ${edgesHz[hit]}..${edgesHz[hit + 1]} Hz`);
  assert.equal(bands.filter(v => v > 0).length, 1, 'the tone leaked into another band');
});

test('spectrum: low bands narrower than one bin read the nearest bin; silence is all zeros', () => {
  const bins = new Uint8Array(64).fill(0);
  bins[0] = 128; // 375 Hz bins at 48 kHz: the bands below about 190 Hz all round to bin 0
  bins[1] = 64;
  const { bands, edgesHz } = spectrumBands(bins, 48000, 16);
  assert.equal(bands.length, 16);
  assert.deepEqual(bands.slice(0, 4), [0.502, 0.502, 0.502, 0.502], 'narrow low bands did not read the nearest bin');
  const at375 = edgesHz.findIndex((edge, i) => edge <= 375 && edgesHz[i + 1] >= 375);
  assert.equal(bands[at375], 0.251);
  assert.deepEqual(spectrumBands(new Uint8Array(256), 44100, 8).bands, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(spectrumBands(new Uint8Array(0), 44100, 8).bands, []);
});

test('spectrum: readSpectrum is empty when nothing plays or no analyser, a frame otherwise', () => {
  const analyser = {
    frequencyBinCount: 512,
    context: { sampleRate: 44100 },
    getByteFrequencyData(out) { out.fill(51); },
  };
  assert.deepEqual(readSpectrum(analyser, { playing: false }).bands, []);
  assert.deepEqual(readSpectrum(null, { playing: true }).bands, []);
  const frame = readSpectrum(analyser, { count: 8, playing: true });
  assert.equal(frame.bands.length, 8);
  assert.ok(frame.bands.every(v => v === 0.2));
  assert.equal(frame.playing, true);
  assert.equal(frame.maxHz, 20000);
});

test('queue revision moves on every change listeners hear, and not otherwise', () => {
  const q = createQueue({ storage: null });
  assert.equal(q.revision(), 0);
  q.set(['a', 'b', 'c']);
  assert.equal(q.snapshot().revision, 1);
  q.move(0, 2);
  q.jump(1);
  q.setRepeat('all');
  assert.equal(q.revision(), 4);
  q.setRepeat('all'); // no change, no event
  q.setShuffle('off');
  assert.equal(q.revision(), 4);
  assert.equal(revisionConflict(undefined, 4), null);
  assert.equal(revisionConflict(4, 4), null);
  assert.match(revisionConflict(3, 4), /revision 3.*revision 4/);
});

test('if_revision: queue edits accept it, a stale one is refused with [conflict] before the handler runs', async () => {
  const q = createQueue({ storage: null });
  q.set(['a', 'b']);
  const seen = [];
  const run = bindCommands({
    'queue.clear': input => { seen.push(input); q.clear(); return { length: 0 }; },
    'queue.read': input => { seen.push(input); return {}; },
  }, { revision: () => q.revision() });
  await assert.rejects(run('queue.clear', { if_revision: 0 }), error => error.code === 'conflict' && /\[conflict\]/.test(error.message));
  assert.equal(seen.length, 0, 'the handler ran on a stale revision');
  assert.equal(q.snapshot().length, 2);
  await run('queue.clear', { if_revision: q.revision() });
  assert.deepEqual(seen, [{}], 'the handler saw if_revision');
  await run('queue.clear', {}); // no if_revision: no check
  await assert.rejects(run('queue.read', { if_revision: 1 }), error => error.code === 'invalid-input');
  await assert.rejects(run('queue.clear', { if_revision: -1 }), error => error.code === 'invalid-input');
});

test('if_revision is on every queue edit and on nothing else; conflict is a documented code', () => {
  const guarded = COMMANDS.filter(c => c.input.properties?.if_revision).map(c => c.name).sort();
  assert.deepEqual(guarded, ['queue.add', 'queue.clear', 'queue.move', 'queue.play', 'queue.play_next', 'queue.remove', 'queue.set', 'queue.shuffle']);
  for (const name of guarded) assert.equal(commandByName.get(name).ifRevision, true, name);
  assert.ok(ERROR_CODES.some(([code]) => code === 'conflict'));
  // The command bar's prompt leaves the guard out: a typed request never carries it.
  assert.doesNotMatch(JSON.stringify(buildCommandRequest('clear the queue', commandMenu())), /if_revision/);
});

test('new commands: scopes, inputs, and channel acceptance', () => {
  const scope = name => commandByName.get(name)?.scope;
  assert.equal(scope('spectrum.get'), 'read');
  assert.equal(scope('queue.play'), 'reversible');
  assert.equal(scope('playlist.rename'), 'reversible');
  assert.equal(scope('history.clear'), 'destructive');
  assert.equal(scope('playlist.remove'), 'destructive');
  assert.equal(scope('ui.pop_out'), 'reversible');
  assert.deepEqual(commandByName.get('playlist.remove').input.required, ['name', 'index']);
  assert.deepEqual(commandByName.get('playlist.rename').input.required, ['name', 'to']);
  assert.equal(channelRefusal('spectrum.get'), null);
  assert.equal(channelRefusal('queue.play', { paired: true }), null);
  assert.equal(channelRefusal('queue.play').code, 'refused');
  assert.equal(channelRefusal('history.clear').code, 'refused');
  assert.equal(channelRefusal('playlist.remove').code, 'refused');
});

test('snapshot: the loaded playlist name, and a change to it is a queue-changed event', () => {
  const base = { status: { track: { id: 't' }, playing: true }, queue: { length: 2, index: 0, revision: 3 } };
  const a = buildSnapshot({ ...base, playlist: 'Road trip' });
  assert.equal(a.playlist, 'Road trip');
  assert.equal(buildSnapshot(base).playlist, null);
  assert.deepEqual(diffSnapshots(a, buildSnapshot({ ...base, playlist: null })), ['queue-changed']);
});
