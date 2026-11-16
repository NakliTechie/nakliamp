// NakliOS host bridge: no-ops standalone, wiring when an SDK is present. Run: node --test test/commands-host.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import * as host from '../app/host.mjs';

test('standalone, every call is a no-op and AI is unavailable', async () => {
  delete globalThis.naklios;
  assert.equal(host.hosted(), false);
  assert.equal(host.aiReady(), false);
  host.registerCommands([{ name: 'x' }]);
  host.onTheme(() => {});
  host.onCapabilities(() => {});
  host.onFiles(() => {});
  host.title('x');
  host.ready();
  await assert.rejects(host.aiChat({ messages: [] }), /No host model/);
});

test('hosted, it registers commands, forwards theme changes, and reaches the host model', async () => {
  const calls = [];
  let themeCb = null;
  globalThis.naklios = {
    capabilities: { hosted: true, ai: true },
    experimental_commands: { register: list => { calls.push(['register', list.length]); return Promise.resolve(); } },
    theme: { onChange: fn => { themeCb = fn; }, request: () => calls.push(['theme.request']) },
    ready: () => calls.push(['ready']),
    title: t => calls.push(['title', t]),
    ai: { chat: { completions: { create: async body => ({ echoed: body.messages.length }) } } },
  };
  try {
    assert.equal(host.hosted(), true);
    assert.equal(host.aiReady(), true);
    host.registerCommands([{ name: 'a' }, { name: 'b' }]);
    const themes = [];
    const off = host.onTheme(t => themes.push(t.mood));
    host.ready();
    themeCb({ mood: 'light', colors: {} });
    off();
    themeCb({ mood: 'dark', colors: {} });
    assert.deepEqual(themes, ['light']);
    assert.deepEqual(calls, [['register', 2], ['ready'], ['theme.request'], ['title', 'NakliAmp']]);
    assert.deepEqual(await host.aiChat({ messages: [1, 2] }), { echoed: 2 });
  } finally {
    delete globalThis.naklios;
  }
});

test('a failing SDK never throws into the player', () => {
  globalThis.naklios = {
    capabilities: { hosted: true },
    experimental_commands: { register() { throw new Error('boom'); } },
    ready() { throw new Error('boom'); },
    onCapabilitiesChange() { throw new Error('boom'); },
  };
  const warn = console.warn; console.warn = () => {};
  try {
    host.registerCommands([]);
    host.ready();
    host.onCapabilities(() => {});
  } finally { console.warn = warn; delete globalThis.naklios; }
});
