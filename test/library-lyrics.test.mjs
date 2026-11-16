// Lyrics: LRC parsing, line lookup, and source choice between embedded and sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLrc, readLyrics, lineIndexAt, sidecarNameFor } from '../app/library/lyrics.mjs';

const encoder = new TextEncoder();
const le32 = v => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const be24 = v => new Uint8Array([(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
function concat(...chunks) {
  const parts = chunks.map(c => (c instanceof Uint8Array ? c : encoder.encode(c)));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function flacWithComments(entries) {
  const vendor = encoder.encode('t');
  const encoded = entries.map(e => encoder.encode(e));
  const body = concat(le32(vendor.length), vendor, le32(encoded.length), ...encoded.flatMap(e => [le32(e.length), e]));
  return new Blob([concat('fLaC', new Uint8Array([0x84]), be24(body.length), body)]);
}

test('timestamps in every common shape, sorted', () => {
  const { synced, lines } = parseLrc('[ti:Song]\n[00:12.50]second\n[00:01]first\n[01:02.345]third\n[00:20:10]colon form');
  assert.equal(synced, true);
  assert.deepEqual(lines, [
    { timeS: 1, text: 'first' },
    { timeS: 12.5, text: 'second' },
    { timeS: 20.1, text: 'colon form' },
    { timeS: 62.345, text: 'third' },
  ]);
});

test('several stamps on one line repeat the line', () => {
  const { lines } = parseLrc('[00:10.00][00:50.00]chorus\n[00:30.00]verse');
  assert.deepEqual(lines.map(l => [l.timeS, l.text]), [[10, 'chorus'], [30, 'verse'], [50, 'chorus']]);
});

test('offset in milliseconds: positive shows lines sooner, never before zero', () => {
  const { lines, offsetS } = parseLrc('[offset:+500]\n[00:02.00]a\n[00:00.20]b');
  assert.equal(offsetS, 0.5);
  assert.deepEqual(lines.map(l => l.timeS), [0, 1.5]);
  assert.deepEqual(parseLrc('[offset:-1000]\n[00:01.00]x').lines[0].timeS, 2);
});

test('enhanced word stamps are removed; empty timed lines stay as breaks', () => {
  const { lines } = parseLrc('[00:01.00]<00:01.00>Hello <00:01.50>world\n[00:03.00]');
  assert.deepEqual(lines, [{ timeS: 1, text: 'Hello world' }, { timeS: 3, text: '' }]);
});

test('text with no stamps is plain lyrics', () => {
  const parsed = parseLrc('\nfirst line\n\nsecond stanza\n\n');
  assert.equal(parsed.synced, false);
  assert.deepEqual(parsed.lines, [{ timeS: null, text: 'first line' }, { timeS: null, text: '' }, { timeS: null, text: 'second stanza' }]);
  assert.deepEqual(parseLrc('').lines, []);
  assert.deepEqual(parseLrc(null).lines, []);
});

test('lineIndexAt finds the current line', () => {
  const { lines } = parseLrc('[00:01.00]a\n[00:05.00]b\n[00:09.00]c');
  assert.equal(lineIndexAt(lines, 0.5), -1);
  assert.equal(lineIndexAt(lines, 1), 0);
  assert.equal(lineIndexAt(lines, 7), 1);
  assert.equal(lineIndexAt(lines, 100), 2);
  assert.equal(lineIndexAt([], 3), -1);
});

test('sidecar name keeps the base name', () => {
  assert.equal(sidecarNameFor('01 So What.flac'), '01 So What.lrc');
  assert.equal(sidecarNameFor('noext'), 'noext.lrc');
});

test('readLyrics: embedded only, sidecar only, neither', async () => {
  const embedded = await readLyrics(flacWithComments(['LYRICS=[00:01.00]in the file']));
  assert.deepEqual(embedded, { synced: true, lines: [{ timeS: 1, text: 'in the file' }], source: 'embedded' });
  const sidecar = await readLyrics(flacWithComments(['TITLE=x']), new Blob(['[00:02.00]beside it']));
  assert.equal(sidecar.source, 'lrc');
  assert.equal(sidecar.lines[0].text, 'beside it');
  assert.equal(await readLyrics(flacWithComments(['TITLE=x']), null), null);
  assert.equal(await readLyrics(null, new Blob(['\n\n'])), null);
});

test('readLyrics prefers synced; between equals, the sidecar wins', async () => {
  const plainEmbedded = flacWithComments(['UNSYNCEDLYRICS=plain words']);
  const synced = await readLyrics(plainEmbedded, new Blob(['[00:01.00]timed']));
  assert.equal(synced.source, 'lrc');
  const syncedEmbedded = flacWithComments(['LYRICS=[00:01.00]timed inside']);
  const chosen = await readLyrics(syncedEmbedded, new Blob(['plain sidecar']));
  assert.equal(chosen.source, 'embedded');
  const both = await readLyrics(syncedEmbedded, new Blob(['[00:03.00]timed sidecar']));
  assert.equal(both.source, 'lrc');
});

test('an oversized or unreadable sidecar is ignored, not thrown', async () => {
  const huge = { size: 2 * 1024 * 1024, text: async () => '[00:01.00]x' };
  assert.equal(await readLyrics(null, huge), null);
  const broken = { size: 10, text: async () => { throw new Error('gone'); } };
  assert.equal(await readLyrics(null, broken), null);
});
