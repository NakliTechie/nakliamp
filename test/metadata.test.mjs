// D2 metadata-parser unit tests.
// The committed audio fixtures are synthetic Reel files and carry no tags, so
// every tag path is exercised against hand-built blocks whose expected values
// are known by construction. The real fixtures verify container sniffing and
// the stream properties they do carry.
//
// Run: node --test test/metadata.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTags, titleFromName } from '../app/library/metadata.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => readFile(resolve(root, 'test/fixtures', name));

const encoder = new TextEncoder();

function concat(...chunks) {
  const parts = chunks.map(chunk => (chunk instanceof Uint8Array ? chunk : encoder.encode(chunk)));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const u8 = (...values) => new Uint8Array(values);
const be32 = value => u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const le32 = value => u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
const be24 = value => u8((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const syncsafe = value => u8((value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f);

// ------------------------------------------------------------- ID3v2 ----

/** Build an ID3v2 tag. `major` 3 uses plain sizes, 4 uses syncsafe sizes. */
function id3(major, frames) {
  const body = concat(...frames.map(([id, payload]) => concat(
    id,
    major === 4 ? syncsafe(payload.length) : be32(payload.length),
    u8(0, 0),
    payload,
  )));
  return concat('ID3', u8(major, 0, 0), syncsafe(body.length), body);
}

const textFrame = (text, encoding = 3) => {
  if (encoding === 0) return concat(u8(0), new Uint8Array([...text].map(c => c.charCodeAt(0) & 0xff)));
  if (encoding === 1) {
    const utf16 = new Uint8Array(text.length * 2);
    text.split('').forEach((char, index) => {
      utf16[index * 2] = char.charCodeAt(0) & 0xff;
      utf16[index * 2 + 1] = char.charCodeAt(0) >> 8;
    });
    return concat(u8(1), u8(0xff, 0xfe), utf16);
  }
  return concat(u8(3), text);
};

// A one-pixel JPEG stand-in: the parser only slices bytes, it never decodes them.
const IMAGE = u8(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9);

test('ID3v2.4: text frames, track pair, year, picture and lyrics', async () => {
  const tag = id3(4, [
    ['TIT2', textFrame('Sakura')],
    ['TPE1', textFrame('Miles Davis')],
    ['TALB', textFrame('Kind of Blue')],
    ['TPE2', textFrame('Various Artists')],
    ['TCON', textFrame('Jazz')],
    ['TRCK', textFrame('3/12')],
    ['TPOS', textFrame('1/2')],
    ['TDRC', textFrame('1959-08-17')],
    ['APIC', concat(u8(3), 'image/jpeg', u8(0), u8(3), 'cover', u8(0), IMAGE)],
    ['USLT', concat(u8(3), 'eng', u8(0), '[00:12.00]a line')],
  ]);
  // An MPEG frame sync after the tag, so the container sniffs as MP3.
  const tags = await readTags(new Blob([concat(tag, u8(0xff, 0xfb, 0x90, 0x00))]));

  assert.equal(tags.container, 'mp3');
  assert.equal(tags.title, 'Sakura');
  assert.equal(tags.artist, 'Miles Davis');
  assert.equal(tags.album, 'Kind of Blue');
  assert.equal(tags.albumArtist, 'Various Artists');
  assert.equal(tags.genre, 'Jazz');
  assert.equal(tags.trackNo, 3);
  assert.equal(tags.trackTotal, 12);
  assert.equal(tags.discNo, 1);
  assert.equal(tags.discTotal, 2);
  assert.equal(tags.year, 1959);
  assert.equal(tags.picture.mime, 'image/jpeg');
  assert.deepEqual([...tags.picture.bytes], [...IMAGE]);
  assert.equal(tags.lyrics.synced, false);
  assert.equal(tags.lyrics.text, '[00:12.00]a line');
});

test('ID3v2.3: plain frame sizes and TYER', async () => {
  const tag = id3(3, [['TIT2', textFrame('Older Tag')], ['TYER', textFrame('1994')]]);
  const tags = await readTags(new Blob([concat(tag, u8(0xff, 0xfb, 0x90, 0x00))]));
  assert.equal(tags.title, 'Older Tag');
  assert.equal(tags.year, 1994);
});

test('ID3v2: latin-1 and UTF-16 text encodings decode', async () => {
  const latin = id3(4, [['TIT2', textFrame('Cafe', 0)]]);
  const utf16 = id3(4, [['TIT2', textFrame('Sakura', 1)]]);
  assert.equal((await readTags(new Blob([concat(latin, u8(0xff, 0xfb))]))).title, 'Cafe');
  assert.equal((await readTags(new Blob([concat(utf16, u8(0xff, 0xfb))]))).title, 'Sakura');
});

test('SYLT is reported as synced lyrics', async () => {
  const tag = id3(4, [['SYLT', concat(u8(3), 'eng', u8(0), 'desc', u8(0), '[00:01.00]line')]]);
  const tags = await readTags(new Blob([concat(tag, u8(0xff, 0xfb))]));
  assert.equal(tags.lyrics.synced, true);
});

// -------------------------------------------------------- Vorbis/FLAC ----

function vorbisComment(entries) {
  const vendor = encoder.encode('NakliAmp test');
  const encoded = entries.map(entry => encoder.encode(entry));
  return concat(
    le32(vendor.length), vendor,
    le32(encoded.length),
    ...encoded.flatMap(entry => [le32(entry.length), entry]),
  );
}

function flacPictureBlock(image) {
  const mime = encoder.encode('image/png');
  const description = encoder.encode('front');
  return concat(
    be32(3), be32(mime.length), mime, be32(description.length), description,
    be32(64), be32(64), be32(24), be32(0),
    be32(image.length), image,
  );
}

function flacBlock(type, body, last = false) {
  return concat(u8((last ? 0x80 : 0) | type), be24(body.length), body);
}

test('FLAC: STREAMINFO, Vorbis comments and an embedded picture', async () => {
  // STREAMINFO packs a 20-bit sample rate, a 3-bit channel count, then 36 bits
  // of total samples. 44100 Hz, 2 channels, 88200 samples = two seconds.
  const streamInfo = new Uint8Array(34);
  streamInfo[10] = (44100 >> 12) & 0xff;
  streamInfo[11] = (44100 >> 4) & 0xff;
  streamInfo[12] = ((44100 & 0x0f) << 4) | (1 << 1); // channels - 1 = 1
  streamInfo[13] = 0;
  streamInfo.set(be32(88200), 14);

  const file = concat(
    'fLaC',
    flacBlock(0, streamInfo),
    flacBlock(4, vorbisComment([
      'TITLE=Blue in Green', 'ARTIST=Bill Evans', 'ALBUM=Kind of Blue',
      'ALBUMARTIST=Miles Davis', 'TRACKNUMBER=3', 'TRACKTOTAL=5',
      'DISCNUMBER=1', 'DATE=1959', 'GENRE=Jazz', 'LYRICS=[00:03.00]synced',
    ])),
    flacBlock(6, flacPictureBlock(IMAGE), true),
  );
  const tags = await readTags(new Blob([file]));

  assert.equal(tags.container, 'flac');
  assert.equal(tags.sampleRate, 44100);
  assert.equal(tags.channels, 2);
  assert.equal(tags.durationS, 2);
  assert.equal(tags.title, 'Blue in Green');
  assert.equal(tags.artist, 'Bill Evans');
  assert.equal(tags.albumArtist, 'Miles Davis');
  assert.equal(tags.trackNo, 3);
  assert.equal(tags.trackTotal, 5);
  assert.equal(tags.year, 1959);
  assert.equal(tags.picture.mime, 'image/png');
  assert.deepEqual([...tags.picture.bytes], [...IMAGE]);
  assert.equal(tags.lyrics.synced, true);
});

// ---------------------------------------------------------------- Ogg ----

/** Wrap one packet in a single Ogg page, splitting it into 255-byte segments. */
function oggPage(packet) {
  const segments = [];
  let remaining = packet.length;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining);
  return concat(
    'OggS', u8(0, 0),
    new Uint8Array(8), be32(1), be32(0), be32(0),
    u8(segments.length), new Uint8Array(segments),
    packet,
  );
}

test('Ogg Opus: OpusHead stream properties and OpusTags comments', async () => {
  const head = concat('OpusHead', u8(1, 2), u8(0, 0), le32(48000), u8(0, 0), u8(0));
  const tagsPacket = concat('OpusTags', vorbisComment(['TITLE=Opus Track', 'ARTIST=Someone']));
  const tags = await readTags(new Blob([concat(oggPage(head), oggPage(tagsPacket))]));

  assert.equal(tags.container, 'ogg');
  assert.equal(tags.channels, 2);
  assert.equal(tags.sampleRate, 48000);
  assert.equal(tags.title, 'Opus Track');
  assert.equal(tags.artist, 'Someone');
});

test('Ogg Vorbis: identification header and comment packet', async () => {
  const identification = concat(u8(1), 'vorbis', le32(0), u8(2), le32(44100), new Uint8Array(16));
  const comment = concat(u8(3), 'vorbis', vorbisComment(['TITLE=Vorbis Track', 'ALBUM=Ogg Album']));
  const tags = await readTags(new Blob([concat(oggPage(identification), oggPage(comment))]));

  assert.equal(tags.channels, 2);
  assert.equal(tags.sampleRate, 44100);
  assert.equal(tags.title, 'Vorbis Track');
  assert.equal(tags.album, 'Ogg Album');
});

test('Ogg: a base64 METADATA_BLOCK_PICTURE comment becomes a picture', async () => {
  const block = flacPictureBlock(IMAGE);
  const base64 = Buffer.from(block).toString('base64');
  const packet = concat('OpusTags', vorbisComment([`METADATA_BLOCK_PICTURE=${base64}`]));
  const tags = await readTags(new Blob([oggPage(packet)]));

  assert.equal(tags.picture.mime, 'image/png');
  assert.deepEqual([...tags.picture.bytes], [...IMAGE]);
  assert.equal(tags.pictureBase64, undefined, 'the base64 carrier must not leak into the record');
});

// ---------------------------------------------------------------- MP4 ----

// An atom name is four raw bytes, so it must be written byte-per-char. UTF-8
// would render the `©` prefix as two bytes and silently widen the name to five.
const latin1 = text => new Uint8Array([...text].map(char => char.charCodeAt(0) & 0xff));
const atom = (type, ...body) => concat(be32(concat(...body).length + 8), latin1(type), ...body);
const dataAtom = (flags, payload) => atom('data', u8(0), be24(flags), be32(0), payload);
const COPYRIGHT = String.fromCharCode(0xa9);

test('MP4: ilst text atoms, trkn pair, year and cover art', async () => {
  const ilst = atom('ilst',
    atom(`${COPYRIGHT}nam`, dataAtom(1, encoder.encode('So What'))),
    atom(`${COPYRIGHT}ART`, dataAtom(1, encoder.encode('Miles Davis'))),
    atom(`${COPYRIGHT}alb`, dataAtom(1, encoder.encode('Kind of Blue'))),
    atom('aART', dataAtom(1, encoder.encode('Miles Davis'))),
    atom(`${COPYRIGHT}gen`, dataAtom(1, encoder.encode('Jazz'))),
    atom(`${COPYRIGHT}day`, dataAtom(1, encoder.encode('1959'))),
    atom('trkn', dataAtom(0, u8(0, 0, 0, 1, 0, 5, 0, 0))),
    atom('disk', dataAtom(0, u8(0, 0, 0, 2, 0, 2, 0, 0))),
    atom('covr', dataAtom(13, IMAGE)),
  );
  // `meta` is a full box, so its version and flags precede its children.
  const meta = atom('meta', u8(0, 0, 0, 0), ilst);
  const mvhd = atom('mvhd', u8(0), be24(0), be32(0), be32(0), be32(600), be32(1800));
  const file = concat(atom('ftyp', 'M4A ', be32(0)), atom('moov', mvhd, atom('udta', meta)));
  const tags = await readTags(new Blob([file]));

  assert.equal(tags.container, 'mp4');
  assert.equal(tags.title, 'So What');
  assert.equal(tags.artist, 'Miles Davis');
  assert.equal(tags.album, 'Kind of Blue');
  assert.equal(tags.albumArtist, 'Miles Davis');
  assert.equal(tags.genre, 'Jazz');
  assert.equal(tags.year, 1959);
  assert.equal(tags.trackNo, 1);
  assert.equal(tags.trackTotal, 5);
  assert.equal(tags.discNo, 2);
  assert.equal(tags.durationS, 3);
  assert.equal(tags.picture.mime, 'image/jpeg');
  assert.deepEqual([...tags.picture.bytes], [...IMAGE]);
});

test('MP4: a covr atom flagged 14 is reported as PNG', async () => {
  const ilst = atom('ilst', atom('covr', dataAtom(14, IMAGE)));
  const file = concat(atom('ftyp', 'M4A ', be32(0)), atom('moov', atom('udta', atom('meta', u8(0, 0, 0, 0), ilst))));
  assert.equal((await readTags(new Blob([file]))).picture.mime, 'image/png');
});

// ---------------------------------------------------------------- WAV ----

test('WAV: fmt stream properties and LIST INFO tags', async () => {
  const fmt = concat('fmt ', le32(16), u8(1, 0), u8(2, 0), le32(44100), le32(176400), u8(4, 0), u8(16, 0));
  const infoBody = concat('INFO',
    'INAM', le32(6), 'Wavvvv',
    'IART', le32(6), 'Artist',
    'ICRD', le32(4), '2001',
  );
  const list = concat('LIST', le32(infoBody.length), infoBody);
  const file = concat('RIFF', le32(0), 'WAVE', fmt, list, 'data', le32(0));
  const tags = await readTags(new Blob([file]));

  assert.equal(tags.container, 'wav');
  assert.equal(tags.channels, 2);
  assert.equal(tags.sampleRate, 44100);
  assert.equal(tags.title, 'Wavvvv');
  assert.equal(tags.artist, 'Artist');
  assert.equal(tags.year, 2001);
});

// ----------------------------------------------------- real fixtures ----

test('committed fixtures sniff to the right container', async () => {
  const expected = new Map([
    ['audio-mp3.mp3', 'mp3'],
    ['audio-flac.flac', 'flac'],
    ['audio-aac.m4a', 'mp4'],
    ['audio-opus.ogg', 'ogg'],
    ['audio-vorbis.ogg', 'ogg'],
    ['audio-wav.wav', 'wav'],
    ['audio-opus.mka', 'matroska'],
    ['audio-wma.wma', null],
  ]);
  for (const [name, container] of expected) {
    const tags = await readTags(new Blob([await fixture(name)]));
    assert.equal(tags.container, container, `${name} sniffed as ${tags.container}`);
  }
});

test('committed fixtures yield the stream properties their containers carry', async () => {
  const flac = await readTags(new Blob([await fixture('audio-flac.flac')]));
  assert.equal(flac.sampleRate, 48000);
  assert.equal(flac.channels, 1);
  assert.equal(flac.durationS, 1);

  const wav = await readTags(new Blob([await fixture('audio-wav.wav')]));
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.channels, 1);

  const opus = await readTags(new Blob([await fixture('audio-opus.ogg')]));
  assert.equal(opus.sampleRate, 48000);
  assert.equal(opus.channels, 1);
});

// ------------------------------------------------------------ safety ----

test('malformed input yields nulls instead of throwing', async () => {
  const cases = [
    new Uint8Array(0),
    u8(1, 2, 3),
    concat('ID3', u8(4, 0, 0), syncsafe(9999)), // a size that runs past the end
    concat('fLaC', u8(4), be24(9999)), // a comment block that runs past the end
    concat('OggS', u8(0, 0), new Uint8Array(8), be32(1), be32(0), be32(0), u8(200)),
    concat(be32(8), 'ftyp'), // a truncated MP4
    concat('RIFF', le32(0), 'WAVE', 'fmt ', le32(9999)),
  ];
  for (const [index, bad] of cases.entries()) {
    const tags = await readTags(new Blob([bad]));
    assert.equal(tags.title, null, `case ${index} produced a title`);
    assert.equal(typeof tags, 'object');
  }
});

test('a picture whose declared length exceeds the block is rejected', async () => {
  const mime = encoder.encode('image/png');
  const truncated = concat(be32(3), be32(mime.length), mime, be32(0), be32(1), be32(1), be32(24), be32(0), be32(9999), IMAGE);
  const file = concat('fLaC', flacBlock(6, truncated, true));
  assert.equal((await readTags(new Blob([file]))).picture, null);
});

test('titleFromName strips the extension and survives empty input', () => {
  assert.equal(titleFromName('audio-mp3.mp3'), 'audio-mp3');
  assert.equal(titleFromName('No Extension'), 'No Extension');
  assert.equal(titleFromName(''), 'Untitled track');
  assert.equal(titleFromName(null), 'Untitled track');
});
