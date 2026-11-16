// Settings store. Run: node --test test/settings-store.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, mergeSettings, DEFAULT_SETTINGS, SETTINGS_KEY, LEGACY_VISUALISER_KEY } from '../app/settings.mjs';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

test('defaults match the contract', () => {
  const s = createSettings({ storage: memoryStorage() }).load();
  assert.equal(s.theme, 'system');
  assert.deepEqual(s.eq, { enabled: false, preset: 'flat', custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(s.replayGain, { mode: 'auto', preampDb: 0, preventClipping: true });
  assert.equal(s.crossfadeS, 0);
  assert.equal(s.gapless, 'albums');
  assert.equal(s.shuffle, 'off');
  assert.equal(s.repeat, 'off');
  assert.equal(s.loudnessScan, 'idle');
  assert.equal(s.miniPlayer, false);
  assert.equal(s.seekStepS, 5);
  assert.equal(s.visualiser, 'bars');
});

test('save merges nested objects, persists and notifies', () => {
  const storage = memoryStorage();
  const store = createSettings({ storage });
  const seen = [];
  store.onChange((next, before) => seen.push([next.eq.preset, before.eq.preset]));
  store.save({ eq: { preset: 'rock' } });
  const s = store.save({ eq: { enabled: true }, replayGain: { preampDb: 3 } });
  assert.equal(s.eq.preset, 'rock');
  assert.equal(s.eq.enabled, true);
  assert.equal(s.replayGain.mode, 'auto');
  assert.equal(s.replayGain.preampDb, 3);
  assert.deepEqual(seen, [['rock', 'flat'], ['rock', 'rock']]);
  const reread = createSettings({ storage }).load();
  assert.deepEqual(reread, s);
  assert.ok(storage.data.has(SETTINGS_KEY));
});

test('invalid values are ignored and numbers are clamped', () => {
  const s = mergeSettings(DEFAULT_SETTINGS, {
    theme: 'neon', crossfadeS: 99, seekStepS: -4, gapless: 'sometimes', shuffle: 'albums', repeat: 'one',
    eq: { preset: 'loud', custom: [20, -20, 1, 2, 3, 4, 5, 6, 7, 'x'] },
    replayGain: { mode: 'album', preampDb: -40, preventClipping: 'yes' },
    miniPlayer: 1, visualiser: '<script>', unknown: true,
  });
  assert.equal(s.theme, 'system');
  assert.equal(s.crossfadeS, 12);
  assert.equal(s.seekStepS, 1);
  assert.equal(s.gapless, 'albums');
  assert.equal(s.shuffle, 'albums');
  assert.equal(s.repeat, 'one');
  assert.equal(s.eq.preset, 'flat');
  assert.deepEqual(s.eq.custom, [12, -12, 1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(s.replayGain.mode, 'album');
  assert.equal(s.replayGain.preampDb, -15);
  assert.equal(s.replayGain.preventClipping, true);
  assert.equal(s.miniPlayer, false);
  assert.equal(s.visualiser, 'bars');
  assert.equal('unknown' in s, false);
});

test('an EQ curve of the wrong length is refused', () => {
  const s = mergeSettings(DEFAULT_SETTINGS, { eq: { custom: [1, 2, 3] } });
  assert.deepEqual(s.eq.custom, DEFAULT_SETTINGS.eq.custom);
});

test('load returns a copy that callers cannot use to change the store', () => {
  const store = createSettings({ storage: memoryStorage() });
  const s = store.load();
  s.eq.custom[0] = 9; s.theme = 'dark';
  assert.equal(store.load().eq.custom[0], 0);
  assert.equal(store.load().theme, 'system');
});

test('the old visualiser key seeds the setting', () => {
  const s = createSettings({ storage: memoryStorage({ [LEGACY_VISUALISER_KEY]: 'scope' }) }).load();
  assert.equal(s.visualiser, 'scope');
});

test('damaged JSON and blocked storage fall back to defaults; saves still apply in memory', () => {
  assert.deepEqual(createSettings({ storage: memoryStorage({ [SETTINGS_KEY]: '{oops' }) }).load(), mergeSettings(DEFAULT_SETTINGS, {}));
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const store = createSettings({ storage: blocked });
  assert.equal(store.load().theme, 'system');
  assert.equal(store.save({ theme: 'dark' }).theme, 'dark');
  assert.equal(store.load().theme, 'dark');
  assert.equal(createSettings({ storage: null }).load().gapless, 'albums');
});
