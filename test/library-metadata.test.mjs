// v1 metadata additions: ReplayGain from every tag family, Opus R128, ratings,
// synced ID3 lyrics and on-demand lyrics text. Tags are hand-built, so each
// expected value is known by construction.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readTags, readLyricsText, popmStars, ratingFromText, PARSER_VERSION } from '../app/library/metadata.mjs';

const encoder = new TextEncoder();
function concat(...chunks) {
  const parts = chunks.map(chunk => (chunk instanceof Uint8Array ? chunk : encoder.encode(chunk)));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
const u8 = (...values) => new Uint8Array(values);
const be32 = v => u8((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const le32 = v => u8(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const be24 = v => u8((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const syncsafe = v => u8((v >> 21) & 0x7f, (v >> 14) & 0x7f, (v >> 7) & 0x7f, v & 0x7f);
const latin1 = text => new Uint8Array([...text].map(c => c.charCodeAt(0) & 0xff));
const MPEG = u8(0xff, 0xfb, 0x90, 0x00);

function id3(frames, major = 4) {
  const body = concat(...frames.map(([id, payload]) => concat(
    id, major === 4 ? syncsafe(payload.length) : be32(payload.length), u8(0, 0), payload)));
  return concat('ID3', u8(major, 0, 0), syncsafe(body.length), body);
}
const txxx = (description, value) => concat(u8(3), description, u8(0), value);
const utf16 = text => {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff; out[1] = 0xfe;
  [...text].forEach((c, i) => { out[2 + i * 2] = c.charCodeAt(0) & 0xff; out[3 + i * 2] = c.charCodeAt(0) >> 8; });
  return out;
};
const mp3 = frames => new Blob([concat(id3(frames), MPEG)]);

function vorbisComment(entries) {
  const vendor = encoder.encode('test');
  const encoded = entries.map(entry => encoder.encode(entry));
  return concat(le32(vendor.length), vendor, le32(encoded.length), ...encoded.flatMap(e => [le32(e.length), e]));
}
const flacBlock = (type, body, last = false) => concat(u8((last ? 0x80 : 0) | type), be24(body.length), body);
const flac = entries => new Blob([concat('fLaC', flacBlock(4, vorbisComment(entries), true))]);
function oggPage(packet) {
  const segments = [];
  let remaining = packet.length;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining);
  return concat('OggS', u8(0, 0), new Uint8Array(8), be32(1), be32(0), be32(0), u8(segments.length), new Uint8Array(segments), packet);
}
const opus = entries => new Blob([concat(
  oggPage(concat('OpusHead', u8(1, 2), u8(0, 0), le32(48000), u8(0, 0), u8(0))),
  oggPage(concat('OpusTags', vorbisComment(entries))),
)]);

const atom = (type, ...body) => concat(be32(concat(...body).length + 8), latin1(type), ...body);
const dataAtom = (flags, payload) => atom('data', u8(0), be24(flags), be32(0), payload);
const freeform = (mean, name, value) => atom('----',
  atom('mean', be32(0), mean), atom('name', be32(0), name), dataAtom(1, encoder.encode(value)));
const mp4 = (...items) => new Blob([concat(
  atom('ftyp', 'M4A ', be32(0)),
  atom('moov', atom('udta', atom('meta', u8(0, 0, 0, 0), atom('ilst', ...items)))),
)]);

test('the parser version is 2 or later, so old rows are re-read', () => {
  assert.ok(PARSER_VERSION >= 2);
});

// ------------------------------------------------------------ ReplayGain ----

test('ID3 TXXX ReplayGain: gains in dB and linear peaks, any key case', async () => {
  const tags = await readTags(mp3([
    ['TXXX', txxx('REPLAYGAIN_TRACK_GAIN', '-6.50 dB')],
    ['TXXX', txxx('REPLAYGAIN_TRACK_PEAK', '0.988525')],
    ['TXXX', txxx('replaygain_album_gain', '+1.25 dB')],
    ['TXXX', txxx('replaygain_album_peak', '1.002')],
  ]));
  assert.deepEqual(tags.replayGain, { trackGainDb: -6.5, trackPeak: 0.988525, albumGainDb: 1.25, albumPeak: 1.002 });
});

test('ID3 TXXX in UTF-16 decodes its description and value', async () => {
  const body = concat(u8(1), utf16('REPLAYGAIN_TRACK_GAIN'), u8(0, 0), utf16('-3.00 dB'));
  const tags = await readTags(mp3([['TXXX', body]]));
  assert.equal(tags.replayGain.trackGainDb, -3);
});

test('ID3v2.3 TXXX is read as well', async () => {
  const tags = await readTags(new Blob([concat(id3([['TXXX', txxx('REPLAYGAIN_TRACK_GAIN', '-2 dB')]], 3), MPEG)]));
  assert.equal(tags.replayGain.trackGainDb, -2);
});

test('Vorbis ReplayGain comments in FLAC', async () => {
  const tags = await readTags(flac([
    'REPLAYGAIN_TRACK_GAIN=-7.89 dB', 'REPLAYGAIN_TRACK_PEAK=0.5', 'REPLAYGAIN_ALBUM_GAIN=-8.00 dB',
  ]));
  assert.deepEqual(tags.replayGain, { trackGainDb: -7.89, trackPeak: 0.5, albumGainDb: -8, albumPeak: null });
});

test('Opus R128 gains are Q7.8 and move to the -18 LUFS reference (+5 dB)', async () => {
  const tags = await readTags(opus(['TITLE=x', 'R128_TRACK_GAIN=-1280', 'R128_ALBUM_GAIN=256']));
  assert.equal(tags.replayGain.trackGainDb, 0, '-1280/256 = -5 dB, +5 = 0 dB');
  assert.equal(tags.replayGain.albumGainDb, 6, '256/256 = 1 dB, +5 = 6 dB');
  assert.equal(tags.replayGain.trackPeak, null);
  assert.equal(tags.r128, undefined, 'the working field must not leak');
});

test('a REPLAYGAIN_* value wins over an R128 value for the same gain', async () => {
  const tags = await readTags(opus(['R128_TRACK_GAIN=-1280', 'REPLAYGAIN_TRACK_GAIN=-2.00 dB']));
  assert.equal(tags.replayGain.trackGainDb, -2);
});

test('MP4 freeform com.apple.iTunes atoms carry ReplayGain; other namespaces do not', async () => {
  const tags = await readTags(mp4(
    freeform('com.apple.iTunes', 'replaygain_track_gain', '-4.20 dB'),
    freeform('com.apple.iTunes', 'REPLAYGAIN_ALBUM_PEAK', '0.9'),
    freeform('org.example', 'replaygain_album_gain', '-1 dB'),
  ));
  assert.equal(tags.replayGain.trackGainDb, -4.2);
  assert.equal(tags.replayGain.albumPeak, 0.9);
  assert.equal(tags.replayGain.albumGainDb, null);
});

test('junk ReplayGain values are dropped, not stored', async () => {
  const tags = await readTags(flac(['REPLAYGAIN_TRACK_GAIN=loud', 'REPLAYGAIN_ALBUM_GAIN=999 dB', 'R128_TRACK_GAIN=1.5']));
  assert.equal(tags.replayGain, null);
});

test('a file with no ReplayGain reports null', async () => {
  assert.equal((await readTags(flac(['TITLE=x']))).replayGain, null);
});

// --------------------------------------------------------------- ratings ----

test('POPM maps to stars on the Windows Media Player scale', async () => {
  assert.deepEqual([0, 1, 64, 128, 196, 255].map(popmStars), [0, 1, 2, 3, 4, 5]);
  const tags = await readTags(mp3([['POPM', concat('a@b.c', u8(0), u8(196), be32(12))]]));
  assert.equal(tags.rating, 4);
});

test('Vorbis RATING and FMPS_RATING map to 0..5', async () => {
  assert.equal((await readTags(flac(['RATING=80']))).rating, 4);
  assert.equal((await readTags(flac(['FMPS_RATING=0.6']))).rating, 3);
  assert.equal((await readTags(flac(['RATING=3']))).rating, 3);
  assert.equal((await readTags(flac(['RATING=bad']))).rating, null);
  assert.equal(ratingFromText('0.8'), 4);
  assert.equal(ratingFromText('100'), 5);
  assert.equal(ratingFromText('500'), null);
  assert.equal(ratingFromText('2', true), null, 'a fraction above 1 is not a fraction');
});

test('ID3 TXXX FMPS_Rating is read when there is no POPM', async () => {
  const tags = await readTags(mp3([['TXXX', txxx('FMPS_Rating', '1.0')]]));
  assert.equal(tags.rating, 5);
});

// ---------------------------------------------------------------- lyrics ----

const sylt = lines => concat(u8(3), 'eng', u8(2, 1), u8(0),
  ...lines.map(([text, ms]) => concat(text, u8(0), be32(ms))));

test('a millisecond SYLT frame becomes LRC text', async () => {
  const text = await readLyricsText(mp3([['SYLT', sylt([['Hello', 1500], ['World', 62250]])]]));
  assert.equal(text, '[00:01.50]Hello\n[01:02.25]World');
});

test('SYLT wins over USLT whichever comes first', async () => {
  const uslt = concat(u8(3), 'eng', u8(0), 'plain words');
  const tags = await readTags(mp3([['USLT', uslt], ['SYLT', sylt([['Sung', 0]])]]));
  assert.equal(tags.lyrics.synced, true);
  assert.equal(tags.lyrics.text, '[00:00.00]Sung');
});

test('readLyricsText reads USLT, Vorbis LYRICS, UNSYNCEDLYRICS and MP4 lyr', async () => {
  assert.equal(await readLyricsText(mp3([['USLT', concat(u8(3), 'eng', u8(0), 'line one\nline two')]])), 'line one\nline two');
  assert.equal(await readLyricsText(flac(['LYRICS=[00:01.00]a'])), '[00:01.00]a');
  assert.equal(await readLyricsText(flac(['UNSYNCEDLYRICS=words'])), 'words');
  const lyr = `${String.fromCharCode(0xa9)}lyr`;
  assert.equal(await readLyricsText(mp4(atom(lyr, dataAtom(1, encoder.encode('mp4 words'))))), 'mp4 words');
  assert.equal(await readLyricsText(flac(['TITLE=x'])), null);
  assert.equal(await readLyricsText(new Blob([u8(1, 2, 3)])), null);
});

// ----------------------------------------------------------------- safety ----

test('hostile TXXX, POPM and SYLT frames never throw', async () => {
  const cases = [
    [['TXXX', u8(3)]],
    [['TXXX', concat(u8(3), 'REPLAYGAIN_TRACK_GAIN')]], // no terminator, no value
    [['TXXX', concat(u8(1), u8(0xff))]],
    [['POPM', concat('no-terminator')]],
    [['POPM', concat('a', u8(0))]],
    [['SYLT', concat(u8(3), 'eng', u8(2, 1), 'desc')]],
    [['SYLT', concat(u8(9), 'eng', u8(2, 1), u8(0), 'x', u8(0), u8(0, 0))]],
  ];
  for (const frames of cases) {
    const tags = await readTags(mp3(frames));
    assert.equal(typeof tags, 'object');
  }
});

test('a SYLT frame of thousands of empty lines is bounded', async () => {
  const many = Array.from({ length: 8000 }, (_, i) => ['', i]);
  const text = await readLyricsText(mp3([['SYLT', sylt(many)]]));
  assert.ok(text.split('\n').length <= 5000);
});

test('a freeform atom with an oversized part is skipped, not read', async () => {
  const big = atom('----', atom('mean', be32(0), 'com.apple.iTunes'), atom('name', be32(0), 'x'.repeat(5000)),
    dataAtom(1, encoder.encode('-1 dB')));
  const tags = await readTags(mp4(big));
  assert.equal(tags.replayGain, null);
});
