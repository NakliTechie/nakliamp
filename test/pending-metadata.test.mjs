// The two metadata defects deferred at the 2026-08-24 autopilot run.
//
// 1. A QuickTime-style `meta` atom: a plain box, with its children straight
//    after the header instead of four bytes of version and flags first.
// 2. WAV `LIST INFO` written after a large `data` chunk, beyond the parser's
//    first 64 KB read window.
//
// Run: node --test test/pending-metadata.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../app/library/metadata.mjs';

const encoder = new TextEncoder();
const latin1 = text => new Uint8Array([...text].map(char => char.charCodeAt(0) & 0xff));

function concat(...chunks) {
  const parts = chunks.map(chunk => (chunk instanceof Uint8Array ? chunk : latin1(chunk)));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const u8 = (...values) => new Uint8Array(values);
const be32 = value => u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const le32 = value => u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
const atom = (type, ...body) => concat(be32(concat(...body).length + 8), latin1(type), ...body);
const dataAtom = (flags, payload) => atom('data', u8(0), u8(0, 0, flags), be32(0), payload);
const COPYRIGHT = String.fromCharCode(0xa9);

// ---------------------------------------------------------------- MP4 ----

const ilst = () => atom('ilst',
  atom(`${COPYRIGHT}nam`, dataAtom(1, encoder.encode('Plain Box'))),
  atom(`${COPYRIGHT}ART`, dataAtom(1, encoder.encode('QuickTime'))),
  atom('trkn', dataAtom(0, u8(0, 0, 0, 3, 0, 9, 0, 0))),
);
// A QuickTime `hdlr` is itself a full box: version and flags, then its fields.
const hdlr = () => atom('hdlr', be32(0), be32(0), latin1('mdir'), latin1('appl'), be32(0), be32(0), u8(0));
const mp4 = meta => concat(atom('ftyp', 'qt  ', be32(0)), atom('moov', atom('udta', meta)));

test('a QuickTime plain-box meta atom (hdlr first, no version and flags) yields its tags', async () => {
  const tags = await readTags(new Blob([mp4(atom('meta', hdlr(), ilst()))]));
  assert.equal(tags.container, 'mp4');
  assert.equal(tags.title, 'Plain Box');
  assert.equal(tags.artist, 'QuickTime');
  assert.equal(tags.trackNo, 3);
  assert.equal(tags.trackTotal, 9);
});

test('a QuickTime plain-box meta atom whose first child is ilst yields its tags', async () => {
  const tags = await readTags(new Blob([mp4(atom('meta', ilst()))]));
  assert.equal(tags.title, 'Plain Box');
});

test('an ISO full-box meta atom still skips its version and flags', async () => {
  const tags = await readTags(new Blob([mp4(atom('meta', u8(0, 0, 0, 0), hdlr(), ilst()))]));
  assert.equal(tags.title, 'Plain Box');
  assert.equal(tags.artist, 'QuickTime');
});

// ---------------------------------------------------------------- WAV ----

/**
 * A Blob-shaped file whose bytes exist only where `segments` place them; every
 * other byte reads as zero. Its `size` can be gigabytes while the test holds a
 * few hundred bytes. Any single read over `maxRead` fails the test, which is
 * how the test proves the parser stepped over the audio rather than reading it.
 */
function sparseBlob(size, segments, maxRead) {
  const reads = [];
  const make = (start, end) => ({
    size: end - start,
    async arrayBuffer() {
      const length = end - start;
      if (length > maxRead) throw new Error(`read of ${length} bytes at ${start}`);
      reads.push([start, length]);
      const out = new Uint8Array(length);
      for (const [at, bytes] of segments) {
        const from = Math.max(start, at);
        const to = Math.min(end, at + bytes.length);
        if (from < to) out.set(bytes.subarray(from - at, to - at), from - start);
      }
      return out.buffer;
    },
  });
  return {
    reads,
    blob: {
      size,
      type: '',
      slice(start = 0, end = size) { return make(start, Math.min(end, size)); },
    },
  };
}

test('WAV LIST INFO after a 1.5 GB data chunk is reached by seeking, not reading', async () => {
  const declared = 0x60000000; // 1.5 GB of audio, declared but never held
  const fmt = concat('fmt ', le32(16), u8(1, 0), u8(2, 0), le32(48000), le32(192000), u8(4, 0), u8(16, 0));
  const dataHeader = concat('data', le32(declared));
  const payload = u8(1, 2, 3, 4, 5, 6, 7, 8); // a short real start of the audio
  const infoBody = concat('INFO', 'INAM', le32(6), 'Behind', 'IART', le32(4), 'Data', 'ICRD', le32(4), '1999');
  const list = concat('LIST', le32(infoBody.length), infoBody);

  const head = concat('RIFF', le32(0), 'WAVE', fmt, dataHeader);
  const listAt = head.length + declared;
  const size = listAt + list.length;
  const { blob, reads } = sparseBlob(size, [[0, head], [head.length, payload], [listAt, list]], 64 * 1024);

  const tags = await readTags(blob);
  assert.equal(tags.container, 'wav');
  assert.equal(tags.sampleRate, 48000);
  assert.equal(tags.channels, 2);
  assert.equal(tags.title, 'Behind');
  assert.equal(tags.artist, 'Data');
  assert.equal(tags.year, 1999);

  const total = reads.reduce((sum, [, length]) => sum + length, 0);
  assert.ok(total < 1024, `the parser read ${total} bytes of a ${size}-byte file`);
  const inAudio = reads.filter(([start, length]) => start < listAt && start + length > head.length);
  assert.deepEqual(inAudio, [], 'no read may touch the audio in the data chunk');
});

test('WAV LIST INFO before data still reads, and a LIST body is capped at 64 KB', async () => {
  const fmt = concat('fmt ', le32(16), u8(1, 0), u8(1, 0), le32(22050), le32(44100), u8(2, 0), u8(16, 0));
  const infoBody = concat('INFO', 'INAM', le32(5), 'Early', u8(0));
  // The LIST declares 1 MB; only its first 64 KB may be read.
  const listHeader = concat('LIST', le32(1024 * 1024));
  const head = concat('RIFF', le32(0), 'WAVE', fmt, listHeader);
  const size = head.length + 1024 * 1024 + 8;
  const { blob } = sparseBlob(size, [[0, head], [head.length, infoBody]], 64 * 1024);

  const tags = await readTags(blob);
  assert.equal(tags.channels, 1);
  assert.equal(tags.sampleRate, 22050);
  assert.equal(tags.title, 'Early');
});
