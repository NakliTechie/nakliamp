// v1 store additions: rating, favourite, ReplayGain, folder art, parser
// version and the loudness key. Pure parts only; the IndexedDB round trip is
// the browser harness's job (test/library.html).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRACK_SCHEMA, validateTrack, validateReplayGain, validateLoudness, loudnessKey,
  indexHash, isRating, groupAlbums, IDENTITY_FIELDS, MUTABLE_FIELDS, LibraryValidationError,
} from '../app/library/store.mjs';

const base = overrides => ({ id: 'a'.repeat(32), path: 'A/b.flac', name: 'b.flac', size: 10, ...overrides });

test('schema 2 defaults: rating 0, replayGain null, dirArtKey null, parserVersion 0', () => {
  const record = validateTrack(base());
  assert.equal(TRACK_SCHEMA, 2);
  assert.equal(record.rating, 0);
  assert.equal(record.replayGain, null);
  assert.equal(record.dirArtKey, null);
  assert.equal(record.parserVersion, 0);
});

test('an old schema-1 row validates into schema 2 without loss', () => {
  const old = { ...base(), schema: 1, title: 'T', playCount: 4, bookmarked: 1, resumePositionS: 9 };
  const record = validateTrack(old);
  assert.equal(record.schema, 2);
  assert.equal(record.title, 'T');
  assert.equal(record.playCount, 4);
  assert.equal(record.bookmarked, 1);
  assert.equal(record.resumePositionS, 9);
});

test('rating accepts whole numbers 0..5 and refuses everything else by field', () => {
  for (const rating of [0, 1, 5]) assert.equal(validateTrack(base({ rating })).rating, rating);
  for (const rating of [6, -1, 2.5, '3', Number.NaN]) {
    assert.throws(() => validateTrack(base({ rating })), error => error.field === 'rating');
  }
  assert.equal(isRating(3), true);
  assert.equal(isRating(3.1), false);
});

test('rating is mutable and stays out of the identity hash', async () => {
  assert.ok(MUTABLE_FIELDS.includes('rating'));
  assert.ok(!IDENTITY_FIELDS.includes('rating'));
  const before = [validateTrack(base({ rating: 0 }))];
  const after = [validateTrack(base({ rating: 5 }))];
  assert.equal(await indexHash(before), await indexHash(after));
});

test('replayGain normalises, collapses all-null to null, and refuses bad shapes', () => {
  assert.deepEqual(validateReplayGain({ trackGainDb: -6.5, trackPeak: 0.98 }), {
    trackGainDb: -6.5, trackPeak: 0.98, albumGainDb: null, albumPeak: null,
  });
  assert.equal(validateReplayGain({ trackGainDb: null }), null);
  assert.equal(validateReplayGain(undefined), null);
  assert.throws(() => validateReplayGain({ trackGain: 1 }), /trackGain/);
  assert.throws(() => validateReplayGain({ trackGainDb: 'loud' }), LibraryValidationError);
  assert.throws(() => validateReplayGain([1]), LibraryValidationError);
  const record = validateTrack(base({ replayGain: { albumGainDb: -3 } }));
  assert.equal(record.replayGain.albumGainDb, -3);
});

test('dirArtKey and parserVersion are validated', () => {
  assert.equal(validateTrack(base({ dirArtKey: 'k:dirart', parserVersion: 2 })).dirArtKey, 'k:dirart');
  assert.throws(() => validateTrack(base({ dirArtKey: 4 })), error => error.field === 'dirArtKey');
  assert.throws(() => validateTrack(base({ parserVersion: 1.5 })), error => error.field === 'parserVersion');
});

test('folder art stands in for a missing embedded picture in album rows', () => {
  const tracks = [
    validateTrack(base({ id: '1', path: 'A/1.flac', album: 'A', dirArtKey: 'dir' })),
    validateTrack(base({ id: '2', path: 'B/1.flac', album: 'B', artKey: 'own', dirArtKey: 'dir2' })),
  ];
  const rows = groupAlbums(tracks);
  assert.equal(rows.find(row => row.album === 'A').artKey, 'dir');
  assert.equal(rows.find(row => row.album === 'B').artKey, 'own');
});

test('loudnessKey changes with size and lastModified', () => {
  const key = loudnessKey({ path: 'a.flac', size: 10, lastModified: 5 });
  assert.equal(key, 'a.flac\u001f10\u001f5');
  assert.notEqual(key, loudnessKey({ path: 'a.flac', size: 11, lastModified: 5 }));
  assert.notEqual(key, loudnessKey({ path: 'a.flac', size: 10, lastModified: 6 }));
  assert.throws(() => loudnessKey({}), LibraryValidationError);
});

test('validateLoudness keeps the four fields and refuses unknown ones', () => {
  const value = validateLoudness({ integratedLufs: -14.2, truePeak: -0.5, gainDb: -3.8, computedAt: 7 });
  assert.deepEqual(value, { integratedLufs: -14.2, truePeak: -0.5, gainDb: -3.8, computedAt: 7 });
  assert.throws(() => validateLoudness({ lufs: 1 }), /lufs/);
  assert.throws(() => validateLoudness({ integratedLufs: 'x' }), LibraryValidationError);
  assert.equal(typeof validateLoudness({}).computedAt, 'number');
});
