// v1.x commands: present, scoped, schema-checked, and no shortcut clash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandByName, VIEWS, NETWORK_ORIGINS } from '../app/commands/commands.mjs';
import { bindCommands, matchShortcut, validate } from '../app/commands/run.mjs';
import { KNOWN_ORIGINS } from '../app/net/consent.mjs';
import { BROWSE_VIEWS } from '../app/library/views.mjs';

const V1X = {
  'player.speed': 'reversible', 'player.stop_after_current': 'reversible', 'player.sleep_timer': 'reversible',
  'player.volume_db': 'reversible', 'sound.mono': 'reversible', 'sound.volume_floor': 'reversible',
  'sound.devices': 'read', 'sound.output': 'reversible', 'eq.import_eqf': 'reversible', 'eq.export_eqf': 'read',
  'library.duplicates': 'read', 'library.folders': 'read', 'library.add_folder': 'reversible',
  'library.forget_folder': 'destructive', 'library.rescan_folder': 'reversible',
  'tags.rename_files': 'destructive', 'tags.find_replace': 'destructive', 'tags.lookup_musicbrainz': 'read',
  'tags.fetch_cover': 'read', 'lyrics.fetch': 'read', 'lyrics.save_sidecar': 'reversible',
  'queue.more_like_this': 'reversible', 'ai.suggest_genres': 'read', 'ui.command_bar': 'read', 'view.skins': 'read',
  'network.list': 'read', 'network.grant': 'reversible', 'network.revoke': 'reversible',
  'scrobble.status': 'read', 'scrobble.flush': 'reversible',
};

test('every v1.x command exists with its scope', () => {
  for (const [name, scope] of Object.entries(V1X)) {
    assert.ok(commandByName.has(name), name);
    assert.equal(commandByName.get(name).scope, scope, name);
  }
});

test('no two commands share a shortcut, and the new keys reach their commands', () => {
  const seen = new Map();
  for (const command of COMMANDS) {
    for (const binding of command.keys ?? []) {
      assert.ok(!seen.has(binding.key), `${binding.key} is bound to ${seen.get(binding.key)} and ${command.name}`);
      seen.set(binding.key, command.name);
    }
  }
  const key = (k, extra = {}) => matchShortcut({ key: k, target: null, ...extra });
  assert.deepEqual(key(']'), { name: 'player.speed', input: { step: 'up' } });
  assert.deepEqual(key('['), { name: 'player.speed', input: { step: 'down' } });
  assert.equal(key('S', { shiftKey: true }).name, 'player.stop_after_current');
  assert.equal(key('s').name, 'queue.shuffle');
  assert.equal(key('k', { ctrlKey: true, code: 'KeyK' }).name, 'ui.command_bar');
});

test('network commands name exactly the known origins', () => {
  assert.deepEqual([...NETWORK_ORIGINS].sort(), KNOWN_ORIGINS.map(k => k.origin).sort());
  assert.deepEqual(validate(commandByName.get('network.grant').input, { origin: 'https://evil.example' }).length, 1);
});

test('dialog view names do not shadow browse views', () => {
  const dialogs = ['network', 'music-folders', 'duplicates', 'rename', 'sleep', 'commands', 'similar', 'genre-fill', 'skins'];
  for (const name of dialogs) {
    assert.ok(VIEWS.includes(name), name);
    assert.ok(!BROWSE_VIEWS.includes(name), name);
  }
  assert.equal(new Set(VIEWS).size, VIEWS.length, 'view names are unique');
});

test('schemas: speed takes one of rate or step; sleep timer one of minutes or mode', () => {
  const speed = commandByName.get('player.speed').input;
  assert.deepEqual(validate(speed, { rate: 1.5 }), []);
  assert.equal(validate(speed, { rate: 3 }).length, 1);
  assert.ok(validate(speed, { rate: 1, step: 'up' }).length > 0);
  const sleep = commandByName.get('player.sleep_timer').input;
  assert.deepEqual(validate(sleep, { minutes: 30 }), []);
  assert.deepEqual(validate(sleep, { mode: 'off' }), []);
  assert.ok(validate(sleep, {}).length > 0);
});

test('destructive v1.x commands ask before they run', async () => {
  let ran = false;
  const asked = [];
  const run = bindCommands({
    'library.forget_folder': { diff: () => ({ lines: ['f1'] }), run: () => { ran = true; } },
  }, { confirm: request => { asked.push(request.name); return false; } });
  await assert.rejects(run('library.forget_folder', { id: 'f1' }), /\[declined\]/);
  assert.equal(ran, false);
  assert.deepEqual(asked, ['library.forget_folder']);
});
