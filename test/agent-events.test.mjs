import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_NAME, buildSnapshot, diffSnapshots, createEventPublisher, createChannelBridge,
  channelRefusal, channelCommandNames, instanceId,
} from '../app/agent/events.mjs';
import { COMMANDS, commandByName } from '../app/commands/commands.mjs';
import { bindCommands } from '../app/commands/run.mjs';

const status = (over = {}) => ({
  track: { id: 't1', title: 'Song', artist: 'A', album: 'B', year: 2001, durationS: 183, path: '/music/song.flac', handle: {} },
  positionS: 42.5, durationS: 183, playing: true, volume: 0.8, volumeDb: -6, muted: false,
  speed: 1, shuffle: 'off', repeat: 'all', route: 'r2', timer: null, ...over,
});
const parts = (over = {}) => ({
  status: status(over.status),
  queue: { length: 10, index: 3, revision: 4, ...over.queue },
  eq: { enabled: true, preset: 'rock', custom: [1, 2] },
  visualiser: { mode: 'bars', linkVolume: false },
  dsp: { chain: 'on', lane: 'normal', gapless: true, crossfading: false, gainDb: -3.2, secret: '/x' },
  mono: false,
  ...over.top,
});

test('snapshot: every field the brief names, and no path anywhere', () => {
  const s = buildSnapshot(parts());
  assert.deepEqual(Object.keys(s).toSorted(), [
    'dsp', 'durationS', 'eq', 'error', 'mono', 'muted', 'playing', 'positionS', 'queue', 'repeat',
    'seekable', 'shuffle', 'speed', 'state', 'track', 'version', 'visualiser', 'volume', 'volumeDb',
  ]);
  assert.deepEqual(s.track, { id: 't1', title: 'Song', artist: 'A', album: 'B', year: 2001, durationS: 183 });
  assert.equal(s.state, 'playing');
  assert.equal(s.volumeDb, -6);
  assert.deepEqual(s.queue, { length: 10, index: 3, revision: 4 });
  assert.deepEqual(s.eq, { enabled: true, preset: 'rock' });
  assert.deepEqual(s.visualiser, { mode: 'bars', linkVolume: false });
  assert.deepEqual(s.dsp, { route: 'r2', chain: 'on', lane: 'normal', gapless: true, crossfading: false, gainDb: -3.2 });
  const json = JSON.stringify(s);
  assert.equal(json.includes('/music'), false);
  assert.equal(json.includes('/x'), false);
  assert.equal(s.seekable, true);
});

test('snapshot: empty player is stopped with index -1; paused when a track is loaded', () => {
  const empty = buildSnapshot({});
  assert.equal(empty.state, 'stopped');
  assert.equal(empty.track, null);
  assert.equal(empty.queue.index, -1);
  assert.equal(empty.seekable, false);
  assert.equal(buildSnapshot(parts({ status: { playing: false } })).state, 'paused');
  assert.equal(buildSnapshot(parts({ status: { durationS: Infinity } })).durationS, null);
});

test('diff: events in fixed order; a first snapshot or an unchanged one gives none', () => {
  const a = buildSnapshot(parts());
  assert.deepEqual(diffSnapshots(null, a), []);
  assert.deepEqual(diffSnapshots(a, buildSnapshot(parts())), []);
  const b = buildSnapshot(parts({
    status: { volumeDb: -12, playing: false, track: { id: 't2', title: 'Next' } },
    queue: { index: 4, revision: 5 },
    top: { mono: true },
  }));
  assert.deepEqual(diffSnapshots(a, b), ['track-changed', 'state-changed', 'queue-changed', 'volume-changed', 'settings-changed']);
  // Position alone is not a change.
  assert.deepEqual(diffSnapshots(a, buildSnapshot(parts({ status: { positionS: 50 } }))), []);
  // A queue move keeps length and index but moves the revision.
  assert.deepEqual(diffSnapshots(a, buildSnapshot(parts({ queue: { revision: 9 } }))), ['queue-changed']);
});

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn) { const id = next++; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn) { const id = next++; pending.set(id, fn); return id; },
    clearInterval(id) { pending.delete(id); },
    flush() { const fns = [...pending.values()]; pending.clear(); fns.forEach(fn => fn()); },
    size: () => pending.size,
  };
}

test('publisher: posts to every sink in order, with seq, revision and time; position at 1 Hz while playing', () => {
  let current = parts();
  const posted = [];
  const second = [];
  const timers = fakeTimers();
  const pub = createEventPublisher({
    getSnapshot: () => buildSnapshot(current),
    sinks: [m => posted.push(m), () => { throw new Error('dead'); }, m => second.push(m)],
    instance: 'tab-1', now: () => 1000, timers,
  });
  pub.start();
  assert.equal(pub.check().length, 0);

  current = parts({ status: { track: { id: 't9', title: 'Other' }, volumeDb: -20 } });
  const out = pub.tick();
  assert.deepEqual(out.map(m => m.event), ['track-changed', 'volume-changed', 'position']);
  assert.deepEqual(posted.map(m => m.seq), [1, 2, 3]);
  assert.deepEqual(second.map(m => m.event), posted.map(m => m.event));
  assert.ok(posted.every(m => m.type === 'event' && m.instance === 'tab-1' && m.time === 1000 && m.revision === 1));
  assert.deepEqual(posted[0].data.track, { id: 't9', title: 'Other', artist: null, album: null, year: null, durationS: null });
  assert.deepEqual(posted[2].data, { positionS: 42.5, durationS: 183 });

  // Paused: the tick posts the state change and no position.
  current = parts({ status: { track: { id: 't9', title: 'Other' }, volumeDb: -20, playing: false } });
  assert.deepEqual(pub.tick().map(m => m.event), ['state-changed']);
  assert.deepEqual(pub.tick(), []);
  assert.equal(pub.revision(), 2);

  // error posts at once; snapshot carries the revision and instance.
  assert.deepEqual(pub.error({ code: 'ERR_X', message: 'bad file' }).data, { code: 'ERR_X', message: 'bad file' });
  const snap = pub.snapshot();
  assert.equal(snap.revision, 2);
  assert.equal(snap.instance, 'tab-1');

  // poke coalesces checks; stop clears the timers.
  pub.poke(); pub.poke();
  assert.equal(timers.size(), 2); // interval + one poke
  pub.stop();
  assert.equal(timers.size(), 0);
});

function fakeChannel() {
  const listeners = new Set();
  const posted = [];
  return {
    posted,
    postMessage(m) { posted.push(structuredClone(m)); },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    close() { listeners.clear(); },
    deliver(data) { for (const fn of listeners) fn({ data }); },
    listeners: () => listeners.size,
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('channel: accepts a reversible command, answers with the id, then the events follow', async () => {
  const channel = fakeChannel();
  let current = parts({ status: { playing: false } });
  const calls = [];
  const run = bindCommands({
    'player.play': (input, context) => { calls.push(context.from); current = parts(); return { playing: true }; },
    'player.snapshot': () => ({ ok: 1 }),
  });
  const publisher = createEventPublisher({ getSnapshot: () => buildSnapshot(current), sinks: [m => channel.postMessage(m)], timers: fakeTimers() });
  publisher.start();
  createChannelBridge({ channel, run, publisher, instance: 'tab-1' });
  channel.deliver({ type: 'command', name: 'player.play', input: {}, id: 'a1' });
  await settle();
  assert.deepEqual(calls, ['channel']);
  assert.deepEqual(channel.posted[0], { type: 'result', id: 'a1', instance: 'tab-1', ok: true, value: { playing: true } });
  assert.equal(channel.posted[1].event, 'state-changed');

  // A read command, with a numeric id.
  channel.deliver({ type: 'command', name: 'player.snapshot', id: 7 });
  await settle();
  assert.deepEqual(channel.posted.at(-1), { type: 'result', id: 7, instance: 'tab-1', ok: true, value: { ok: 1 } });
});

test('channel: refuses destructive, consent and unknown commands, and bad input; ignores others', async () => {
  const channel = fakeChannel();
  let ran = 0;
  const handlers = Object.fromEntries(COMMANDS.map(c => [c.name, () => { ran += 1; return {}; }]));
  const bridge = createChannelBridge({ channel, run: bindCommands(handlers, { confirm: () => true }), instance: 'tab-1' });
  const ask = async message => { channel.posted.length = 0; channel.deliver(message); await settle(); return channel.posted[0]; };

  const destructive = await ask({ type: 'command', name: 'playlist.delete', input: { name: 'x' }, id: 1 });
  assert.equal(destructive.ok, false);
  assert.equal(destructive.error.code, 'refused');
  assert.match(destructive.error.message, /destructive/);
  for (const name of COMMANDS.filter(c => c.scope === 'destructive').map(c => c.name)) {
    assert.equal((await ask({ type: 'command', name, input: {}, id: name })).error.code, 'refused', name);
  }
  assert.equal((await ask({ type: 'command', name: 'network.grant', input: { service: 'lrclib' }, id: 2 })).error.code, 'refused');
  const unknown = await ask({ type: 'command', name: 'rm.rf', id: 3 });
  assert.deepEqual(unknown.error.code, 'not-found');
  const bad = await ask({ type: 'command', name: 'player.seek', input: { percent: 500 }, id: 4 });
  assert.equal(bad.error.code, 'invalid-input');
  assert.equal(bad.error.message.startsWith('['), false);
  assert.equal(ran, 0);

  // Another tab's target, a result echo and junk are ignored.
  assert.equal(await ask({ type: 'command', name: 'player.play', id: 5, target: 'tab-2' }), undefined);
  assert.equal(await ask({ type: 'result', id: 5, ok: true }), undefined);
  assert.equal(await ask(null), undefined);
  assert.equal((await ask({ type: 'command', name: 'player.play', id: 6, target: 'tab-1' })).ok, true);
  assert.equal(ran, 1);

  const caps = await ask({ type: 'capabilities', id: 'c' });
  assert.equal(caps.value.channel, CHANNEL_NAME);
  assert.ok(caps.value.commands.includes('player.snapshot'));
  assert.equal(caps.value.commands.includes('playlist.delete'), false);
  assert.equal(caps.value.commands.includes('network.grant'), false);

  bridge.close();
  assert.equal(channel.listeners(), 0);
});

test('channel rules and manifest: snapshot, picker and volume link are commands', () => {
  assert.equal(channelRefusal('player.snapshot'), null);
  assert.equal(channelRefusal('nope').code, 'not-found');
  assert.equal(commandByName.get('player.snapshot').scope, 'read');
  assert.equal(commandByName.get('visualiser.picker').scope, 'read');
  assert.deepEqual(commandByName.get('visualiser.picker').shortcut, ['Alt+V']);
  assert.equal(commandByName.get('visualiser.link_volume').scope, 'reversible');
  const names = channelCommandNames();
  assert.ok(names.length > 50);
  assert.ok(names.every(n => commandByName.get(n).scope !== 'destructive'));
  assert.match(instanceId(() => 0.5), /^nakliamp-80000000$/);
});
