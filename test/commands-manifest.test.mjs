// Command list, commands.json, keyboard map. Run: node --test test/commands-manifest.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, commandByName, manifest, AUDIO_EXTENSIONS } from '../app/commands/commands.mjs';
import { matchShortcut, shortcutOf, keymapRows, displayKey, validate } from '../app/commands/run.mjs';

const CONTRACT_NAMES = `player.play player.pause player.toggle player.next player.previous player.seek
player.seek_relative player.volume player.mute player.status queue.read queue.set queue.add queue.play_next
queue.move queue.remove queue.clear queue.shuffle queue.repeat queue.undo queue.save_playlist library.search
library.browse track.read track.rate track.favourite track.edit_tags playlist.list playlist.create playlist.add
playlist.delete smart.create smart.list eq.preset eq.enable sound.replaygain sound.crossfade sound.gapless
visualiser.mode view.open view.keymap ui.theme ui.mini ai.playlist`.split(/\s+/);

// A KeyboardEvent-like object for a canonical shortcut, as a US keyboard sends it.
function eventFor(shortcut, extra = {}) {
  const parts = shortcut === '+' ? ['+'] : shortcut.split('+');
  let key = parts.pop();
  const mods = new Set(parts);
  const e = { ctrlKey: mods.has('Mod'), metaKey: false, altKey: mods.has('Alt'), shiftKey: mods.has('Shift'), code: '', target: { tagName: 'BODY' }, ...extra };
  if (/^[A-Z]$/.test(key)) { e.code = `Key${key}`; key = e.shiftKey ? key : key.toLowerCase(); }
  else if (/^\d$/.test(key)) e.code = `Digit${key}`;
  else if (key === 'Space') key = ' ';
  else if (key === '?') e.shiftKey = true;
  e.key = key;
  return e;
}

test('every command the contract names exists, once', () => {
  const names = COMMANDS.map(c => c.name);
  assert.equal(new Set(names).size, names.length, 'names are unique');
  for (const name of CONTRACT_NAMES) assert.ok(commandByName.has(name), `${name} is missing`);
});

test('every command has a label, description, group, scope and object input schema', () => {
  for (const c of COMMANDS) {
    assert.match(c.name, /^[a-z]+\.[a-z_]+$/, c.name);
    assert.ok(c.label && c.description && c.group, c.name);
    assert.ok(['read', 'reversible', 'destructive'].includes(c.scope), c.name);
    assert.equal(c.input.type, 'object', c.name);
    assert.ok(Array.isArray(c.input.required), c.name);
    for (const r of c.input.required) assert.ok(c.input.properties[r], `${c.name} requires unknown ${r}`);
  }
});

test('only file-changing and index-forgetting commands are destructive', () => {
  assert.deepEqual(COMMANDS.filter(c => c.scope === 'destructive').map(c => c.name).sort(),
    ['library.forget_folder', 'playlist.delete', 'tags.find_replace', 'tags.rename_files', 'track.edit_tags']);
  for (const name of ['player.status', 'queue.read', 'library.search', 'library.browse', 'track.read', 'playlist.list', 'smart.list']) {
    assert.equal(commandByName.get(name).scope, 'read', name);
  }
});

test('user-facing text uses no em dashes and British spelling for favourite and visualiser', () => {
  for (const c of COMMANDS) {
    const text = [c.label, c.description, ...(c.keys ?? []).map(k => k.label ?? ''), c.keymapLabel ?? ''].join(' ');
    assert.doesNotMatch(text, /—/, c.name);
    assert.doesNotMatch(text, /\b(favorite|visualizer|color)\b/i, c.name);
  }
});

test('commands.json matches COMMANDS', () => {
  const file = JSON.parse(readFileSync(new URL('../commands.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(manifest())), 'run: node scripts/build-commands-json.mjs');
  assert.equal(file.accepts[0].label, 'Open in NakliAmp');
  for (const ext of ['.mp3', '.flac', '.m4a', '.opus', '.ogg', '.wav']) assert.ok(file.accepts[0].extensions.includes(ext), ext);
  assert.ok(AUDIO_EXTENSIONS.every(e => /^\.[a-z0-9]+$/.test(e)));
  assert.deepEqual([...new Set(file.commands.map(c => c.scope))].sort(), ['destructive', 'read', 'write']);
});

test('every shortcut is unique across all commands', () => {
  const seen = new Map();
  for (const c of COMMANDS) for (const b of c.keys ?? []) {
    assert.ok(!seen.has(b.key), `${b.key} is bound to ${seen.get(b.key)} and ${c.name}`);
    seen.set(b.key, c.name);
  }
  assert.ok(seen.size >= 40);
});

test('every declared shortcut is canonical and its input passes its schema', () => {
  for (const c of COMMANDS) for (const b of c.keys ?? []) {
    assert.equal(shortcutOf(eventFor(b.key)), b.key, `${c.name} ${b.key}`);
    assert.deepEqual(validate(c.input, b.input ?? {}), [], `${c.name} ${b.key}`);
  }
});

test('the existing keymap (K1) and the new keys (K3 and others) are all bound', () => {
  const expect = {
    Space: 'player.toggle', ArrowLeft: 'player.seek_relative', ArrowRight: 'player.seek_relative',
    'Shift+ArrowLeft': 'player.seek_relative', 'Shift+ArrowRight': 'player.seek_relative',
    ArrowUp: 'player.volume', ArrowDown: 'player.volume', M: 'player.mute', N: 'player.next', P: 'player.previous',
    L: 'view.open', V: 'visualiser.mode', 'Shift+V': 'visualiser.full', Escape: 'view.close', '?': 'view.keymap',
    Q: 'queue.add', 'Shift+Q': 'queue.play_next', F: 'track.favourite', 'Alt+3': 'track.rate', E: 'eq.enable',
    S: 'queue.shuffle', R: 'queue.repeat', 'Shift+M': 'ui.mini', Y: 'view.open', I: 'view.open', '/': 'view.open',
    '0': 'player.seek', '9': 'player.seek', 'Mod+Z': 'queue.undo',
  };
  for (const [key, name] of Object.entries(expect)) assert.equal(matchShortcut(eventFor(key))?.name, name, key);
});

test('matchShortcut maps keys to command inputs', () => {
  assert.deepEqual(matchShortcut(eventFor('ArrowLeft')), { name: 'player.seek_relative', input: { seconds: -5 } });
  assert.deepEqual(matchShortcut(eventFor('Shift+ArrowRight')), { name: 'player.seek_relative', input: { seconds: 30 } });
  assert.deepEqual(matchShortcut(eventFor('7')), { name: 'player.seek', input: { percent: 70 } });
  assert.deepEqual(matchShortcut(eventFor('Alt+0')), { name: 'track.rate', input: { rating: 0 } });
  assert.deepEqual(matchShortcut(eventFor('Y')), { name: 'view.open', input: { view: 'lyrics' } });
  assert.deepEqual(matchShortcut(eventFor('ArrowUp')), { name: 'player.volume', input: { delta: 0.05 } });
});

test('letters answer with Caps Lock on, and Shift makes a different binding', () => {
  assert.equal(matchShortcut({ key: 'N', code: 'KeyN', shiftKey: false })?.name, 'player.next');
  assert.equal(matchShortcut({ key: 'v', code: 'KeyV' })?.name, 'visualiser.mode');
  assert.equal(matchShortcut({ key: 'V', code: 'KeyV', shiftKey: true })?.name, 'visualiser.full');
  assert.equal(matchShortcut({ key: 'm', code: 'KeyM', shiftKey: true })?.name, 'ui.mini');
});

test('Alt shortcuts use the physical key, as a Mac sends Alt+3 as £', () => {
  assert.deepEqual(matchShortcut({ key: '£', code: 'Digit3', altKey: true }), { name: 'track.rate', input: { rating: 3 } });
  assert.equal(matchShortcut({ key: 'z', code: 'KeyZ', metaKey: true })?.name, 'queue.undo');
});

test('keys typed into a text field are left alone, and unbound keys return null', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
    assert.equal(matchShortcut({ key: 'n', code: 'KeyN', target: { tagName } }), null, tagName);
  }
  assert.equal(matchShortcut({ key: 'n', code: 'KeyN', target: { tagName: 'DIV', isContentEditable: true } }), null);
  assert.equal(matchShortcut({ key: 'x', code: 'KeyX' }), null);
  assert.equal(matchShortcut({ key: 'Shift', shiftKey: true }), null);
  assert.equal(matchShortcut({ key: 'n', code: 'KeyN', ctrlKey: true }), null, 'Ctrl+N belongs to the browser');
  assert.equal(matchShortcut(null), null);
});

test('keymapRows lists every binding, collapsing number keys into one row', () => {
  const groups = keymapRows({ groupLabels: { player: 'Playback' } });
  const rows = groups.flatMap(g => g.rows);
  assert.equal(groups[0].groupLabel, 'Playback');
  const seek = rows.filter(r => r.name === 'player.seek');
  assert.equal(seek.length, 1);
  assert.deepEqual(seek[0].keys, ['0 to 9']);
  assert.deepEqual(rows.find(r => r.name === 'track.rate').keys, ['Alt+0 to Alt+5']);
  assert.ok(rows.some(r => r.keys[0] === 'Shift+←' && r.label === 'Back 30 seconds'));
  assert.ok(rows.some(r => r.keys[0] === '?' && r.name === 'view.keymap'));
  const bound = new Set(COMMANDS.filter(c => c.keys).map(c => c.name));
  assert.deepEqual(new Set(rows.map(r => r.name)), bound);
});

test('displayKey uses Mac symbols on request', () => {
  assert.equal(displayKey('Mod+Z', { mac: true }), '⌘Z');
  assert.equal(displayKey('Mod+Z'), 'Ctrl+Z');
  assert.equal(displayKey('Shift+V', { mac: true }), '⇧V');
  assert.equal(displayKey('Escape'), 'Esc');
});
