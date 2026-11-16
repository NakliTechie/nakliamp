// Review C: the BroadcastChannel needs pairing before it changes anything (N9).
// Run: node --test test/review-c-channel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelBridge, channelAuth, channelRefusal, newPairingCode } from '../app/agent/events.mjs';
import { COMMANDS } from '../app/commands/commands.mjs';
import { bindCommands } from '../app/commands/run.mjs';

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
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function setup({ code = null } = {}) {
  const channel = fakeChannel();
  const ran = [];
  const handlers = Object.fromEntries(COMMANDS.map(c => [c.name, input => { ran.push([c.name, input]); return { ok: true }; }]));
  let current = code;
  createChannelBridge({ channel, run: bindCommands(handlers, { confirm: () => true }), instance: 'tab-1', pairingCode: () => current });
  const ask = async message => { channel.posted.length = 0; channel.deliver(message); await settle(); return channel.posted[0]; };
  return { ask, ran, setCode: c => { current = c; } };
}

test('N9: an unpaired caller can read but cannot change the player', async () => {
  const { ask, ran } = setup({ code: null });
  const read = await ask({ type: 'command', name: 'player.status', id: 1 });
  assert.equal(read.ok, true);
  for (const [name, input] of [['player.volume_db', { db: 0 }], ['ui.theme', { theme: 'dark' }], ['network.revoke', { origin: 'https://lrclib.net' }], ['playlist.create', { name: 'x' }]]) {
    const reply = await ask({ type: 'command', name, input, id: name, target: 'tab-1' });
    assert.equal(reply.ok, false, name);
    assert.equal(reply.error.code, 'refused', name);
  }
  assert.deepEqual(ran.map(([name]) => name), ['player.status']);
});

test('N9: a command signed with the pairing code runs once; a wrong code, another tab or a replay is refused', async () => {
  const code = newPairingCode();
  assert.match(code, /^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/);
  const { ask, ran, setCode } = setup({ code });
  const message = { type: 'command', name: 'player.volume_db', input: { db: -6 }, id: 'v1', target: 'tab-1' };
  const good = { ...message, auth: await channelAuth({ code, ...message }) };
  assert.equal((await ask(good)).ok, true);
  assert.equal((await ask(good)).ok, false, 'a replay of the same signed message');

  const wrong = { ...message, id: 'v2', auth: await channelAuth({ code: newPairingCode(), ...message, id: 'v2' }) };
  assert.equal((await ask(wrong)).error.code, 'refused');
  const otherTab = { ...message, id: 'v3', target: 'tab-2' };
  assert.equal(await ask({ ...otherTab, auth: await channelAuth({ code, ...otherTab }) }), undefined, 'addressed to another tab');
  const changedInput = { ...message, id: 'v4', auth: await channelAuth({ code, ...message, id: 'v4' }), input: { db: 0 } };
  assert.equal((await ask(changedInput)).error.code, 'refused', 'input changed after signing');

  // Typed with lower case and no dashes, the code still signs the same.
  const typed = { ...message, id: 'v5' };
  assert.equal((await ask({ ...typed, auth: await channelAuth({ code: code.replace(/-/g, '').toLowerCase(), ...typed }) })).ok, true);

  // A new code, or none, stops the old one at once.
  setCode(null);
  const after = { ...message, id: 'v6' };
  assert.equal((await ask({ ...after, auth: await channelAuth({ code, ...after }) })).error.code, 'refused');
  assert.deepEqual(ran.map(([name]) => name), ['player.volume_db', 'player.volume_db']);
});

test('N9: paired or not, destructive commands and network.grant stay refused on the channel', async () => {
  const code = newPairingCode();
  const { ask, ran } = setup({ code });
  for (const [name, input] of [['network.grant', { origin: 'https://lrclib.net' }], ['playlist.delete', { name: 'x' }], ['history.clear', {}]]) {
    const message = { type: 'command', name, input, id: `d-${name}`, target: 'tab-1' };
    const reply = await ask({ ...message, auth: await channelAuth({ code, ...message }) });
    assert.equal(reply.error.code, 'refused', name);
  }
  assert.equal(ran.length, 0);
  assert.equal(channelRefusal('network.grant', { paired: true }).code, 'refused');
  const caps = await ask({ type: 'capabilities', id: 'c' });
  assert.equal(caps.value.pairing.available, true);
  assert.equal(caps.value.commands.includes('player.volume_db'), false);
  assert.equal(caps.value.paired.includes('player.volume_db'), true);
});
