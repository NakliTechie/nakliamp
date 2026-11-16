// Smart playlists: validation, evaluation, parse and serialise.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSmart, parseSmart, serialiseSmart, validateSmart, smartFileName, isSmartPath,
  SmartRuleError, SMART_FIELDS, SMART_OPS,
} from '../app/library/smart.mjs';
import { validateTrack } from '../app/library/store.mjs';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
let n = 0;
const make = overrides => { n += 1; return validateTrack({ id: `s${n}`, path: `p/${n}.flac`, size: 1, ...overrides }); };
const tracks = [
  make({ title: 'A', genre: 'Jazz', artist: 'Björk', year: 1959, rating: 5, playCount: 0, addedAt: NOW - 2 * DAY, lastPlayedAt: 0, durationS: 300 }),
  make({ title: 'B', genre: 'jazz', artist: 'Miles', year: 1970, rating: 2, playCount: 9, addedAt: NOW - 40 * DAY, lastPlayedAt: NOW - DAY, durationS: 100, bookmarked: 1 }),
  make({ title: 'C', genre: 'Rock', artist: 'Band', year: null, rating: 0, playCount: 3, addedAt: NOW - 400 * DAY, lastPlayedAt: NOW - 100 * DAY, durationS: 200 }),
];
const run = (rules, extra = {}) => evaluateSmart({ name: 't', match: 'all', rules, ...extra }, tracks, { now: NOW }).map(t => t.title);

test('text ops fold case and accents', () => {
  assert.deepEqual(run([{ field: 'genre', op: 'is', value: 'JAZZ' }]), ['A', 'B']);
  assert.deepEqual(run([{ field: 'genre', op: 'is-not', value: 'jazz' }]), ['C']);
  assert.deepEqual(run([{ field: 'artist', op: 'contains', value: 'bjork' }]), ['A']);
  assert.deepEqual(run([{ field: 'path', op: 'not-contains', value: 'p/1.' }]).length, 3 - run([{ field: 'path', op: 'contains', value: 'p/1.' }]).length);
});

test('number ops; a missing number never matches a comparison', () => {
  assert.deepEqual(run([{ field: 'year', op: 'lt', value: 1965 }]), ['A']);
  assert.deepEqual(run([{ field: 'year', op: 'gt', value: 1000 }]), ['A', 'B']);
  assert.deepEqual(run([{ field: 'rating', op: 'between', value: [5, 2] }]), ['A', 'B']);
  assert.deepEqual(run([{ field: 'playCount', op: 'is', value: 0 }]), ['A']);
  assert.deepEqual(run([{ field: 'durationS', op: 'is-not', value: 100 }]), ['A', 'C']);
});

test('date ops: in-last-days and not-in-last-days; never played counts as not recent', () => {
  assert.deepEqual(run([{ field: 'addedAt', op: 'in-last-days', value: 30 }]), ['A']);
  assert.deepEqual(run([{ field: 'lastPlayedAt', op: 'in-last-days', value: 7 }]), ['B']);
  assert.deepEqual(run([{ field: 'lastPlayedAt', op: 'not-in-last-days', value: 7 }]), ['A', 'C']);
  assert.deepEqual(run([{ field: 'addedAt', op: 'gt', value: NOW - 50 * DAY }]), ['A', 'B']);
});

test('favourite, match any, sort and limit', () => {
  assert.deepEqual(run([{ field: 'favourite', op: 'is', value: true }]), ['B']);
  assert.deepEqual(run([{ field: 'favourite', op: 'is-not', value: true }]), ['A', 'C']);
  assert.deepEqual(run([{ field: 'genre', op: 'is', value: 'rock' }, { field: 'rating', op: 'is', value: 5 }], { match: 'any' }), ['A', 'C']);
  assert.deepEqual(run([], { sort: { key: 'playCount', direction: 'desc' }, limit: 2 }), ['B', 'C']);
  assert.deepEqual(run([], { match: 'any' }), [], 'match any with no rules selects nothing');
});

test('validation refuses unknown fields, ops and keys by name', () => {
  const bad = [
    [{ name: 'x', rules: [{ field: 'mood', op: 'is', value: 'x' }] }, /mood/],
    [{ name: 'x', rules: [{ field: 'genre', op: 'like', value: 'x' }] }, /like/],
    [{ name: 'x', rules: [{ field: 'genre', op: 'gt', value: 1 }] }, /gt does not apply to field genre/],
    [{ name: 'x', rules: [{ field: 'year', op: 'is', value: '1959' }] }, /number/],
    [{ name: 'x', rules: [{ field: 'year', op: 'between', value: [1] }] }, /between/],
    [{ name: 'x', rules: [{ field: 'favourite', op: 'is', value: 1 }] }, /true or false/],
    [{ name: 'x', rules: [{ field: 'genre', op: 'is', value: 'x', extra: 1 }] }, /extra/],
    [{ name: 'x', rules: [], colour: 'red' }, /colour/],
    [{ name: '', rules: [] }, /name/],
    [{ name: 'x', match: 'most', rules: [] }, /most/],
    [{ name: 'x', rules: [], limit: 0 }, /limit/],
    [{ name: 'x', rules: [], sort: { key: 'mood' } }, /mood/],
    [{ name: 'x', rules: [], version: 9 }, /version/],
    [{ name: 'x', rules: 'all' }, /rules/],
    [null, /not an object/],
  ];
  for (const [rule, pattern] of bad) {
    assert.throws(() => validateSmart(rule), error => error instanceof SmartRuleError && pattern.test(error.message), String(pattern));
  }
  assert.equal(SMART_FIELDS.length, 13);
  assert.equal(SMART_OPS.length, 9);
});

test('serialise then parse round-trips, byte-stable', () => {
  const rule = { sort: { key: 'year' }, limit: 25, rules: [{ value: 'Jazz', op: 'is', field: 'genre' }], match: 'any', name: ' Jazz ' };
  const text = serialiseSmart(rule);
  assert.ok(text.endsWith('\n'));
  const parsed = parseSmart(text);
  assert.deepEqual(parsed, { version: 1, name: 'Jazz', match: 'any', rules: [{ field: 'genre', op: 'is', value: 'Jazz' }], limit: 25, sort: { key: 'year', direction: 'asc' } });
  assert.equal(serialiseSmart(parsed), text);
  assert.throws(() => parseSmart('{nope'), /Not valid JSON/);
});

test('file names', () => {
  assert.equal(smartFileName('Late: night?'), 'Late_ night_.nakliamp-smart.json');
  assert.equal(isSmartPath('Mix.NAKLIAMP-SMART.json'), true);
  assert.equal(isSmartPath('mix.json'), false);
});
