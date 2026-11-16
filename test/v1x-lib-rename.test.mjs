// T5 batch rename and find-and-replace.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitiseFileName, formatName, validatePattern, planRename, planFindReplace, renameOnDisk, canRenameOnDisk,
  RENAME_TOKENS, RenameError,
} from '../app/library/rename.mjs';

const rec = overrides => ({
  id: 'i', path: 'Music/old.flac', artist: 'Artist', album: 'Album', albumArtist: 'Various', title: 'Title',
  trackNo: 3, trackTotal: 12, discNo: 1, year: 1999, genre: 'Rock', ...overrides,
});

test('file names lose illegal characters, trailing dots and reserved names', () => {
  assert.equal(sanitiseFileName('AC/DC: Back <in> "Black"?*|'), 'AC_DC_ Back _in_ _Black____');
  assert.equal(sanitiseFileName('end. . '), 'end');
  assert.equal(sanitiseFileName('CON.mp3'), '_CON.mp3');
  assert.equal(sanitiseFileName('a\u0007b'), 'a_b');
  assert.equal(sanitiseFileName('Café 日本'), 'Café 日本');
  const long = sanitiseFileName('日'.repeat(200));
  assert.ok(new TextEncoder().encode(long).length <= 255);
  assert.equal(long, '日'.repeat(85));
});

test('patterns: every token fills; unknown or missing tokens are refused', () => {
  assert.deepEqual(RENAME_TOKENS, ['artist', 'album', 'albumartist', 'title', 'track', 'disc', 'year', 'genre']);
  assert.equal(formatName('%disc%-%track% %artist% - %title% (%year%) [%genre%] {%album%} %albumartist%', rec()),
    '1-03 Artist - Title (1999) [Rock] {Album} Various');
  assert.equal(formatName('%TRACK%. %Title%', rec()), '03. Title');
  assert.equal(formatName('%track%', rec({ trackNo: 7, trackTotal: 120 })), '007');
  assert.throws(() => validatePattern('no tokens'), RenameError);
  assert.throws(() => validatePattern('%artist% %bpm%'), /%bpm%/);
});

test('empty tokens take their separator with them', () => {
  assert.equal(formatName('%artist% - %title%', rec({ artist: null })), 'Title');
  assert.equal(formatName('%artist% - %album% - %title%', rec({ album: '' })), 'Artist - Title');
  assert.equal(formatName('%track%. %title%', rec({ trackNo: null })), 'Title');
  assert.equal(formatName('%artist% - %title%', rec({ title: null })), 'Artist');
  assert.equal(formatName('%artist% - %title%', rec({ artist: 'R.E.M.', title: 'Drive' })), 'R.E.M. - Drive');
  assert.equal(formatName('%title%', rec({ title: 'A/B' })), 'A_B');
  assert.equal(formatName('%title%', rec({ title: null })), '');
});

test('rename plan keeps extensions, flags conflicts, virtual and empty rows', () => {
  const rows = planRename([
    rec({ id: 'a', path: 'M/one.flac', title: 'Same' }),
    rec({ id: 'b', path: 'M/two.FLAC', title: 'same' }),
    rec({ id: 'c', path: 'N/Artist - Kept.mp3', title: 'Kept' }),
    rec({ id: 'd', path: 'M/img.flac#2', virtual: { parentPath: 'M/img.flac' } }),
    rec({ id: 'e', path: 'M/x.ogg', artist: null, title: null }),
    rec({ id: 'f', path: 'N/z.mp3', title: 'New' }),
  ], '%artist% - %title%');
  assert.deepEqual(rows.map(row => [row.id, row.status, row.to]), [
    ['a', 'conflict', 'Artist - Same.flac'],
    ['b', 'conflict', 'Artist - same.FLAC'],
    ['c', 'same', 'Artist - Kept.mp3'],
    ['d', 'virtual', 'img.flac#2'],
    ['e', 'empty', 'x.ogg'],
    ['f', 'rename', 'Artist - New.mp3'],
  ]);
});

test('a rename onto a name another selected file keeps is a conflict', () => {
  const rows = planRename([
    rec({ id: 'a', path: 'M/Artist - X.mp3', title: 'X' }),
    rec({ id: 'b', path: 'M/b.mp3', title: 'X' }),
  ], '%artist% - %title%');
  assert.deepEqual(rows.map(row => row.status), ['same', 'conflict']);
});

test('find and replace: plain text, case, fields and literal dollar signs', () => {
  const records = [rec({ id: 'a', artist: 'The Beatles', title: 'the end' }), rec({ id: 'b', artist: 'Queen', title: 'x' })];
  assert.deepEqual(planFindReplace(records, { find: 'the ', replace: '' }), [
    { id: 'a', patch: { title: 'end', artist: 'Beatles' }, before: { title: 'the end', artist: 'The Beatles' } },
  ]);
  assert.deepEqual(planFindReplace(records, { find: 'the ', replace: '', caseSensitive: true }), [
    { id: 'a', patch: { title: 'end' }, before: { title: 'the end' } },
  ]);
  assert.deepEqual(planFindReplace(records, { find: 'Queen', replace: '$1 Q', fields: ['artist'] })[0].patch, { artist: '$1 Q' });
  assert.deepEqual(planFindReplace(records, { find: 'x', fields: ['title'] })[0].patch, { title: null }, 'an emptied field clears');
  assert.deepEqual(planFindReplace(records, { find: 'zzz' }), []);
});

test('find and replace: regex groups, and refusals by name', () => {
  const records = [rec({ id: 'a', title: 'Song (Remastered 2009)' }), rec({ id: 'b', title: 'Live (feat. X)' })];
  assert.deepEqual(planFindReplace(records, { find: '\\s*\\(Remaster(ed)?[^)]*\\)', regex: true, fields: ['title'] })[0].patch,
    { title: 'Song' });
  assert.deepEqual(planFindReplace(records, { find: '\\(feat\\. (.+)\\)', replace: 'with $1', regex: true, fields: ['title'] })[0].patch,
    { title: 'Live with X' });
  assert.throws(() => planFindReplace(records, { find: '' }), /empty/);
  assert.throws(() => planFindReplace(records, { find: '(', regex: true }), /not a valid regular expression/);
  assert.throws(() => planFindReplace(records, { find: 'a', fields: ['year'] }), /field year/);
});

test('renameOnDisk uses handle.move, refuses without it, and refuses an existing name', async () => {
  const moved = [];
  const handle = { name: 'old.mp3', move: async name => { moved.push(name); } };
  assert.equal(canRenameOnDisk(handle), true);
  const free = { getFileHandle: async () => { throw new Error('NotFoundError'); } };
  assert.equal(await renameOnDisk(handle, 'new.mp3', { parent: free }), 'new.mp3');
  assert.deepEqual(moved, ['new.mp3']);
  await assert.rejects(renameOnDisk({ name: 'a' }, 'b'), error => error.code === 'ERR_NAKLIAMP_RENAME_UNSUPPORTED' && /Chromium/.test(error.message));
  await assert.rejects(renameOnDisk(handle, 'a/b.mp3'), error => error.code === 'ERR_NAKLIAMP_RENAME_INVALID');
  const parent = { getFileHandle: async name => { if (name === 'taken.mp3') return {}; throw new Error('NotFoundError'); } };
  await assert.rejects(renameOnDisk(handle, 'taken.mp3', { parent }), error => error.code === 'ERR_NAKLIAMP_RENAME_EXISTS');
  assert.equal(await renameOnDisk(handle, 'free.mp3', { parent }), 'free.mp3');
  // A case-only rename is allowed even though the parent would "find" it.
  assert.equal(await renameOnDisk({ name: 'a.mp3', move: async () => {} }, 'A.mp3', { parent: { getFileHandle: async () => ({}) } }), 'A.mp3');
});
