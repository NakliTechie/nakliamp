// Review C: network grants and the ListenBrainz token on a shared origin (N15), and
// network.grant asking the person through every door (N16).
// Run: node --test test/review-c-consent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsent, NETWORK_KEY } from '../app/net/consent.mjs';
import { openVault, memoryBackend, sealedToken } from '../app/net/vault.mjs';
import { createListenBrainz, LB_KEY } from '../app/net/listenbrainz.mjs';
import { COMMANDS, commandByName, manifest } from '../app/commands/commands.mjs';
import { bindCommands, hostCommandList } from '../app/commands/run.mjs';
import { toolFor } from '../app/agent/webmcp.mjs';
import { memoryStorage } from './v1x-svc-helpers.mjs';

const LRCLIB = 'https://lrclib.net';
const TOKEN = '0b9e1d6a-6f6c-4c55-9a0e-1234567890ab';

test('N15: a grant record another app writes by hand is not trusted; NakliAmp\'s own signed grant is', async () => {
  const storage = memoryStorage();
  const backend = memoryBackend();
  const vault = openVault({ backend });
  // NakliAmp grants LRCLIB; the record is signed.
  const first = createConsent({ storage, vault });
  await first.ready;
  first.grant(LRCLIB);
  await first.saved();
  assert.ok(JSON.parse(storage.getItem(NETWORK_KEY)).sig);
  const second = createConsent({ storage, vault: openVault({ backend }) });
  assert.equal(second.isAllowed(LRCLIB), false, 'nothing is granted before the signature is checked');
  await second.ready;
  assert.equal(second.isAllowed(LRCLIB), true);

  // Another app turns every service on by writing the key.
  const forged = { version: 1, grants: Object.fromEntries(['https://musicbrainz.org', LRCLIB, 'https://api.listenbrainz.org'].map(o => [o, { grantedAt: 1 }])) };
  storage.setItem(NETWORK_KEY, JSON.stringify({ ...forged, sig: JSON.parse(storage.getItem(NETWORK_KEY)).sig }));
  const third = createConsent({ storage, vault: openVault({ backend }) });
  await third.ready;
  for (const origin of Object.keys(forged.grants)) assert.equal(third.isAllowed(origin), false, origin);
  const row = third.list().find(r => r.origin === 'https://api.listenbrainz.org');
  assert.equal(row.granted, false);
  assert.equal(row.unconfirmed, true);
  assert.throws(() => third.assertAllowed('https://api.listenbrainz.org/1/submit-listens'), /outside NakliAmp's Network panel/);
  // The person turns it on in the panel: now it is granted and signed.
  third.grant('https://api.listenbrainz.org');
  await third.saved();
  const fourth = createConsent({ storage, vault: openVault({ backend }) });
  await fourth.ready;
  assert.equal(fourth.isAllowed('https://api.listenbrainz.org'), true);
  assert.equal(fourth.isAllowed(LRCLIB), false);
});

test('N15: the ListenBrainz token is sealed, never in localStorage, and an old stored token moves out', async () => {
  const backend = memoryBackend();
  const storage = memoryStorage();
  storage.setItem(LB_KEY, JSON.stringify({ token: TOKEN, queue: [], rejected: [], nextAttemptAt: 0, failures: 0 }));
  const vaultA = openVault({ backend });
  const tokenA = sealedToken(vaultA);
  const lb = createListenBrainz({ fetch: async () => new Response('{}'), consent: createConsent({ storage: memoryStorage() }), storage, tokenStore: tokenA });
  await tokenA.ready;
  assert.equal(lb.token(), TOKEN, 'the old token moved into the token store');
  assert.equal(JSON.parse(storage.getItem(LB_KEY)).token, undefined, 'and out of localStorage');
  await new Promise(resolve => setTimeout(resolve, 20));
  // Sealed: the stored bytes do not contain the token.
  const sealed = JSON.stringify([...backend.map.entries()].filter(([key]) => key.startsWith('sealed:')));
  assert.ok(sealed.length > 20);
  assert.equal(sealed.includes(TOKEN), false);
  // A new page load reads it back through the vault.
  const tokenB = sealedToken(openVault({ backend }));
  await tokenB.ready;
  assert.equal(tokenB.get(), TOKEN);
  // A value another app writes into the vault's store by hand does not open.
  backend.map.set('sealed:listenbrainz-token', { iv: 'AAAAAAAAAAAAAAAA', data: 'AAAA' });
  const tokenC = sealedToken(openVault({ backend }));
  await tokenC.ready;
  assert.equal(tokenC.get(), '');
});

test('N15: no command reads or sets the ListenBrainz token', () => {
  for (const command of COMMANDS) {
    assert.equal(/token/i.test(JSON.stringify(command.input)), false, command.name);
  }
});

test('N16: network.grant asks the person on every door; only the panel switch skips the dialog', async () => {
  assert.equal(commandByName.get('network.grant').askEveryTime, true);
  assert.equal(manifest().commands.find(c => c.name === 'network.grant').approval, 'consent');
  const asked = [];
  let answer = false;
  let granted = 0;
  const run = bindCommands({ 'network.grant': () => { granted += 1; return { granted: true }; } }, {
    confirm: request => { asked.push(request.name); return answer; },
  });
  const input = { origin: LRCLIB };

  // The NakliOS host rail sends calls approved; NakliAmp still asks.
  const host = hostCommandList(run).find(c => c.name === 'network.grant');
  await assert.rejects(host.handler(input), error => error.code === 'declined');
  // WebMCP.
  const tool = toolFor(commandByName.get('network.grant'), run);
  const out = await tool.execute(input);
  assert.equal(out.isError, true);
  // The keyboard or command bar.
  await assert.rejects(run('network.grant', input, { context: { from: 'key' } }), error => error.code === 'declined');
  assert.equal(granted, 0);
  assert.equal(asked.length, 3);

  answer = true;
  await host.handler(input);
  assert.equal(granted, 1);
  // The Network panel's switch is the person's own click.
  await run('network.grant', input, { byPerson: true, context: { from: 'panel' } });
  assert.equal(granted, 2);
  assert.equal(asked.length, 4);
});
